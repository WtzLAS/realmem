import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ScopeKind } from "./files.ts";

const SCHEMA_VERSION = 3;

export interface MemoryRow {
	rid: number;
	id: string;
	store: string;
	kind: ScopeKind;
	file: string;
	caption: string;
	content: string;
	paths: string[] | undefined;
	hash: string;
	created: string | null;
	updated: string | null;
	mtime: number;
	size: number;
	vecHash: string | null;
	/** Non-empty when the memory is quarantined by the safety scanner. */
	flags: string | null;
	/** Explicit uses: reinforcements + recall hits. Sort key. */
	usedCount: number;
	/** Times shown automatically because the agent touched the memory's paths (not a sort key). */
	injectCount: number;
	lastUsed: number | null;
}

export interface UrgencyRow {
	score: number;
	source: string;
	basis: string;
	/** Probability per urgency level ("0" Low .. "2" High), when the judge returned them. */
	probabilities?: Record<string, number>;
	confidence?: number;
	updated: number;
}

export interface PathStateRow {
	missing: string[];
	suggestion: string | null;
}

export interface UpsertMemory {
	id: string;
	store: string;
	kind: ScopeKind;
	file: string;
	caption: string;
	content: string;
	paths: string[] | undefined;
	hash: string;
	created: string | undefined;
	updated: string | undefined;
	mtime: number;
	size: number;
	flags: string | undefined;
}

export interface IndexedFileState {
	rid: number;
	file: string;
	mtime: number;
	size: number;
	hash: string;
	id: string;
}

export interface SearchHit {
	rid: number;
	score: number;
}

type Row = Record<string, SQLInputValue>;

export type ListOrder = "used" | "recent" | "caption" | "path";

const SELECT_MEM_SQL =
	"SELECT m.*, COALESCE(u.used_count, 0) AS used_count, COALESCE(u.path_inject_count, 0) AS path_inject_count, u.last_used AS last_used FROM memories m LEFT JOIN usage u ON u.id = m.id";
const LIST_WHERE = "WHERE m.store IN (SELECT value FROM json_each(?)) AND (? = 1 OR m.flags IS NULL)";
const LIST_SQL: Record<ListOrder, string> = {
	used: `${SELECT_MEM_SQL} ${LIST_WHERE} ORDER BY used_count DESC, m.rid DESC LIMIT ? OFFSET ?`,
	recent: `${SELECT_MEM_SQL} ${LIST_WHERE} ORDER BY COALESCE(m.updated, m.created) DESC, m.rid DESC LIMIT ? OFFSET ?`,
	caption: `${SELECT_MEM_SQL} ${LIST_WHERE} ORDER BY m.caption COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
	// Project-wide memories first, then grouped by path scope; most used first inside a group.
	path: `${SELECT_MEM_SQL} ${LIST_WHERE} ORDER BY CASE WHEN m.paths IS NULL OR m.paths IN ('["."]', '["~"]') THEN '' ELSE m.paths END ASC, used_count DESC, m.rid DESC LIMIT ? OFFSET ?`,
};
const BUMP_REINFORCE_SQL = `INSERT INTO usage(id, used_count, reinforce_count, last_used) VALUES (?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET used_count = used_count + excluded.used_count, reinforce_count = reinforce_count + excluded.reinforce_count, last_used = excluded.last_used`;
const BUMP_INJECT_SQL = `INSERT INTO usage(id, path_inject_count, last_used) VALUES (?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET path_inject_count = path_inject_count + excluded.path_inject_count`;
const BUMP_RECALL_SQL = `INSERT INTO usage(id, used_count, recall_count, last_used) VALUES (?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET used_count = used_count + excluded.used_count, recall_count = recall_count + excluded.recall_count, last_used = excluded.last_used`;

function parsePaths(value: SQLInputValue | undefined): string[] | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : undefined;
	} catch {
		return undefined;
	}
}

function toF32Bytes(v: Float32Array): Uint8Array {
	return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBytes(b: Uint8Array): Float32Array {
	const copy = new Uint8Array(b.byteLength);
	copy.set(b);
	return new Float32Array(copy.buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class LockTimeoutError extends Error {}

export class RealmemDB {
	readonly db: DatabaseSync;
	readonly vecAvailable: boolean;
	readonly vecError: string | undefined;
	private stmtCache = new Map<string, StatementSync>();
	private localLocks = new Map<string, Promise<void>>();

	readonly path: string;

	constructor(path: string) {
		this.path = path;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path, { allowExtension: true, timeout: 15_000 });
		let vecOk = false;
		let vecErr: string | undefined;
		try {
			const require = createRequire(import.meta.url);
			const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
			this.db.loadExtension(sqliteVec.getLoadablePath());
			vecOk = true;
		} catch (err) {
			vecErr = err instanceof Error ? err.message : String(err);
		}
		try {
			this.db.enableLoadExtension(false);
		} catch {
			// older node: ignore
		}
		this.vecAvailable = vecOk;
		this.vecError = vecErr;
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA busy_timeout = 15000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.stmtCache.clear();
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}

	private stmt(sql: string): StatementSync {
		let s = this.stmtCache.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmtCache.set(sql, s);
		}
		return s;
	}

	/** Run `fn` in an IMMEDIATE transaction (serializes writers across processes). */
	tx<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore
			}
			throw err;
		}
	}

	private migrate(): void {
		const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version >= SCHEMA_VERSION) return;
		this.tx(() => {
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS memories (
					rid INTEGER PRIMARY KEY,
					id TEXT NOT NULL,
					store TEXT NOT NULL,
					kind TEXT NOT NULL,
					file TEXT NOT NULL UNIQUE,
					caption TEXT NOT NULL,
					content TEXT NOT NULL,
					paths TEXT,
					hash TEXT NOT NULL,
					created TEXT,
					updated TEXT,
					mtime REAL NOT NULL DEFAULT 0,
					size INTEGER NOT NULL DEFAULT 0,
					vec_hash TEXT,
					flags TEXT,
					UNIQUE(store, id)
				);
				CREATE INDEX IF NOT EXISTS memories_store ON memories(store);
				CREATE INDEX IF NOT EXISTS memories_hash ON memories(hash);
				CREATE INDEX IF NOT EXISTS memories_id ON memories(id);
				CREATE TABLE IF NOT EXISTS usage (
					id TEXT PRIMARY KEY,
					used_count INTEGER NOT NULL DEFAULT 0,
					reinforce_count INTEGER NOT NULL DEFAULT 0,
					recall_count INTEGER NOT NULL DEFAULT 0,
					last_used INTEGER
				);
				CREATE TABLE IF NOT EXISTS embeddings (
					hash TEXT PRIMARY KEY,
					fingerprint TEXT NOT NULL,
					dim INTEGER NOT NULL,
					vec BLOB NOT NULL,
					created INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS approvals (hash TEXT PRIMARY KEY, approved_at INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS locks (
					name TEXT PRIMARY KEY,
					owner TEXT NOT NULL,
					pid INTEGER NOT NULL,
					host TEXT NOT NULL,
					acquired INTEGER NOT NULL,
					expires INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS pending (
					seq INTEGER PRIMARY KEY,
					project_root TEXT,
					payload TEXT NOT NULL,
					created INTEGER NOT NULL,
					attempts INTEGER NOT NULL DEFAULT 0,
					last_error TEXT
				);
				CREATE TABLE IF NOT EXISTS imported_context (hash TEXT PRIMARY KEY, path TEXT NOT NULL, imported_at INTEGER NOT NULL);
				CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(caption, content, tokenize = 'unicode61 remove_diacritics 2');
			`);
			if (version < 2) {
				const cols = (this.db.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name);
				if (!cols.includes("path_inject_count")) this.db.exec("ALTER TABLE usage ADD COLUMN path_inject_count INTEGER NOT NULL DEFAULT 0");
				this.db.exec(`
					CREATE TABLE IF NOT EXISTS urgency (
						store TEXT NOT NULL,
						id TEXT NOT NULL,
						score REAL NOT NULL,
						source TEXT NOT NULL,
						basis TEXT NOT NULL,
						updated INTEGER NOT NULL,
						PRIMARY KEY(store, id)
					);
					CREATE TABLE IF NOT EXISTS path_state (
						store TEXT NOT NULL,
						id TEXT NOT NULL,
						basis TEXT NOT NULL,
						missing TEXT NOT NULL,
						suggestion TEXT,
						checked INTEGER NOT NULL,
						PRIMARY KEY(store, id)
					);
				`);
			}
			if (version < 3) {
				const cols = (this.db.prepare("PRAGMA table_info(urgency)").all() as Array<{ name: string }>).map((c) => c.name);
				if (!cols.includes("probs")) this.db.exec("ALTER TABLE urgency ADD COLUMN probs TEXT");
				if (!cols.includes("confidence")) this.db.exec("ALTER TABLE urgency ADD COLUMN confidence REAL");
			}
			this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		});
	}

	// -------------------------------------------------------------------------
	// meta
	// -------------------------------------------------------------------------

	getMeta(key: string): string | undefined {
		const r = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return r?.value;
	}

	setMeta(key: string, value: string): void {
		this.stmt("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	// -------------------------------------------------------------------------
	// embedding space
	// -------------------------------------------------------------------------

	/**
	 * Make sure the cache belongs to `fingerprint`. A different fingerprint (new
	 * endpoint, model or dimensions) clears every cached vector.
	 * Returns true when the cache was cleared.
	 */
	ensureFingerprint(fingerprint: string): boolean {
		if (this.getMeta("embed_fingerprint") === fingerprint) return false;
		return this.tx(() => {
			if (this.getMeta("embed_fingerprint") === fingerprint) return false;
			this.clearEmbeddingsLocked();
			this.setMeta("embed_fingerprint", fingerprint);
			return true;
		});
	}

	clearEmbeddings(): void {
		this.tx(() => this.clearEmbeddingsLocked());
	}

	private clearEmbeddingsLocked(): void {
		this.db.exec("DELETE FROM embeddings");
		if (this.vecAvailable) this.db.exec("DROP TABLE IF EXISTS memories_vec");
		this.db.exec("UPDATE memories SET vec_hash = NULL");
		this.db.exec("DELETE FROM meta WHERE key = 'vec_dim'");
		this.stmtCache.clear();
	}

	vecDim(): number | undefined {
		const v = this.getMeta("vec_dim");
		return v ? Number(v) : undefined;
	}

	private ensureVecTable(dim: number): void {
		if (!this.vecAvailable) return;
		const cur = this.vecDim();
		if (cur === dim) return;
		this.db.exec("DROP TABLE IF EXISTS memories_vec");
		this.db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(rid INTEGER PRIMARY KEY, store TEXT, embedding float[${dim}] distance_metric=cosine)`);
		this.db.exec("UPDATE memories SET vec_hash = NULL");
		this.setMeta("vec_dim", String(dim));
		this.stmtCache.clear();
	}

	getCachedEmbedding(hash: string, fingerprint: string): Float32Array | undefined {
		const r = this.stmt("SELECT vec FROM embeddings WHERE hash = ? AND fingerprint = ?").get(hash, fingerprint) as { vec: Uint8Array } | undefined;
		return r ? fromBytes(r.vec) : undefined;
	}

	putEmbedding(hash: string, fingerprint: string, vec: Float32Array): void {
		this.stmt(
			"INSERT INTO embeddings(hash, fingerprint, dim, vec, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET fingerprint = excluded.fingerprint, dim = excluded.dim, vec = excluded.vec, created = excluded.created",
		).run(hash, fingerprint, vec.length, toF32Bytes(vec), Date.now());
	}

	/** Hashes of indexed memories that have no cached embedding for `fingerprint`. */
	missingEmbeddingHashes(fingerprint: string, limit = 10_000): Array<{ hash: string; caption: string; content: string }> {
		return this.stmt(
			`SELECT m.hash AS hash, MIN(m.caption) AS caption, MIN(m.content) AS content
			 FROM memories m LEFT JOIN embeddings e ON e.hash = m.hash AND e.fingerprint = ?
			 WHERE e.hash IS NULL GROUP BY m.hash LIMIT ?`,
		).all(fingerprint, limit) as Array<{ hash: string; caption: string; content: string }>;
	}

	/** Copy cached embeddings into the vector index for memories that are not indexed yet. */
	syncVectors(fingerprint: string): number {
		const rows = this.stmt(
			`SELECT m.rid AS rid, m.store AS store, m.hash AS hash, e.vec AS vec FROM memories m
			 JOIN embeddings e ON e.hash = m.hash AND e.fingerprint = ?
			 WHERE m.vec_hash IS NULL OR m.vec_hash != m.hash`,
		).all(fingerprint) as Array<{ rid: number; store: string; hash: string; vec: Uint8Array }>;
		if (rows.length === 0) return 0;
		this.tx(() => {
			for (const r of rows) {
				const vec = fromBytes(r.vec);
				if (this.vecAvailable) {
					this.ensureVecTable(vec.length);
					this.stmt("DELETE FROM memories_vec WHERE rid = ?").run(BigInt(r.rid));
					this.stmt("INSERT INTO memories_vec(rid, store, embedding) VALUES (?, ?, ?)").run(BigInt(r.rid), r.store, toF32Bytes(vec));
				}
				this.stmt("UPDATE memories SET vec_hash = ? WHERE rid = ?").run(r.hash, r.rid);
			}
		});
		return rows.length;
	}

	embeddingStats(fingerprint: string): { cached: number; stale: number; indexed: number; missing: number } {
		const cached = (this.stmt("SELECT COUNT(*) AS n FROM embeddings WHERE fingerprint = ?").get(fingerprint) as { n: number }).n;
		const stale = (this.stmt("SELECT COUNT(*) AS n FROM embeddings WHERE fingerprint != ?").get(fingerprint) as { n: number }).n;
		const indexed = (this.stmt("SELECT COUNT(*) AS n FROM memories WHERE vec_hash = hash").get() as { n: number }).n;
		const missing = (this.stmt("SELECT COUNT(*) AS n FROM memories WHERE vec_hash IS NULL OR vec_hash != hash").get() as { n: number }).n;
		return { cached, stale, indexed, missing };
	}

	/** Remove cached vectors no memory refers to any more. */
	pruneEmbeddings(): number {
		const r = this.stmt("DELETE FROM embeddings WHERE hash NOT IN (SELECT hash FROM memories)").run();
		return Number(r.changes);
	}

	// -------------------------------------------------------------------------
	// memories
	// -------------------------------------------------------------------------

	private rowToMemory(r: Row): MemoryRow {
		return {
			rid: Number(r.rid),
			id: String(r.id),
			store: String(r.store),
			kind: r.kind as ScopeKind,
			file: String(r.file),
			caption: String(r.caption),
			content: String(r.content),
			paths: parsePaths(r.paths),
			hash: String(r.hash),
			created: (r.created as string | null) ?? null,
			updated: (r.updated as string | null) ?? null,
			mtime: Number(r.mtime),
			size: Number(r.size),
			vecHash: (r.vec_hash as string | null) ?? null,
			flags: (r.flags as string | null) ?? null,
			usedCount: Number(r.used_count ?? 0),
			injectCount: Number(r.path_inject_count ?? 0),
			lastUsed: r.last_used === null || r.last_used === undefined ? null : Number(r.last_used),
		};
	}

	private static SELECT_MEM = SELECT_MEM_SQL;

	fileStates(store: string): IndexedFileState[] {
		const rows = this.stmt("SELECT rid, file, mtime, size, hash, id FROM memories WHERE store = ?").all(store) as Row[];
		return rows.map((r) => ({
			rid: Number(r.rid),
			file: String(r.file),
			mtime: Number(r.mtime),
			size: Number(r.size),
			hash: String(r.hash),
			id: String(r.id),
		}));
	}

	/** Insert or update a memory row (keyed by file). Must run inside `tx`. */
	upsertMemoryLocked(m: UpsertMemory): number {
		const existing = this.stmt("SELECT rid, hash FROM memories WHERE file = ?").get(m.file) as { rid: number; hash: string } | undefined;
		// A file that changed its id, or another file in the same store holding the id.
		const clash = this.stmt("SELECT rid, file FROM memories WHERE store = ? AND id = ? AND file != ?").get(m.store, m.id, m.file) as
			| { rid: number; file: string }
			| undefined;
		if (clash) throw new Error(`duplicate memory id in ${m.file} (also in ${clash.file})`);
		const paths = m.paths && m.paths.length > 0 ? JSON.stringify(m.paths) : null;
		let rid: number;
		if (existing) {
			rid = Number(existing.rid);
			this.stmt(
				`UPDATE memories SET id = ?, store = ?, kind = ?, caption = ?, content = ?, paths = ?, hash = ?, created = ?, updated = ?, mtime = ?, size = ?, flags = ?,
				 vec_hash = CASE WHEN hash = ? THEN vec_hash ELSE NULL END WHERE rid = ?`,
			).run(m.id, m.store, m.kind, m.caption, m.content, paths, m.hash, m.created ?? null, m.updated ?? null, m.mtime, m.size, m.flags ?? null, m.hash, rid);
			if (existing.hash !== m.hash && this.vecAvailable && this.vecDim()) {
				this.stmt("DELETE FROM memories_vec WHERE rid = ?").run(BigInt(rid));
			}
			this.stmt("DELETE FROM memories_fts WHERE rowid = ?").run(rid);
		} else {
			const r = this.stmt(
				`INSERT INTO memories(id, store, kind, file, caption, content, paths, hash, created, updated, mtime, size, flags)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(m.id, m.store, m.kind, m.file, m.caption, m.content, paths, m.hash, m.created ?? null, m.updated ?? null, m.mtime, m.size, m.flags ?? null);
			rid = Number(r.lastInsertRowid);
		}
		return rid;
	}

	/** Store FTS tokens for a memory. Must run inside `tx`. */
	setFtsLocked(rid: number, captionTokens: string, contentTokens: string): void {
		this.stmt("DELETE FROM memories_fts WHERE rowid = ?").run(rid);
		this.stmt("INSERT INTO memories_fts(rowid, caption, content) VALUES (?, ?, ?)").run(rid, captionTokens, contentTokens);
	}

	/** Remove every index row of a store (after its directory moved). Must run inside `tx`. */
	dropStoreLocked(store: string): void {
		for (const r of this.stmt("SELECT rid FROM memories WHERE store = ?").all(store) as Array<{ rid: number }>) this.deleteRidLocked(Number(r.rid));
	}

	/** Remove a memory row by rid. Must run inside `tx`. */
	deleteRidLocked(rid: number): void {
		const row = this.stmt("SELECT store, id FROM memories WHERE rid = ?").get(rid) as { store: string; id: string } | undefined;
		if (row) {
			this.stmt("DELETE FROM urgency WHERE store = ? AND id = ?").run(row.store, row.id);
			this.stmt("DELETE FROM path_state WHERE store = ? AND id = ?").run(row.store, row.id);
		}
		this.stmt("DELETE FROM memories_fts WHERE rowid = ?").run(rid);
		if (this.vecAvailable && this.vecDim()) this.stmt("DELETE FROM memories_vec WHERE rid = ?").run(BigInt(rid));
		this.stmt("DELETE FROM memories WHERE rid = ?").run(rid);
	}

	getByRid(rid: number): MemoryRow | undefined {
		const r = this.stmt(`${RealmemDB.SELECT_MEM} WHERE m.rid = ?`).get(rid) as Row | undefined;
		return r ? this.rowToMemory(r) : undefined;
	}

	getById(id: string, stores?: string[]): MemoryRow | undefined {
		const rows = (this.stmt(`${RealmemDB.SELECT_MEM} WHERE m.id = ?`).all(id) as Row[]).map((r) => this.rowToMemory(r));
		if (!stores) return rows[0];
		for (const s of stores) {
			const hit = rows.find((r) => r.store === s);
			if (hit) return hit;
		}
		return undefined;
	}

	getByIdPrefix(prefix: string, stores: string[]): MemoryRow[] {
		const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
		const rows = this.stmt(`${RealmemDB.SELECT_MEM} WHERE m.store IN (SELECT value FROM json_each(?)) AND m.id LIKE ? ESCAPE '\\' LIMIT 5`).all(
			JSON.stringify(stores),
			like,
		) as Row[];
		return rows.map((r) => this.rowToMemory(r));
	}

	getByHash(hash: string, stores: string[]): MemoryRow | undefined {
		const r = this.stmt(`${RealmemDB.SELECT_MEM} WHERE m.hash = ? AND m.store IN (SELECT value FROM json_each(?)) LIMIT 1`).get(hash, JSON.stringify(stores)) as
			| Row
			| undefined;
		return r ? this.rowToMemory(r) : undefined;
	}

	list(stores: string[], opts: { limit: number; offset: number; includeFlagged?: boolean; order?: ListOrder }): MemoryRow[] {
		if (stores.length === 0) return [];
		const sql = LIST_SQL[opts.order ?? "used"] ?? LIST_SQL.used;
		const rows = this.stmt(sql).all(JSON.stringify(stores), opts.includeFlagged ? 1 : 0, opts.limit, opts.offset) as Row[];
		return rows.map((r) => this.rowToMemory(r));
	}

	count(stores: string[], includeFlagged = false): number {
		if (stores.length === 0) return 0;
		const r = this.stmt("SELECT COUNT(*) AS n FROM memories WHERE store IN (SELECT value FROM json_each(?)) AND (? = 1 OR flags IS NULL)").get(
			JSON.stringify(stores),
			includeFlagged ? 1 : 0,
		) as { n: number };
		return Number(r.n);
	}

	countFlagged(stores: string[]): number {
		if (stores.length === 0) return 0;
		const r = this.stmt("SELECT COUNT(*) AS n FROM memories WHERE store IN (SELECT value FROM json_each(?)) AND flags IS NOT NULL").get(JSON.stringify(stores)) as {
			n: number;
		};
		return Number(r.n);
	}

	getByRids(rids: number[]): Map<number, MemoryRow> {
		const out = new Map<number, MemoryRow>();
		if (rids.length === 0) return out;
		const rows = this.stmt(`${RealmemDB.SELECT_MEM} WHERE m.rid IN (SELECT value FROM json_each(?))`).all(JSON.stringify(rids)) as Row[];
		for (const r of rows) {
			const m = this.rowToMemory(r);
			out.set(m.rid, m);
		}
		return out;
	}

	// -------------------------------------------------------------------------
	// search
	// -------------------------------------------------------------------------

	/** BM25 search (lower bm25 is better; returned score is the positive negation). */
	ftsSearch(stores: string[], match: string, limit: number): SearchHit[] {
		if (stores.length === 0) return [];
		try {
			const rows = this.stmt(
				`SELECT f.rowid AS rid, bm25(memories_fts, 2.0, 1.0) AS score FROM memories_fts f JOIN memories m ON m.rid = f.rowid
				 WHERE memories_fts MATCH ? AND m.store IN (SELECT value FROM json_each(?)) AND m.flags IS NULL ORDER BY score LIMIT ?`,
			).all(match, JSON.stringify(stores), limit) as Array<{ rid: number; score: number }>;
			return rows.map((r) => ({ rid: Number(r.rid), score: -Number(r.score) }));
		} catch {
			return [];
		}
	}

	/** Cosine KNN over the vector index. Score is cosine similarity. */
	vecSearch(stores: string[], query: Float32Array, k: number): SearchHit[] {
		if (stores.length === 0) return [];
		const kk = Math.max(1, Math.min(4096, Math.floor(k)));
		if (this.vecAvailable) {
			const dim = this.vecDim();
			if (!dim || dim !== query.length) return [];
			// vec0 partition-style filtering: one KNN per store, merged by distance.
			const knn = this.stmt("SELECT rid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? AND store = ?");
			const flagged = this.stmt("SELECT flags FROM memories WHERE rid = ?");
			const hits: SearchHit[] = [];
			for (const store of new Set(stores)) {
				const rows = knn.all(toF32Bytes(query), kk, store) as Array<{ rid: number; distance: number }>;
				for (const r of rows) {
					const f = flagged.get(Number(r.rid)) as { flags: string | null } | undefined;
					if (!f || f.flags) continue;
					hits.push({ rid: Number(r.rid), score: 1 - Number(r.distance) });
				}
			}
			return hits.sort((a, b) => b.score - a.score).slice(0, kk);
		}
		// Fallback without sqlite-vec: brute force over cached embeddings.
		const rows = this.stmt(
			"SELECT m.rid AS rid, e.vec AS vec FROM memories m JOIN embeddings e ON e.hash = m.hash WHERE m.store IN (SELECT value FROM json_each(?)) AND m.flags IS NULL",
		).all(JSON.stringify(stores)) as Array<{ rid: number; vec: Uint8Array }>;
		return rows
			.map((r) => ({ rid: Number(r.rid), score: cosine(query, fromBytes(r.vec)) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, kk);
	}

	getVector(rid: number, fingerprint: string): Float32Array | undefined {
		const r = this.stmt("SELECT e.vec AS vec FROM memories m JOIN embeddings e ON e.hash = m.hash AND e.fingerprint = ? WHERE m.rid = ?").get(fingerprint, rid) as
			| { vec: Uint8Array }
			| undefined;
		return r ? fromBytes(r.vec) : undefined;
	}

	// -------------------------------------------------------------------------
	// usage counters (local only, never written to memory files)
	// -------------------------------------------------------------------------

	bumpUsage(ids: string[], kind: "reinforce" | "recall" | "inject", by = 1): void {
		if (ids.length === 0) return;
		const now = Date.now();
		this.tx(() => {
			for (const id of new Set(ids)) {
				if (kind === "inject") this.stmt(BUMP_INJECT_SQL).run(id, by, now);
				else this.stmt(kind === "reinforce" ? BUMP_REINFORCE_SQL : BUMP_RECALL_SQL).run(id, by, by, now);
			}
		});
	}

	setUsage(id: string, count: number): void {
		this.stmt(
			"INSERT INTO usage(id, used_count, last_used) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET used_count = excluded.used_count",
		).run(id, count, Date.now());
	}

	usageDetail(id: string): { used: number; reinforce: number; recall: number; inject: number; lastUsed: number | null } {
		const r = this.stmt("SELECT used_count, reinforce_count, recall_count, path_inject_count, last_used FROM usage WHERE id = ?").get(id) as Row | undefined;
		return {
			used: Number(r?.used_count ?? 0),
			reinforce: Number(r?.reinforce_count ?? 0),
			recall: Number(r?.recall_count ?? 0),
			inject: Number(r?.path_inject_count ?? 0),
			lastUsed: r?.last_used === undefined || r?.last_used === null ? null : Number(r.last_used),
		};
	}

	// -------------------------------------------------------------------------
	// path urgency (SemIf score, local; keyed by the path basis it was judged for)
	// -------------------------------------------------------------------------

	getUrgency(store: string, id: string): UrgencyRow | undefined {
		const r = this.stmt("SELECT score, source, basis, probs, confidence, updated FROM urgency WHERE store = ? AND id = ?").get(store, id) as Row | undefined;
		if (!r) return undefined;
		let probabilities: Record<string, number> | undefined;
		if (typeof r.probs === "string") {
			try {
				probabilities = JSON.parse(r.probs) as Record<string, number>;
			} catch {
				probabilities = undefined;
			}
		}
		return {
			score: Number(r.score),
			source: String(r.source),
			basis: String(r.basis),
			probabilities,
			confidence: r.confidence === null || r.confidence === undefined ? undefined : Number(r.confidence),
			updated: Number(r.updated),
		};
	}

	setUrgency(
		store: string,
		id: string,
		score: number,
		source: string,
		basis: string,
		detail: { probabilities?: Record<string, number>; confidence?: number } = {},
	): void {
		const probs = detail.probabilities && Object.keys(detail.probabilities).length > 0 ? JSON.stringify(detail.probabilities) : null;
		this.stmt(
			`INSERT INTO urgency(store, id, score, source, basis, probs, confidence, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(store, id) DO UPDATE SET score = excluded.score, source = excluded.source, basis = excluded.basis,
			 probs = excluded.probs, confidence = excluded.confidence, updated = excluded.updated`,
		).run(store, id, score, source, basis, probs, detail.confidence ?? null, Date.now());
	}

	/** Path-scoped memories whose urgency is missing or was judged for other content/paths. */
	urgencyStale(stores: string[], limit: number): MemoryRow[] {
		const rows = this.stmt(
			`${SELECT_MEM_SQL} LEFT JOIN urgency g ON g.store = m.store AND g.id = m.id
			 WHERE m.store IN (SELECT value FROM json_each(?)) AND m.flags IS NULL
			 AND m.paths IS NOT NULL AND m.paths NOT IN ('["."]', '["~"]') AND (g.basis IS NULL OR g.basis != m.hash || '|' || m.paths)
			 LIMIT ?`,
		).all(JSON.stringify(stores), limit) as Row[];
		return rows.map((r) => this.rowToMemory(r));
	}

	/** Path-scoped memories (scope other than the whole project) of `stores`, with their urgency. */
	pathScoped(stores: string[]): Array<MemoryRow & { urgency: number | undefined }> {
		const rows = this.stmt(
			`SELECT m.*, COALESCE(u.used_count, 0) AS used_count, COALESCE(u.path_inject_count, 0) AS path_inject_count, u.last_used AS last_used, g.score AS urgency_score
			 FROM memories m LEFT JOIN usage u ON u.id = m.id
			 LEFT JOIN urgency g ON g.store = m.store AND g.id = m.id AND g.basis = m.hash || '|' || m.paths
			 WHERE m.store IN (SELECT value FROM json_each(?)) AND m.flags IS NULL
			 AND m.paths IS NOT NULL AND m.paths NOT IN ('["."]', '["~"]')`,
		).all(JSON.stringify(stores)) as Row[];
		return rows.map((r) => ({
			...this.rowToMemory(r),
			urgency: r.urgency_score === null || r.urgency_score === undefined ? undefined : Number(r.urgency_score),
		}));
	}

	// -------------------------------------------------------------------------
	// stale path scopes
	// -------------------------------------------------------------------------

	getPathState(store: string, id: string): PathStateRow | undefined {
		const r = this.stmt("SELECT missing, suggestion FROM path_state WHERE store = ? AND id = ?").get(store, id) as Row | undefined;
		if (!r) return undefined;
		return { missing: parsePaths(r.missing) ?? [], suggestion: r.suggestion === null ? null : String(r.suggestion) };
	}

	setPathState(store: string, id: string, basis: string, missing: string[], suggestion: string | undefined): void {
		if (missing.length === 0) {
			this.stmt("DELETE FROM path_state WHERE store = ? AND id = ?").run(store, id);
			return;
		}
		this.stmt(
			"INSERT INTO path_state(store, id, basis, missing, suggestion, checked) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(store, id) DO UPDATE SET basis = excluded.basis, missing = excluded.missing, suggestion = excluded.suggestion, checked = excluded.checked",
		).run(store, id, basis, JSON.stringify(missing), suggestion ?? null, Date.now());
	}

	stalePathIds(stores: string[]): Set<string> {
		const rows = this.stmt("SELECT id FROM path_state WHERE store IN (SELECT value FROM json_each(?))").all(JSON.stringify(stores)) as Array<{ id: string }>;
		return new Set(rows.map((r) => String(r.id)));
	}

	/** Path-scoped memories of `stores` (for stale checks), as (store, id, paths, hash). */
	scopedPaths(stores: string[]): Array<{ store: string; id: string; kind: ScopeKind; paths: string[]; hash: string }> {
		const rows = this.stmt(
			`SELECT store, id, kind, paths, hash FROM memories WHERE store IN (SELECT value FROM json_each(?)) AND paths IS NOT NULL AND paths NOT IN ('["."]', '["~"]')`,
		).all(JSON.stringify(stores)) as Row[];
		return rows.map((r) => ({ store: String(r.store), id: String(r.id), kind: r.kind as ScopeKind, paths: parsePaths(r.paths) ?? [], hash: String(r.hash) }));
	}

	// -------------------------------------------------------------------------
	// quarantine approvals
	// -------------------------------------------------------------------------

	isApproved(hash: string): boolean {
		return !!this.stmt("SELECT 1 AS ok FROM approvals WHERE hash = ?").get(hash);
	}

	approve(hash: string): void {
		this.stmt("INSERT OR IGNORE INTO approvals(hash, approved_at) VALUES (?, ?)").run(hash, Date.now());
		this.stmt("UPDATE memories SET flags = NULL WHERE hash = ?").run(hash);
	}

	// -------------------------------------------------------------------------
	// pending candidates (judge unreachable) and imported context files
	// -------------------------------------------------------------------------

	enqueuePending(projectRoot: string | undefined, payload: unknown, error: string): number {
		const r = this.stmt("INSERT INTO pending(project_root, payload, created, attempts, last_error) VALUES (?, ?, ?, 0, ?)").run(
			projectRoot ?? null,
			JSON.stringify(payload),
			Date.now(),
			error,
		);
		return Number(r.lastInsertRowid);
	}

	listPending(projectRoot: string | undefined, limit = 50): Array<{ seq: number; payload: unknown; attempts: number; lastError: string | null; created: number }> {
		const rows = this.stmt("SELECT seq, payload, attempts, last_error, created FROM pending WHERE project_root IS ? OR project_root IS NULL ORDER BY seq LIMIT ?").all(
			projectRoot ?? null,
			limit,
		) as Row[];
		const out: Array<{ seq: number; payload: unknown; attempts: number; lastError: string | null; created: number }> = [];
		for (const r of rows) {
			let payload: unknown;
			try {
				payload = JSON.parse(String(r.payload));
			} catch {
				this.stmt("DELETE FROM pending WHERE seq = ?").run(Number(r.seq));
				continue;
			}
			out.push({ seq: Number(r.seq), payload, attempts: Number(r.attempts), lastError: (r.last_error as string | null) ?? null, created: Number(r.created) });
		}
		return out;
	}

	countPending(): number {
		return Number((this.stmt("SELECT COUNT(*) AS n FROM pending").get() as { n: number }).n);
	}

	deletePending(seq: number): void {
		this.stmt("DELETE FROM pending WHERE seq = ?").run(seq);
	}

	failPending(seq: number, error: string): void {
		this.stmt("UPDATE pending SET attempts = attempts + 1, last_error = ? WHERE seq = ?").run(error, seq);
	}

	isContextImported(hash: string): boolean {
		return !!this.stmt("SELECT 1 AS ok FROM imported_context WHERE hash = ?").get(hash);
	}

	markContextImported(hash: string, path: string): void {
		this.stmt("INSERT OR REPLACE INTO imported_context(hash, path, imported_at) VALUES (?, ?, ?)").run(hash, path, Date.now());
	}

	// -------------------------------------------------------------------------
	// cross-process lease locks
	// -------------------------------------------------------------------------

	private tryAcquire(name: string, owner: string, ttlMs: number): boolean {
		const now = Date.now();
		const host = hostname();
		return this.tx(() => {
			const cur = this.stmt("SELECT owner, pid, host, expires FROM locks WHERE name = ?").get(name) as
				| { owner: string; pid: number; host: string; expires: number }
				| undefined;
			if (cur) {
				const dead = cur.host === host && cur.pid !== process.pid && !pidAlive(Number(cur.pid));
				if (Number(cur.expires) > now && !dead) return false;
				this.stmt("DELETE FROM locks WHERE name = ?").run(name);
			}
			this.stmt("INSERT INTO locks(name, owner, pid, host, acquired, expires) VALUES (?, ?, ?, ?, ?, ?)").run(name, owner, process.pid, host, now, now + ttlMs);
			return true;
		});
	}

	private renew(name: string, owner: string, ttlMs: number): void {
		try {
			this.stmt("UPDATE locks SET expires = ? WHERE name = ? AND owner = ?").run(Date.now() + ttlMs, name, owner);
		} catch {
			// busy: next heartbeat retries
		}
	}

	private release(name: string, owner: string): void {
		for (let i = 0; i < 5; i++) {
			try {
				this.stmt("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
				return;
			} catch {
				// retry on busy
			}
		}
	}

	lockHolder(name: string): { pid: number; host: string; acquired: number; expires: number } | undefined {
		const r = this.stmt("SELECT pid, host, acquired, expires FROM locks WHERE name = ?").get(name) as Row | undefined;
		if (!r || Number(r.expires) < Date.now()) return undefined;
		return { pid: Number(r.pid), host: String(r.host), acquired: Number(r.acquired), expires: Number(r.expires) };
	}

	/**
	 * Run `fn` while holding the named lease lock. The lock is shared by every
	 * process using this database (and serializes callers inside this process);
	 * it is renewed while `fn` runs and expires on its own if the holder dies.
	 */
	async withLock<T>(name: string, fn: () => Promise<T>, opts: { timeoutMs?: number; ttlMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		const timeoutMs = opts.timeoutMs ?? 120_000;
		const ttlMs = opts.ttlMs ?? 30_000;
		// In-process queue first so parallel tool calls do not spin on SQLite.
		const prev = this.localLocks.get(name) ?? Promise.resolve();
		let releaseLocal!: () => void;
		const mine = new Promise<void>((r) => {
			releaseLocal = r;
		});
		const chained = prev.then(() => mine);
		this.localLocks.set(name, chained);
		try {
			await prev;
			const owner = randomBytes(8).toString("hex");
			const deadline = Date.now() + timeoutMs;
			let delay = 25;
			while (!this.tryAcquireSafe(name, owner, ttlMs)) {
				if (opts.signal?.aborted) throw new Error("aborted while waiting for realmem lock");
				if (Date.now() > deadline) {
					const h = this.lockHolder(name);
					throw new LockTimeoutError(`realmem lock "${name}" is busy${h ? ` (held by pid ${h.pid} on ${h.host})` : ""}`);
				}
				await sleep(delay + Math.random() * delay);
				delay = Math.min(500, delay * 2);
			}
			const beat = setInterval(() => this.renew(name, owner, ttlMs), Math.max(1000, Math.floor(ttlMs / 3)));
			beat.unref?.();
			try {
				return await fn();
			} finally {
				clearInterval(beat);
				this.release(name, owner);
			}
		} finally {
			releaseLocal();
			if (this.localLocks.get(name) === chained) this.localLocks.delete(name);
		}
	}

	private tryAcquireSafe(name: string, owner: string, ttlMs: number): boolean {
		try {
			return this.tryAcquire(name, owner, ttlMs);
		} catch {
			return false; // SQLITE_BUSY beyond busy_timeout: treat as contended
		}
	}
}
