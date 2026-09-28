import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingClient } from "./api.ts";
import { embeddingFingerprint, type Settings } from "./config.ts";
import type { MemoryRow, RealmemDB, SearchHit } from "./db.ts";
import {
	atomicWrite,
	listStoreFiles,
	MemoryParseError,
	memoryFileName,
	type MemoryFile,
	type ParsedMemory,
	readMemoryFile,
	type ScopeKind,
	serializeMemory,
	type StoreRef,
} from "./files.ts";
import { describeSafety, scanAll } from "./safety.ts";
import { ftsQuery, indexTokens, memoryText, textHash } from "./text.ts";

export interface SyncReport {
	scanned: number;
	added: number;
	updated: number;
	removed: number;
	flagged: number;
	errors: Array<{ file: string; error: string }>;
}

export interface EmbedReport {
	embedded: number;
	tokens: number;
	error?: string;
}

export interface RankedHit {
	memory: MemoryRow;
	/** Reciprocal-rank-fusion score. */
	score: number;
	vecScore?: number;
	ftsScore?: number;
	vecRank?: number;
	ftsRank?: number;
}

const RRF_K = 60;

/** Fuse ranked lists with reciprocal rank fusion. */
export function rrfFuse(lists: Array<{ hits: SearchHit[]; weight?: number; kind: "vec" | "fts" }>): Map<number, Omit<RankedHit, "memory">> {
	const out = new Map<number, Omit<RankedHit, "memory">>();
	for (const list of lists) {
		const w = list.weight ?? 1;
		list.hits.forEach((h, i) => {
			const cur = out.get(h.rid) ?? { score: 0 };
			cur.score += w / (RRF_K + i + 1);
			if (list.kind === "vec") {
				if (cur.vecRank === undefined || i < cur.vecRank) {
					cur.vecRank = i;
					cur.vecScore = h.score;
				}
			} else if (cur.ftsRank === undefined || i < cur.ftsRank) {
				cur.ftsRank = i;
				cur.ftsScore = h.score;
			}
			out.set(h.rid, cur);
		});
	}
	return out;
}

/**
 * The memory index: keeps SQLite in sync with the markdown stores and runs
 * hybrid (vector + BM25) retrieval over them.
 */
export class MemoryIndex {
	readonly db: RealmemDB;
	private settings: Settings;
	private embedder: EmbeddingClient;

	constructor(db: RealmemDB, settings: Settings, embedder: EmbeddingClient) {
		this.db = db;
		this.settings = settings;
		this.embedder = embedder;
	}

	setClients(settings: Settings, embedder: EmbeddingClient): void {
		this.settings = settings;
		this.embedder = embedder;
	}

	get fingerprint(): string {
		return embeddingFingerprint(this.settings);
	}

	/** Clear cached vectors if the embedding space changed. Returns true if cleared. */
	checkFingerprint(): boolean {
		return this.db.ensureFingerprint(this.fingerprint);
	}

	// -------------------------------------------------------------------------
	// file -> index sync
	// -------------------------------------------------------------------------

	/**
	 * Reconcile the index with the markdown files of `stores`. Unchanged files
	 * (same mtime and size) are skipped; changed or new files are parsed, safety-
	 * scanned and re-tokenized; vanished files are dropped from the index.
	 */
	sync(stores: StoreRef[]): SyncReport {
		const report: SyncReport = { scanned: 0, added: 0, updated: 0, removed: 0, flagged: 0, errors: [] };
		// Per-file (mtime, size) comparison: unchanged files are not re-read.
		for (const store of stores) this.syncStore(store, report);
		return report;
	}

	private syncStore(store: StoreRef, report: SyncReport): void {
		const files = listStoreFiles(store.dir);
		const indexed = new Map(this.db.fileStates(store.id).map((s) => [s.file, s]));
		const changed: Array<{ entry: (typeof files)[number]; parsed?: ParsedMemory; error?: string }> = [];
		for (const entry of files) {
			report.scanned++;
			const cur = indexed.get(entry.file);
			indexed.delete(entry.file);
			if (cur && Math.abs(cur.mtime - entry.mtimeMs) < 1 && cur.size === entry.size) continue;
			try {
				changed.push({ entry, parsed: readMemoryFile(entry.file, store.kind) });
			} catch (err) {
				changed.push({ entry, error: err instanceof MemoryParseError || err instanceof Error ? err.message : String(err) });
			}
		}
		const removed = [...indexed.values()];
		if (changed.length === 0 && removed.length === 0) return;
		this.db.tx(() => {
			for (const r of removed) {
				this.db.deleteRidLocked(r.rid);
				report.removed++;
			}
			for (const c of changed) {
				if (!c.parsed) {
					report.errors.push({ file: c.entry.file, error: c.error ?? "unreadable" });
					const stale = this.db.fileStates(store.id).find((s) => s.file === c.entry.file);
					if (stale) this.db.deleteRidLocked(stale.rid);
					continue;
				}
				const p = c.parsed;
				const safety = scanAll(memoryText(p.caption, p.content));
				let flags: string | undefined;
				if ((safety.secrets.length || safety.injections.length) && !this.db.isApproved(p.hash)) {
					flags = describeSafety(safety);
					report.flagged++;
				}
				const existed = this.db.fileStates(store.id).some((s) => s.file === p.file);
				try {
					const rid = this.db.upsertMemoryLocked({
						id: p.id,
						store: store.id,
						kind: store.kind,
						file: p.file,
						caption: p.caption,
						content: p.content,
						paths: p.paths,
						hash: p.hash,
						created: p.created,
						updated: p.updated,
						mtime: c.entry.mtimeMs,
						size: c.entry.size,
						flags,
					});
					this.db.setFtsLocked(rid, indexTokens(p.caption), indexTokens(p.content));
					if (existed) report.updated++;
					else report.added++;
				} catch (err) {
					report.errors.push({ file: p.file, error: err instanceof Error ? err.message : String(err) });
				}
			}
		});
	}

	/** Index one file right after writing it (without a full directory scan). */
	indexFile(store: StoreRef, file: string): MemoryRow | undefined {
		const p = readMemoryFile(file, store.kind);
		const st = statSync(file);
		this.db.tx(() => {
			const rid = this.db.upsertMemoryLocked({
				id: p.id,
				store: store.id,
				kind: store.kind,
				file,
				caption: p.caption,
				content: p.content,
				paths: p.paths,
				hash: p.hash,
				created: p.created,
				updated: p.updated,
				mtime: st.mtimeMs,
				size: st.size,
				flags: undefined,
			});
			this.db.setFtsLocked(rid, indexTokens(p.caption), indexTokens(p.content));
		});
		return this.db.getById(p.id, [store.id]);
	}

	// -------------------------------------------------------------------------
	// embeddings
	// -------------------------------------------------------------------------

	/** Embed every indexed memory that lacks a cached vector, then refresh the vector index. */
	async embedMissing(signal?: AbortSignal): Promise<EmbedReport> {
		this.checkFingerprint();
		const fp = this.fingerprint;
		const missing = this.db.missingEmbeddingHashes(fp);
		let embedded = 0;
		let tokens = 0;
		let error: string | undefined;
		if (missing.length > 0 && this.embedder.configured) {
			try {
				const chunk = Math.max(1, this.settings.embedding.batchSize) * 4;
				for (let i = 0; i < missing.length; i += chunk) {
					const part = missing.slice(i, i + chunk);
					const res = await this.embedder.embed(
						part.map((m) => memoryText(m.caption, m.content)),
						"document",
						signal,
					);
					tokens += res.tokens;
					this.db.tx(() => {
						part.forEach((m, j) => this.db.putEmbedding(m.hash, fp, res.vectors[j]));
					});
					embedded += part.length;
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		}
		this.db.syncVectors(fp);
		return { embedded, tokens, error };
	}

	/** Embedding of a memory text (document side), using and filling the cache. */
	async documentVector(caption: string, content: string, signal?: AbortSignal): Promise<{ vec: Float32Array; cached: boolean; tokens: number }> {
		this.checkFingerprint();
		const hash = textHash(caption, content);
		const cached = this.db.getCachedEmbedding(hash, this.fingerprint);
		if (cached) return { vec: cached, cached: true, tokens: 0 };
		const res = await this.embedder.embed([memoryText(caption, content)], "document", signal);
		this.db.putEmbedding(hash, this.fingerprint, res.vectors[0]);
		return { vec: res.vectors[0], cached: false, tokens: res.tokens };
	}

	// -------------------------------------------------------------------------
	// retrieval
	// -------------------------------------------------------------------------

	/**
	 * Hybrid search: one KNN per query vector plus one BM25 query over all texts,
	 * fused with reciprocal rank fusion. Returns the fused, deduplicated list.
	 */
	hybrid(
		stores: StoreRef[],
		opts: { vectors: Float32Array[]; texts: string[]; limit: number; minSimilarity?: number; excludeRids?: Set<number> },
	): RankedHit[] {
		const storeIds = stores.map((s) => s.id);
		const lists: Array<{ hits: SearchHit[]; kind: "vec" | "fts"; weight?: number }> = [];
		const depth = Math.max(opts.limit * 3, 20);
		for (const v of opts.vectors) {
			const hits = this.db.vecSearch(storeIds, v, depth).filter((h) => opts.minSimilarity === undefined || h.score >= opts.minSimilarity);
			lists.push({ hits, kind: "vec" });
		}
		const match = ftsQuery(opts.texts);
		if (match) lists.push({ hits: this.db.ftsSearch(storeIds, match, depth), kind: "fts", weight: 1 });
		const fused = rrfFuse(lists);
		const rows = this.db.getByRids([...fused.keys()]);
		const out: RankedHit[] = [];
		for (const [rid, f] of fused) {
			const memory = rows.get(rid);
			if (!memory || memory.flags) continue;
			if (opts.excludeRids?.has(rid)) continue;
			out.push({ memory, ...f });
		}
		out.sort((a, b) => b.score - a.score);
		return out.slice(0, opts.limit);
	}

	// -------------------------------------------------------------------------
	// writes
	// -------------------------------------------------------------------------

	/** Write a memory file into a store and index it. */
	writeMemory(store: StoreRef, mem: MemoryFile, existingFile?: string): MemoryRow {
		mkdirSync(store.dir, { recursive: true, mode: store.kind === "shared" ? 0o755 : 0o700 });
		if (store.kind === "shared") ensureSharedReadme(store.dir);
		const file = existingFile ?? join(store.dir, memoryFileName(mem.id));
		atomicWrite(file, serializeMemory(mem, store.kind), store.kind === "shared" ? 0o644 : 0o600);
		const row = this.indexFile(store, file);
		if (!row) throw new Error(`failed to index ${file}`);
		return row;
	}

	deleteMemory(row: MemoryRow): void {
		try {
			unlinkSync(row.file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		this.db.tx(() => this.db.deleteRidLocked(row.rid));
	}
}

const SHARED_README = `# realmem project-shared memory

Each \`*.md\` file here is one fact remembered by the realmem Pi extension,
with YAML frontmatter (\`id\`, \`caption\`, \`paths\`, ...) and a Markdown body.
These files replace AGENTS.md / CLAUDE.md for this project: commit them so
every collaborator's agent can recall them. Keep them free of secrets and of
machine-specific details (those belong in project-personal memory).
`;

function ensureSharedReadme(dir: string): void {
	const f = join(dir, "README.md");
	if (!existsSync(f)) {
		try {
			writeFileSync(f, SHARED_README, { flag: "wx" });
		} catch {
			// raced with another process: fine
		}
	}
}

export function kindOfStore(stores: StoreRef[], id: string): ScopeKind | undefined {
	return stores.find((s) => s.id === id)?.kind;
}
