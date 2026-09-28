/**
 * realmem engine: ties together settings, stores, index, judge and rewriter.
 * One instance per Pi process; stateless with respect to the working directory
 * (every call passes the cwd so multiple sessions can share it).
 */
import type { Usage } from "@earendil-works/pi-ai";
import { EmbeddingClient, type HttpTrace, SemIfClient, type SemIfResponse } from "./api.ts";
import { agentDirFromEnv, embeddingFingerprint, loadSettings, type RealmemPaths, realmemPaths, type Settings, saveSettings, settingsMtime } from "./config.ts";
import { LockTimeoutError, type MemoryRow, RealmemDB } from "./db.ts";
import { MAX_CAPTION, MAX_CONTENT, type MemoryFile, normalizePathScopes, SCOPE_LABEL, type ScopeKind, type StoreRef } from "./files.ts";
import { newId, parseId } from "./ids.ts";
import {
	buildJudgeRequest,
	type Candidate,
	chunkQuestions,
	type Decision,
	decide,
	type JudgeRequest,
	type Neighbor,
	pathUrgencyQuestion,
	readSignals,
	type Signals,
	type UrgencyTier,
	urgencyTier,
} from "./judge.ts";
import { migratePersonalStore, type ProjectInfo, personalStore, type ScopeContext, scopeContext, writeProjectInfo } from "./project.ts";
import { fallbackRewrite, type RewriteResult, type Rewriter } from "./rewrite.ts";
import { describeSafety, redactSecrets, sanitizeForPrompt, scanAll, scanInjection, stripInvisible } from "./safety.ts";
import { checkSharedIgnored, describeIgnoreProblem, type IgnoreProblem } from "./gitignore.ts";
import { MemoryIndex, type RankedHit, type SyncReport } from "./store.ts";
import { textHash } from "./text.ts";
import {
	absoluteScopes,
	clearRepoCache,
	coverSpecificity,
	fromAbsoluteScope,
	homeRoot,
	isWholeScope,
	pathsOverlap,
	repoFiles,
	resolvePathArg,
	scopeCovers,
	scopeExists,
	suggestRename,
} from "./paths.ts";

export const WRITE_LOCK = "write";

export interface RememberInput {
	caption: string;
	content: string;
	/**
	 * Path scopes: files, directories or globs, relative to the cwd, `~/…` or absolute.
	 * Omitted = the whole root of the store (project root, or `~` for global memories).
	 */
	paths?: string[];
	scope?: ScopeKind;
	source: Candidate["source"];
	force?: boolean;
}

export interface RememberOptions {
	cwd: string;
	/** Analyze only: do not write files or counters. */
	dryRun?: boolean;
	rewriter?: Rewriter;
	signal?: AbortSignal;
	/** Progress callback for UIs. */
	onStep?: (step: string) => void;
	/** Queue the candidate for later when the judge or embedder is unreachable. */
	queueOnFailure?: boolean;
}

export interface Trace {
	embed?: { ms: number; cached: boolean; tokens: number; dims: number; error?: string };
	search?: { ms: number; neighbors: number; vecHits: number; ftsHits: number };
	judge?: { ms: number; requests: number; traces: HttpTrace[]; inputTokens: number };
	rewrite?: { ms: number; model: string; usage?: Usage; fallback?: string };
}

export interface RememberOutcome {
	status: "added" | "edited" | "merged" | "reinforced" | "skipped" | "rejected" | "queued" | "planned";
	decision?: Decision;
	/** The memory written or reinforced. */
	memory?: MemoryRow;
	/** Memory content before an edit/merge. */
	before?: { caption: string; content: string };
	/** Planned (dry-run) or written content for edit/merge/add. */
	proposed?: { caption: string; content: string };
	candidate: Candidate;
	neighbors: Neighbor[];
	judgeRequest?: JudgeRequest;
	judgeResponses?: SemIfResponse[];
	signals?: Signals;
	safety: { secrets: string[]; injections: string[]; redacted: boolean };
	trace: Trace;
	message: string;
	error?: string;
}

export interface RecallResult {
	items: Array<RankedHit & { store: StoreRef | undefined }>;
	total: number;
	page: number;
	pages: number;
	embedError?: string;
	/** Project-relative paths the ranking favoured. */
	focus?: string[];
}

/** Key under which a path urgency stays valid: the memory's content and its paths. */
export function urgencyBasis(m: Pick<MemoryRow, "hash" | "paths">): string {
	return `${m.hash}|${JSON.stringify(m.paths ?? null)}`;
}

/**
 * Path rank of a memory for recall (focus = absolute paths): 2+ = its scope covers a
 * focus path (the more specific, the higher), 1 = whole-root scope (project root or
 * `~`), 0 = scoped to other paths only.
 */
export function pathTier(m: Pick<MemoryRow, "kind" | "paths">, focus: string[], projectRoot: string | undefined): number {
	const abs = absoluteScopes(m, projectRoot);
	if (!abs) return 1;
	if (focus.length === 0) return 0.5;
	const spec = coverSpecificity(abs, focus);
	if (spec >= 0) return 2 + spec / 100;
	// A focus directory that contains the memory's scope counts too (focus = packages/web, scope = packages/web/src).
	if (abs.some((p) => focus.some((f) => scopeCovers(f, p)))) return 2;
	return 0;
}

/** Convert absolute scopes into a store's frame, dropping those it cannot hold. */
export function toStoreScopes(abs: string[] | undefined, kind: ScopeKind, projectRoot: string | undefined): string[] {
	const whole = kind === "global" ? "~" : ".";
	if (!abs || abs.length === 0) return [whole];
	const out = abs.map((p) => fromAbsoluteScope(p, kind, projectRoot)).filter((p): p is string => !!p);
	return normalizePathScopes(out.length > 0 ? out : [whole], kind);
}

export class CandidateError extends Error {}

function now(): string {
	return new Date().toISOString();
}

export class Realmem {
	readonly paths: RealmemPaths;
	settings: Settings;
	readonly db: RealmemDB;
	index: MemoryIndex;
	private embedder: EmbeddingClient;
	private semif: SemIfClient;
	private settingsMtime = 0;
	private embedPromise: Promise<unknown> | undefined;
	private urgencyPromise: Promise<unknown> | undefined;
	private migrated = new Set<string>();

	constructor(baseDir?: string) {
		this.paths = realmemPaths(baseDir ?? process.env.REALMEM_HOME ?? `${agentDirFromEnv()}/realmem`);
		this.settings = loadSettings(this.paths.config);
		this.settingsMtime = settingsMtime(this.paths.config);
		this.db = new RealmemDB(this.paths.db);
		this.embedder = new EmbeddingClient(this.settings);
		this.semif = new SemIfClient(this.settings);
		this.index = new MemoryIndex(this.db, this.settings, this.embedder);
		this.index.checkFingerprint();
	}

	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// settings
	// -------------------------------------------------------------------------

	/** Pick up settings changed by another Pi process. */
	reloadSettingsIfChanged(): void {
		const m = settingsMtime(this.paths.config);
		if (m !== this.settingsMtime) this.applySettings(loadSettings(this.paths.config), false);
	}

	/** Apply (and optionally persist) new settings. Changing the embedding space clears the cache. */
	applySettings(next: Settings, persist = true): { embeddingCleared: boolean } {
		const before = embeddingFingerprint(this.settings);
		this.settings = next;
		if (persist) saveSettings(this.paths.config, next);
		this.settingsMtime = settingsMtime(this.paths.config);
		this.embedder = new EmbeddingClient(next);
		this.semif = new SemIfClient(next);
		this.index.setClients(next, this.embedder);
		const changed = embeddingFingerprint(next) !== before;
		const cleared = this.index.checkFingerprint();
		return { embeddingCleared: changed || cleared };
	}

	get semifClient(): SemIfClient {
		return this.semif;
	}

	get embeddingClient(): EmbeddingClient {
		return this.embedder;
	}

	// -------------------------------------------------------------------------
	// scopes and sync
	// -------------------------------------------------------------------------

	scopes(cwd: string): ScopeContext {
		const ctx = scopeContext(cwd, this.paths.globalDir, this.paths.personalRoot);
		const p = ctx.project;
		if (p && !this.migrated.has(p.root)) {
			this.migrated.add(p.root);
			try {
				if (migratePersonalStore(this.paths.personalRoot, p) > 0) {
					const old = personalStore(this.paths.personalRoot, p.pathKey).id;
					this.db.tx(() => this.db.dropStoreLocked(old));
				}
			} catch {
				// best effort; the old directory stays in place
			}
		}
		return ctx;
	}

	storeFor(ctx: ScopeContext, kind: ScopeKind): StoreRef | undefined {
		return kind === "global" ? ctx.global : kind === "shared" ? ctx.shared : ctx.personal;
	}

	storeById(ctx: ScopeContext, id: string): StoreRef | undefined {
		return ctx.stores.find((s) => s.id === id);
	}

	/** Sync the stores visible from `cwd` with their files. */
	sync(cwd: string): SyncReport {
		this.reloadSettingsIfChanged();
		return this.index.sync(this.scopes(cwd).stores);
	}

	/**
	 * Embed memories without vectors (in the background, deduplicated).
	 * Holds the write lock so parallel Pi processes do not embed the same texts twice.
	 */
	embedInBackground(signal?: AbortSignal): Promise<unknown> {
		if (this.embedPromise) return this.embedPromise;
		this.embedPromise = this.db
			.withLock("embed", () => this.index.embedMissing(signal), { timeoutMs: 5_000, signal })
			.catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.embedPromise = undefined;
			});
		return this.embedPromise;
	}

	// -------------------------------------------------------------------------
	// recall
	// -------------------------------------------------------------------------

	async recall(
		cwd: string,
		queries: string[],
		opts: {
			page?: number;
			pageSize?: number;
			scope?: ScopeKind;
			signal?: AbortSignal;
			countUsage?: boolean;
			/** Paths (relative to cwd, `~/…` or absolute) the query is about: ranked first; alone, lists their memories. */
			paths?: string[];
			/** Absolute paths the agent touched recently (ranked first as well). */
			focus?: string[];
		} = {},
	): Promise<RecallResult> {
		const ctx = this.scopes(cwd);
		this.sync(cwd);
		const stores = opts.scope ? ctx.stores.filter((s) => s.kind === opts.scope) : ctx.stores;
		const texts = queries.map((q) => q.trim()).filter(Boolean).slice(0, 16);
		const explicit = (opts.paths ?? []).map((p) => resolvePathArg(p, cwd)).filter((p): p is string => !!p && p !== "/");
		if (texts.length === 0) {
			if (explicit.length === 0) throw new CandidateError("recall needs at least one non-empty query or a path");
			return this.pathLookup(ctx, stores, explicit, opts);
		}
		const here = resolvePathArg(".", cwd);
		const focus = [...new Set([...explicit, ...(opts.focus ?? []), ...(here && here !== ctx.project?.root && here !== homeRoot() ? [here] : [])])];
		let vectors: Float32Array[] = [];
		let embedError: string | undefined;
		if (this.embedder.configured) {
			try {
				await this.index.embedMissing(opts.signal);
				vectors = (await this.embedder.embed(texts, "query", opts.signal)).vectors;
			} catch (err) {
				embedError = err instanceof Error ? err.message : String(err);
			}
		}
		const s = this.settings;
		const hits = this.index.hybrid(stores, {
			vectors,
			texts,
			limit: s.recall.maxResults,
			minSimilarity: s.thresholds.recallMinSimilarity,
		});
		// Relevant set first; then ordered by path (memories about the focus paths first,
		// project-wide next, other areas last), then most used, then relevance.
		const rank = new Map(hits.map((h, i) => [h.memory.rid, i]));
		const tier = (m: MemoryRow) => pathTier(m, focus, ctx.project?.root);
		hits.sort(
			(a, b) =>
				tier(b.memory) - tier(a.memory) || b.memory.usedCount - a.memory.usedCount || (rank.get(a.memory.rid) ?? 0) - (rank.get(b.memory.rid) ?? 0),
		);
		const pageSize = Math.max(1, opts.pageSize ?? s.recall.pageSize);
		const pages = Math.max(1, Math.ceil(hits.length / pageSize));
		const page = Math.min(Math.max(1, opts.page ?? 1), pages);
		const items = hits.slice((page - 1) * pageSize, page * pageSize).map((h) => ({ ...h, store: this.storeById(ctx, h.memory.store) }));
		if (items.length > 0 && opts.countUsage !== false) this.db.bumpUsage(items.map((i) => i.memory.id), "recall");
		return { items, total: hits.length, page, pages, embedError, focus };
	}

	/** Fetch memories by id (compact or canonical UUID, or a unique prefix of ≥ 6 chars). */
	getMemories(cwd: string, ids: string[], countUsage = true): { found: MemoryRow[]; missing: string[] } {
		const ctx = this.scopes(cwd);
		this.sync(cwd);
		const stores = ctx.stores.map((s) => s.id);
		const found: MemoryRow[] = [];
		const missing: string[] = [];
		for (const raw of ids.slice(0, 32)) {
			const id = parseId(raw);
			let m = id ? this.db.getById(id, stores) : undefined;
			if (!m && !id && raw.trim().length >= 6) {
				const hits = this.db.getByIdPrefix(raw.trim(), stores);
				if (hits.length === 1) m = hits[0];
			}
			if (m && !m.flags) found.push(m);
			else missing.push(raw);
		}
		if (countUsage && found.length > 0) this.db.bumpUsage(found.map((m) => m.id), "recall");
		return { found, missing };
	}

	/** Recall without a query: the memories attached to the given paths, most specific then most used first. */
	private pathLookup(
		ctx: ScopeContext,
		stores: StoreRef[],
		paths: string[],
		opts: { page?: number; pageSize?: number; countUsage?: boolean },
	): RecallResult {
		const rows = this.db
			.pathScoped(stores.map((s) => s.id))
			.map((m) => {
				const abs = absoluteScopes(m, ctx.project?.root) ?? [];
				return { m, spec: Math.max(coverSpecificity(abs, paths), abs.some((p) => paths.some((q) => scopeCovers(q, p))) ? 0 : -1) };
			})
			.filter((x) => x.spec >= 0)
			.sort((a, b) => b.spec - a.spec || b.m.usedCount - a.m.usedCount);
		const pageSize = Math.max(1, opts.pageSize ?? this.settings.recall.pageSize);
		const pages = Math.max(1, Math.ceil(rows.length / pageSize));
		const page = Math.min(Math.max(1, opts.page ?? 1), pages);
		const items = rows.slice((page - 1) * pageSize, page * pageSize).map((x) => ({ memory: x.m as MemoryRow, score: 0, store: this.storeById(ctx, x.m.store) }));
		if (items.length > 0 && opts.countUsage !== false) this.db.bumpUsage(items.map((i) => i.memory.id), "recall");
		return { items, total: rows.length, page, pages, focus: paths };
	}

	/**
	 * Most used project-wide (or global) memories visible from `cwd`, for the session
	 * prompt. Path-scoped memories are left out: they are shown when their paths are touched.
	 */
	topMemories(cwd: string, limit: number): MemoryRow[] {
		const ctx = this.scopes(cwd);
		const out: MemoryRow[] = [];
		for (let offset = 0; out.length < limit; offset += 200) {
			const rows = this.db.list(
				ctx.stores.map((s) => s.id),
				{ limit: 200, offset, order: "used" },
			);
			for (const r of rows) if (isWholeScope(r.paths ?? undefined)) out.push(r);
			if (rows.length < 200) break;
		}
		return out.slice(0, limit);
	}

	/** Where path-scoped memories live: scope → number of memories, most first. */
	pathMap(cwd: string, limit = 10): Array<{ path: string; count: number }> {
		const ctx = this.scopes(cwd);
		const counts = new Map<string, number>();
		for (const m of this.db.pathScoped(ctx.stores.map((s) => s.id))) for (const p of m.paths ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
		// Project paths are relative to the project root; global ones start with `~/` or `/`.
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, limit)
			.map(([path, count]) => ({ path, count }));
	}

	// -------------------------------------------------------------------------
	// path notes (shown when the agent touches a memory's paths)
	// -------------------------------------------------------------------------

	/**
	 * Path-scoped memories (project or global) covering any of the touched absolute
	 * paths, most specific first, then most used. Each carries its urgency tier.
	 */
	notesForPaths(cwd: string, touched: string[], exclude: Set<string>): Array<{ memory: MemoryRow; tier: UrgencyTier; specificity: number }> {
		const ctx = this.scopes(cwd);
		if (touched.length === 0) return [];
		const t = this.settings.thresholds;
		const out: Array<{ memory: MemoryRow; tier: UrgencyTier; specificity: number }> = [];
		for (const m of this.db.pathScoped(ctx.stores.map((s) => s.id))) {
			if (exclude.has(m.id)) continue;
			const abs = absoluteScopes(m, ctx.project?.root);
			if (!abs) continue;
			const spec = coverSpecificity(abs, touched);
			if (spec < 0) continue;
			out.push({ memory: m, tier: urgencyTier(m.urgency, t), specificity: spec });
		}
		return out.sort((a, b) => b.specificity - a.specificity || b.memory.usedCount - a.memory.usedCount);
	}

	/** Judge path urgency for path-scoped memories that have none (or a stale one). */
	async refreshUrgency(cwd: string, signal?: AbortSignal, max = 16): Promise<number> {
		if (!this.semif.configured) return 0;
		const ctx = this.scopes(cwd);
		const stores = ctx.stores.map((s) => s.id);
		let done = 0;
		while (done < max) {
			const batch = this.db.urgencyStale(stores, Math.min(4, max - done));
			if (batch.length === 0) break;
			for (const m of batch) {
				const state = [
					`## Memory of an AI coding agent, attached to ${m.kind === "global" ? "paths on the user's machine" : "project paths"}`,
					`Paths: ${(m.paths ?? []).join(", ")}`,
					`Caption: ${sanitizeForPrompt(m.caption)}`,
					"Content:",
					sanitizeForPrompt(m.content),
				].join("\n");
				const r = await this.semif.evaluate(state, { path_urgency: pathUrgencyQuestion() }, signal);
				const a = r.response.answers.path_urgency;
				if (a?.type === "score") this.db.setUrgency(m.store, m.id, a.score, "judge", urgencyBasis(m));
				done++;
			}
		}
		return done;
	}

	/** Background, deduplicated urgency refresh. */
	refreshUrgencyInBackground(cwd: string): Promise<unknown> {
		if (this.urgencyPromise) return this.urgencyPromise;
		this.urgencyPromise = this.refreshUrgency(cwd)
			.catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.urgencyPromise = undefined;
			});
		return this.urgencyPromise;
	}

	/** Flag path-scoped memories whose paths no longer exist (with a rename suggestion from git). */
	checkPaths(cwd: string): { checked: number; stale: number } {
		const ctx = this.scopes(cwd);
		if (!this.settings.paths.staleCheck) return { checked: 0, stale: 0 };
		const noGit = { head: "", files: undefined, renames: new Map<string, string>() };
		const repo = ctx.project ? repoFiles(ctx.project.root, ctx.project.isGit) : noGit;
		let stale = 0;
		const rows = this.db.scopedPaths(ctx.stores.map((s) => s.id));
		this.db.tx(() => {
			for (const m of rows) {
				// Project scopes are checked against the working tree (globs via git); global
				// scopes against the file system (globs are not checked without an index).
				const root = m.kind === "global" ? homeRoot() : ctx.project?.root;
				if (!root) continue;
				const rel = (p: string) => (m.kind === "global" ? (p.startsWith("~/") ? p.slice(2) : p) : p);
				const missing = m.paths.filter((p) => !scopeExists(root, rel(p), m.kind === "global" ? noGit : repo));
				const suggestion = m.kind !== "global" && missing.length === 1 ? suggestRename(missing[0], repo, root) : undefined;
				this.db.setPathState(m.store, m.id, m.hash, missing, suggestion);
				if (missing.length > 0) stale++;
			}
		});
		return { checked: rows.length, stale };
	}

	/** Forget cached git listings (e.g. at session start). */
	resetRepoCache(): void {
		clearRepoCache();
		this.ignoreCache.clear();
	}

	private ignoreCache = new Map<string, { at: number; problem: IgnoreProblem | undefined }>();

	/** Is the project's shared store ignored by git? Cached for a minute per project root. */
	sharedIgnored(root: string, fresh = false): IgnoreProblem | undefined {
		const hit = this.ignoreCache.get(root);
		if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.problem;
		let problem: IgnoreProblem | undefined;
		try {
			problem = checkSharedIgnored(root);
		} catch {
			problem = undefined;
		}
		this.ignoreCache.set(root, { at: Date.now(), problem });
		return problem;
	}

	// -------------------------------------------------------------------------
	// remember
	// -------------------------------------------------------------------------

	/** Normalize and safety-check a candidate. Throws CandidateError on refusal. */
	prepareCandidate(input: RememberInput, project: ProjectInfo | undefined, cwd: string): { candidate: Candidate; safety: RememberOutcome["safety"] } {
		let caption = stripInvisible(input.caption ?? "").replace(/\s+/g, " ").trim();
		let content = stripInvisible(input.content ?? "").trim();
		if (!caption) throw new CandidateError("caption is required");
		if (!content) throw new CandidateError("content is required");
		if (caption.length > MAX_CAPTION) throw new CandidateError(`caption is longer than ${MAX_CAPTION} characters; keep it to one short line`);
		if (content.length > MAX_CONTENT) throw new CandidateError(`content is longer than ${MAX_CONTENT} characters; store one focused fact per memory`);
		const report = scanAll(`${caption}\n${content}`);
		const safety = {
			secrets: [...new Set(report.secrets.map((s) => s.kind))],
			injections: [...new Set(report.injections.map((s) => s.kind))],
			redacted: false,
		};
		if (report.injections.length > 0) {
			throw new CandidateError(`refused: ${describeSafety({ secrets: [], injections: report.injections })}. Memories must be plain facts, not instructions aimed at an agent.`);
		}
		if (report.secrets.length > 0) {
			if (this.settings.safety.secretAction === "reject") {
				throw new CandidateError(
					`refused: ${describeSafety({ secrets: report.secrets, injections: [] })}. Never store credentials; describe where they live instead (e.g. "API key is in $FOO_API_KEY").`,
				);
			}
			caption = redactSecrets(caption);
			content = redactSecrets(content);
			safety.redacted = true;
			if (scanInjection(content).length > 0) throw new CandidateError("refused after redaction");
		}
		// Paths are resolved to absolute ones here; the chosen store stores them relative to
		// its root. No paths = the whole root (project root, or `~` for global memories).
		let paths: string[] | undefined;
		if (input.paths && input.paths.length > 0) {
			const abs = [...new Set(input.paths.map((p) => resolvePathArg(p, cwd)).filter((p): p is string => !!p && p !== "/"))];
			const wholeRoots = new Set([homeRoot(), ...(project ? [project.root] : [])]);
			// Naming a store root is the same as naming no path.
			paths = abs.length > 0 && !abs.every((p) => wholeRoots.has(p)) ? abs.filter((p) => !wholeRoots.has(p)).sort() : undefined;
		}
		return { candidate: { caption, content, paths, scopeHint: input.scope, source: input.source, force: input.force }, safety };
	}

	/** Find memories similar to a candidate (vector + BM25), for the judge. */
	async neighbors(ctx: ScopeContext, c: Candidate, trace: Trace, signal?: AbortSignal): Promise<{ neighbors: Neighbor[]; vec?: Float32Array }> {
		let vec: Float32Array | undefined;
		if (this.embedder.configured) {
			const t0 = Date.now();
			try {
				await this.index.embedMissing(signal);
				const r = await this.index.documentVector(c.caption, c.content, signal);
				vec = r.vec;
				trace.embed = { ms: Date.now() - t0, cached: r.cached, tokens: r.tokens, dims: r.vec.length };
			} catch (err) {
				if (signal?.aborted) throw err;
				// Embedding API down: judge against keyword (BM25) neighbours only; the new
				// memory is embedded later by the background pass.
				trace.embed = { ms: Date.now() - t0, cached: false, tokens: 0, dims: 0, error: err instanceof Error ? err.message : String(err) };
			}
		}
		const t1 = Date.now();
		const max = this.settings.candidates.max;
		const hits = this.index.hybrid(ctx.stores, {
			vectors: vec ? [vec] : [],
			texts: [c.caption, c.content],
			limit: max,
		});
		trace.search = {
			ms: Date.now() - t1,
			neighbors: hits.length,
			vecHits: hits.filter((h) => h.vecRank !== undefined).length,
			ftsHits: hits.filter((h) => h.ftsRank !== undefined).length,
		};
		let neighbors = hits.map((h) => ({ memory: h.memory, score: h.score, vecScore: h.vecScore, ftsScore: h.ftsScore }));
		if (c.paths && c.paths.length > 0) {
			// Memories about overlapping paths first: only they can be edited or merged.
			const overlaps = (m: MemoryRow) => pathsOverlap(c.paths, absoluteScopes(m, ctx.project?.root));
			neighbors = neighbors.map((n) => ({ ...n, score: overlaps(n.memory) ? n.score : n.score * 0.8 })).sort((a, b) => b.score - a.score);
		}
		return { neighbors, vec };
	}

	/** Ask SemIf. Splits questions over several requests when needed. */
	async judge(req: JudgeRequest, trace: Trace, signal?: AbortSignal): Promise<{ signals: Signals; responses: SemIfResponse[] }> {
		const t0 = Date.now();
		const responses: SemIfResponse[] = [];
		const traces: HttpTrace[] = [];
		const answers: SemIfResponse["answers"] = {};
		let inputTokens = 0;
		for (const chunk of chunkQuestions(req.questions, this.settings.semif.maxQuestions)) {
			const r = await this.semif.evaluate(req.state, chunk, signal);
			responses.push(r.response);
			traces.push(r.trace);
			Object.assign(answers, r.response.answers);
			inputTokens += r.response.usage?.input_tokens ?? 0;
		}
		trace.judge = { ms: Date.now() - t0, requests: responses.length, traces, inputTokens };
		return { signals: readSignals(answers), responses };
	}

	/**
	 * The remember path: safety → exact match → neighbors → SemIf judge → decision →
	 * (rewrite) → write. With `dryRun`, nothing is written.
	 */
	async remember(input: RememberInput, opts: RememberOptions): Promise<RememberOutcome> {
		this.reloadSettingsIfChanged();
		const ctx = this.scopes(opts.cwd);
		const step = opts.onStep ?? (() => {});
		const { candidate, safety } = this.prepareCandidate(input, ctx.project, opts.cwd);
		const trace: Trace = {};
		const outcome: RememberOutcome = { status: "skipped", candidate, neighbors: [], safety, trace, message: "" };
		if (candidate.scopeHint && !this.storeFor(ctx, candidate.scopeHint)) {
			throw new CandidateError(`scope ${SCOPE_LABEL[candidate.scopeHint]} is not available here (no project detected)`);
		}
		const scopes = ctx.stores.map((s) => s.kind);

		const run = async (): Promise<RememberOutcome> => {
			step("sync");
			this.index.sync(ctx.stores);
			const exact = this.db.getByHash(
				textHash(candidate.caption, candidate.content),
				ctx.stores.map((s) => s.id),
			);
			if (exact) {
				outcome.decision = decide({ candidate, neighbors: [], exact, scopes, projectRoot: ctx.project?.root }, this.settings.thresholds);
				return this.apply(outcome, ctx, opts);
			}
			try {
				step("embed + search");
				const { neighbors } = await this.neighbors(ctx, candidate, trace, opts.signal);
				outcome.neighbors = neighbors;
				step("judge");
				const req = buildJudgeRequest(
					candidate,
					neighbors,
					{ projectName: ctx.project?.name, isGit: ctx.project?.isGit, relCwd: ctx.project?.relCwd, projectRoot: ctx.project?.root, scopes },
					this.settings.candidates,
				);
				outcome.judgeRequest = req;
				const { signals, responses } = await this.judge(req, trace, opts.signal);
				outcome.signals = signals;
				outcome.judgeResponses = responses;
				outcome.decision = decide({ candidate, neighbors: req.included, signals, scopes, projectRoot: ctx.project?.root }, this.settings.thresholds);
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				if (opts.queueOnFailure && !opts.dryRun) {
					this.db.enqueuePending(ctx.project?.root, { input, cwd: opts.cwd }, msg);
					outcome.status = "queued";
					outcome.error = msg;
					outcome.message = this.semif.configured
						? `NOT stored yet: the memory judge is unreachable (${msg}). The fact was queued and will be retried automatically; no need to call again.`
						: "NOT stored yet: realmem is not set up (no SemIf judge endpoint). The fact was queued and will be processed once the user configures /realmem settings; no need to call again.";
					return outcome;
				}
				throw err;
			}
			return this.apply(outcome, ctx, opts);
		};

		if (opts.dryRun) return run();
		try {
			return await this.db.withLock(WRITE_LOCK, run, { signal: opts.signal });
		} catch (err) {
			// Another Pi process holds the write lock for too long: queue instead of failing.
			if (err instanceof LockTimeoutError && opts.queueOnFailure) {
				this.db.enqueuePending(ctx.project?.root, { input, cwd: opts.cwd }, err.message);
				outcome.status = "queued";
				outcome.error = err.message;
				outcome.message = `NOT stored yet: ${err.message}. The fact was queued and will be retried automatically; no need to call again.`;
				return outcome;
			}
			throw err;
		}
	}

	private async rewrite(mode: "edit" | "merge", target: MemoryRow, c: Candidate, opts: RememberOptions, trace: Trace): Promise<RewriteResult> {
		const t0 = Date.now();
		const req = { mode, target: { caption: target.caption, content: target.content }, candidate: { caption: c.caption, content: c.content }, signal: opts.signal };
		let result: RewriteResult;
		if (opts.rewriter) {
			try {
				result = await opts.rewriter(req);
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				result = fallbackRewrite(req);
				trace.rewrite = { ms: Date.now() - t0, model: result.model, fallback: err instanceof Error ? err.message : String(err) };
				return result;
			}
		} else {
			result = fallbackRewrite(req);
		}
		// The rewrite must not smuggle in secrets or injected instructions either.
		const report = scanAll(`${result.caption}\n${result.content}`);
		if (report.injections.length > 0 || (report.secrets.length > 0 && !scanAll(`${target.content}\n${c.content}`).secrets.length)) {
			const fb = fallbackRewrite(req);
			trace.rewrite = { ms: Date.now() - t0, model: fb.model, fallback: `rewrite rejected by safety scan: ${describeSafety(report)}` };
			return fb;
		}
		trace.rewrite = { ms: Date.now() - t0, model: result.model, usage: result.usage };
		return result;
	}

	private async apply(outcome: RememberOutcome, ctx: ScopeContext, opts: RememberOptions): Promise<RememberOutcome> {
		const d = outcome.decision;
		const c = outcome.candidate;
		if (!d) throw new Error("no decision");
		const dry = !!opts.dryRun;
		const label = (m: MemoryRow) => `${m.id} "${m.caption}" (${SCOPE_LABEL[m.kind]})`;
		switch (d.action) {
			case "reject":
				outcome.status = "rejected";
				outcome.message = `refused: ${d.reasons[d.reasons.length - 1]}`;
				return outcome;
			case "skip":
				outcome.status = "skipped";
				outcome.message = `not stored: ${d.reasons[d.reasons.length - 1].replace(/^→ skip: /, "")}`;
				return outcome;
			case "reinforce": {
				const t = d.target as MemoryRow;
				outcome.memory = t;
				if (dry) {
					outcome.status = "planned";
					outcome.message = `would reinforce ${label(t)}`;
					return outcome;
				}
				let widened = "";
				if (d.widen && d.paths) {
					// Same fact, more places: extend the memory's path scope instead of duplicating it.
					const store = this.storeById(ctx, t.store);
					if (store) {
						const add = toStoreScopes(d.paths, t.kind, ctx.project?.root);
						const paths = normalizePathScopes([...(t.paths ?? []), ...add], t.kind);
						this.index.writeMemory(store, { id: t.id, caption: t.caption, content: t.content, paths, created: t.created ?? undefined, updated: now() }, t.file);
						widened = `; paths now ${paths.join(", ")}`;
						void this.refreshUrgencyInBackground(opts.cwd);
					}
				}
				this.db.bumpUsage([t.id], "reinforce");
				outcome.memory = this.db.getById(t.id, [t.store]) ?? t;
				outcome.status = "reinforced";
				outcome.message = `already known: reinforced ${label(t)} (used ${outcome.memory.usedCount}×${widened})`;
				return outcome;
			}
			case "edit":
			case "merge": {
				const t = d.target as MemoryRow;
				opts.onStep?.(d.action === "edit" ? "rewrite (edit)" : "rewrite (merge)");
				const r = await this.rewrite(d.action, t, c, opts, outcome.trace);
				outcome.before = { caption: t.caption, content: t.content };
				outcome.proposed = { caption: r.caption, content: r.content };
				if (dry) {
					outcome.status = "planned";
					outcome.memory = t;
					outcome.message = `would ${d.action} ${label(t)}`;
					return outcome;
				}
				const store = this.storeById(ctx, t.store);
				if (!store) throw new Error(`store of ${t.id} is not visible from here`);
				// Unscoped candidate = scope unknown: keep the target's scope; scoped candidate: union.
				// Unscoped candidate = keep the target's scope; scoped candidate: union.
				const whole = t.kind === "global" ? "~" : ".";
				const extra = d.paths ? toStoreScopes(d.paths, t.kind, ctx.project?.root) : [];
				const paths = normalizePathScopes([...(t.paths ?? [whole]), ...extra], t.kind);
				const mem: MemoryFile = { id: t.id, caption: r.caption, content: r.content, paths, created: t.created ?? undefined, updated: now() };
				const row = this.index.writeMemory(store, mem, t.file);
				this.db.bumpUsage([row.id], "reinforce");
				outcome.memory = this.db.getByRid(row.rid) ?? row;
				outcome.status = d.action === "edit" ? "edited" : "merged";
				outcome.message = `${d.action === "edit" ? "updated" : "merged into"} ${label(outcome.memory)}`;
				void this.embedInBackground();
				if (!isWholeScope(outcome.memory.paths ?? undefined)) void this.refreshUrgencyInBackground(opts.cwd);
				return outcome;
			}
			case "add": {
				const store = this.storeFor(ctx, d.scope);
				if (!store) throw new Error(`scope ${d.scope} is not available`);
				const iso = now();
				const mem: MemoryFile = {
					id: newId(),
					caption: c.caption,
					content: c.content,
					paths: toStoreScopes(d.paths, d.scope, ctx.project?.root),
					created: iso,
					updated: iso,
				};
				outcome.proposed = { caption: mem.caption, content: mem.content };
				if (dry) {
					outcome.status = "planned";
					outcome.message = `would add to ${SCOPE_LABEL[d.scope]}`;
					return outcome;
				}
				if (store.kind === "personal" && ctx.project) writeProjectInfo(store.dir, ctx.project);
				const row = this.index.writeMemory(store, mem);
				if (d.urgency !== undefined && !isWholeScope(row.paths ?? undefined)) {
					this.db.setUrgency(row.store, row.id, d.urgency, "remember", urgencyBasis(row));
				}
				outcome.memory = row;
				outcome.status = "added";
				const where = !isWholeScope(row.paths ?? undefined) ? ` for ${row.paths?.join(", ")}` : "";
				outcome.message = `remembered ${label(row)}${where}`;
				if (row.kind === "shared" && ctx.project) {
					const ignored = this.sharedIgnored(ctx.project.root);
					if (ignored) outcome.message += ` (warning: ${store.dir} is ignored by git, so this memory will not be committed; see /realmem fix-gitignore)`;
				}
				void this.embedInBackground();
				return outcome;
			}
		}
	}

	/** Write a planned (dry-run) outcome for real, reusing its decision. */
	async commitPlanned(outcome: RememberOutcome, opts: RememberOptions): Promise<RememberOutcome> {
		const ctx = this.scopes(opts.cwd);
		return this.db.withLock(WRITE_LOCK, async () => {
			this.index.sync(ctx.stores);
			const d = outcome.decision;
			if (d?.target) {
				const fresh = this.db.getById(d.target.id, [d.target.store]);
				if (!fresh || fresh.hash !== d.target.hash) throw new CandidateError("target memory changed since the analysis; run it again");
			}
			const copy: RememberOutcome = { ...outcome, trace: { ...outcome.trace } };
			if (d && (d.action === "edit" || d.action === "merge") && outcome.proposed) {
				const proposed = outcome.proposed;
				return this.apply(copy, ctx, { ...opts, dryRun: false, rewriter: async () => ({ ...proposed, model: "planned" }) });
			}
			return this.apply(copy, ctx, { ...opts, dryRun: false });
		});
	}

	/** Retry queued candidates for the current project. */
	async drainPending(cwd: string, rewriter: Rewriter | undefined, signal?: AbortSignal): Promise<RememberOutcome[]> {
		if (!this.semif.configured) return [];
		const project = this.scopes(cwd).project;
		const out: RememberOutcome[] = [];
		for (const p of this.db.listPending(project?.root, 20)) {
			const payload = p.payload as { input?: RememberInput; cwd?: string };
			if (!payload?.input) {
				this.db.deletePending(p.seq);
				continue;
			}
			try {
				const r = await this.remember(payload.input, { cwd: payload.cwd ?? cwd, rewriter, signal, queueOnFailure: false });
				this.db.deletePending(p.seq);
				out.push(r);
			} catch (err) {
				if (err instanceof CandidateError) this.db.deletePending(p.seq);
				else {
					this.db.failPending(p.seq, err instanceof Error ? err.message : String(err));
					break; // judge still down: stop for now
				}
			}
		}
		return out;
	}

	// -------------------------------------------------------------------------
	// manual edits (manage page)
	// -------------------------------------------------------------------------

	async updateMemory(cwd: string, row: MemoryRow, patch: { caption?: string; content?: string; paths?: string[] }): Promise<MemoryRow> {
		const ctx = this.scopes(cwd);
		return this.db.withLock(WRITE_LOCK, async () => {
			const store = this.storeById(ctx, row.store);
			if (!store) throw new Error("memory store not visible from here");
			const caption = (patch.caption ?? row.caption).replace(/\s+/g, " ").trim();
			const content = (patch.content ?? row.content).trim();
			if (!caption || !content) throw new CandidateError("caption and content must not be empty");
			const mem: MemoryFile = {
				id: row.id,
				caption,
				content,
				paths: normalizePathScopes(patch.paths ?? row.paths ?? [row.kind === "global" ? "~" : "."], row.kind),
				created: row.created ?? undefined,
				updated: now(),
			};
			const out = this.index.writeMemory(store, mem, row.file);
			void this.embedInBackground();
			return out;
		});
	}

	async moveMemory(cwd: string, row: MemoryRow, kind: ScopeKind): Promise<MemoryRow> {
		const ctx = this.scopes(cwd);
		return this.db.withLock(WRITE_LOCK, async () => {
			const dest = this.storeFor(ctx, kind);
			if (!dest) throw new Error(`scope ${kind} is not available here`);
			if (dest.id === row.store) return row;
			const mem: MemoryFile = {
				id: row.id,
				caption: row.caption,
				content: row.content,
				// Re-express the paths in the destination's frame (e.g. project-relative → `~/…`).
				paths: toStoreScopes(absoluteScopes(row, ctx.project?.root), kind, ctx.project?.root),
				created: row.created ?? undefined,
				updated: now(),
			};
			if (dest.kind === "personal" && ctx.project) writeProjectInfo(dest.dir, ctx.project);
			const out = this.index.writeMemory(dest, mem);
			this.index.deleteMemory(row);
			void this.embedInBackground();
			return out;
		});
	}

	async deleteMemory(row: MemoryRow): Promise<void> {
		await this.db.withLock(WRITE_LOCK, async () => this.index.deleteMemory(row));
	}

	// -------------------------------------------------------------------------
	// status
	// -------------------------------------------------------------------------

	status(cwd: string): Record<string, unknown> {
		const ctx = this.scopes(cwd);
		this.sync(cwd);
		const fp = embeddingFingerprint(this.settings);
		const perStore = ctx.stores.map((s) => ({
			scope: SCOPE_LABEL[s.kind],
			dir: s.dir,
			memories: this.db.count([s.id]),
			quarantined: this.db.countFlagged([s.id]),
		}));
		const projectStores = ctx.stores.map((s) => s.id);
		const scoped = this.db.pathScoped(projectStores);
		return {
			project: ctx.project ? { name: ctx.project.name, root: ctx.project.root, key: ctx.project.key, relCwd: ctx.project.relCwd } : null,
			gitignore: ctx.project?.isGit ? (() => {
				const p = this.sharedIgnored(ctx.project.root);
				return p ? describeIgnoreProblem(p) : null;
			})() : null,
			stores: perStore,
			paths: {
				scoped: scoped.length,
				unjudged: scoped.filter((m) => m.urgency === undefined).length,
				stale: this.db.stalePathIds(projectStores).size,
				inject: this.settings.paths.inject,
			},
			embeddings: { ...this.db.embeddingStats(fp), fingerprint: fp, sqliteVec: this.db.vecAvailable ? "loaded" : `unavailable (${this.db.vecError})` },
			pending: this.db.countPending(),
			config: {
				embedding: this.embedder.configured ? this.settings.embedding.endpoint : null,
				semif: this.semif.configured ? this.settings.semif.endpoint : null,
				rewriteModel: this.settings.rewriteModel || null,
			},
			writeLock: this.db.lockHolder(WRITE_LOCK) ?? null,
		};
	}
}
