/**
 * realmem engine: ties together settings, stores, index, judge and rewriter.
 * One instance per Pi process; stateless with respect to the working directory
 * (every call passes the cwd so multiple sessions can share it).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { type Completer, fallbackRewrite, type RewriteRequest, type RewriteResult, type Rewriter } from "./rewrite.ts";
import { describeSafety, redactSecrets, sanitizeForPrompt, scanAll, scanInjection, stripInvisible } from "./safety.ts";
import { checkSharedIgnored, describeIgnoreProblem, type IgnoreProblem } from "./gitignore.ts";
import { MemoryIndex, type RankedHit, type SyncReport } from "./store.ts";
import { sha256, textHash } from "./text.ts";
import {
	buildPathsPrompt,
	buildReviewRequest,
	buildSummaryPrompt,
	type ConsolidationOp,
	type ConsolidationPlan,
	type ConsolidationProposal,
	type MemoryView,
	decideReview,
	PATHS_SYSTEM,
	type PlannedMemory,
	type ProposalAnswer,
	parsePathsAnswer,
	readReview,
	type ReviewNeighbor,
	renderTree,
	SUMMARY_SYSTEM,
	samePaths,
	walkFiles,
} from "./consolidate.ts";
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

/**
 * Run a rewrite through the model, falling back to the deterministic rewrite when the
 * model fails or its answer smuggles in secrets or injected instructions.
 */
export async function safeRewrite(req: RewriteRequest, rewriter: Rewriter | undefined, signal?: AbortSignal): Promise<{ result: RewriteResult; fallback?: string }> {
	if (!rewriter) return { result: fallbackRewrite(req) };
	let result: RewriteResult;
	try {
		result = await rewriter(req);
	} catch (err) {
		if (signal?.aborted) throw err;
		return { result: fallbackRewrite(req), fallback: err instanceof Error ? err.message : String(err) };
	}
	const report = scanAll(`${result.caption}\n${result.content}`);
	const inputs = `${req.target.content}\n${req.candidate?.content ?? ""}`;
	if (report.injections.length > 0 || (report.secrets.length > 0 && !scanAll(inputs).secrets.length)) {
		return { result: fallbackRewrite(req), fallback: `rewrite rejected by safety scan: ${describeSafety(report)}` };
	}
	return { result };
}

export interface ConsolidateOptions {
	cwd: string;
	/** Only these scopes (default: every store visible from cwd). */
	scopes?: ScopeKind[];
	/** Edit/Merge model for merges, supersedes and revisions (fallbacks without it). */
	rewriter?: Rewriter;
	/** Edit/Merge model as a plain completer, for the repository summary and path revision. */
	completer?: Completer;
	/** Revise project memories' paths (default: settings.consolidate.paths). */
	paths?: boolean;
	signal?: AbortSignal;
	onStep?: (step: string) => void;
}

export interface InteractiveConsolidateOptions extends ConsolidateOptions {
	/** Asked before each step; an accepted step is written at once, "stop" ends the run. */
	approve: (p: ConsolidationProposal) => Promise<ProposalAnswer>;
	/** Called after each write with the running totals. */
	onWritten?: (done: ConsolidationResult) => void;
}

export interface ConsolidationResult {
	updated: number;
	deleted: number;
	/** Memories skipped because they changed after the plan was made. */
	stale: string[];
}

export interface InteractiveConsolidationResult extends ConsolidationResult {
	/** Steps proposed, accepted and skipped. */
	proposed: number;
	accepted: number;
	skipped: number;
	stopped: boolean;
	reviewed: number;
	total: number;
	warnings: string[];
}

const SUMMARY_META = "consolidate-summary:";

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
				if (a?.type === "score") this.db.setUrgency(m.store, m.id, a.score, "judge", urgencyBasis(m), { probabilities: a.probabilities, confidence: a.confidence });
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
	checkPaths(cwd: string, force = false): { checked: number; stale: number } {
		const ctx = this.scopes(cwd);
		if (!force && !this.settings.paths.staleCheck) return { checked: 0, stale: 0 };
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

	/**
	 * Drop paths that no longer exist from path-scoped memories; a memory whose paths are
	 * all gone is deleted. `dryRun` only reports what would change.
	 */
	async prunePaths(
		cwd: string,
		opts: { dryRun?: boolean } = {},
	): Promise<{ updated: Array<{ memory: MemoryRow; removed: string[] }>; deleted: MemoryRow[] }> {
		this.sync(cwd);
		this.resetRepoCache();
		this.checkPaths(cwd, true);
		const ctx = this.scopes(cwd);
		const updated: Array<{ memory: MemoryRow; removed: string[] }> = [];
		const deleted: MemoryRow[] = [];
		for (const s of this.db.scopedPaths(ctx.stores.map((x) => x.id))) {
			const missing = this.db.getPathState(s.store, s.id)?.missing ?? [];
			if (missing.length === 0) continue;
			const row = this.db.getById(s.id, [s.store]);
			if (!row) continue;
			const keep = (row.paths ?? []).filter((p) => !missing.includes(p));
			if (keep.length === 0) {
				if (!opts.dryRun) await this.deleteMemory(row);
				deleted.push(row);
			} else {
				const out = opts.dryRun ? row : await this.updateMemory(cwd, row, { paths: keep });
				updated.push({ memory: out, removed: missing });
			}
		}
		if (!opts.dryRun && updated.length > 0) this.checkPaths(cwd, true);
		return { updated, deleted };
	}

	/** Delete memories by id (full id or unique prefix). */
	async forget(cwd: string, ids: string[]): Promise<{ deleted: MemoryRow[]; missing: string[] }> {
		const { found, missing } = this.getMemories(cwd, ids, false);
		for (const m of found) await this.deleteMemory(m);
		return { deleted: found, missing };
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
		const { result, fallback } = await safeRewrite(req, opts.rewriter, opts.signal);
		trace.rewrite = fallback ? { ms: Date.now() - t0, model: result.model, fallback } : { ms: Date.now() - t0, model: result.model, usage: result.usage };
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
					this.db.setUrgency(row.store, row.id, d.urgency, "remember", urgencyBasis(row), { probabilities: d.urgencyProbs, confidence: d.urgencyConfidence });
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

	/** Number of queued candidates belonging to the project of `cwd`. */
	pendingCount(cwd: string): number {
		return this.db.countPending(this.scopes(cwd).project?.root);
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
	// consolidation
	// -------------------------------------------------------------------------

	/**
	 * Plan a consolidation without writing anything: SemIf reviews each memory against
	 * its most similar neighbours in the same store (least used first, so they fold into
	 * the more used ones) and decides forget / fold (covered, merge, supersede) / revise /
	 * keep; the Edit/Merge model writes merged and revised texts; then, for project
	 * memories, it summarises the repository's file tree and revises their paths.
	 */
	async planConsolidation(opts: ConsolidateOptions): Promise<ConsolidationPlan> {
		return (await this.runConsolidation(opts)).plan;
	}

	/**
	 * Interactive consolidation: the same review as planConsolidation, but every step is
	 * shown to opts.approve with its full before/after text and, when accepted, written at
	 * once, so later steps see the written state. Steps written before a stop, a cancel or
	 * an error stay written.
	 */
	async consolidate(opts: InteractiveConsolidateOptions): Promise<InteractiveConsolidationResult> {
		const tally: Omit<InteractiveConsolidationResult, "reviewed" | "total" | "warnings"> = { proposed: 0, accepted: 0, skipped: 0, stopped: false, updated: 0, deleted: 0, stale: [] };
		try {
			const { plan } = await this.runConsolidation(opts, opts, tally);
			return { ...tally, reviewed: plan.reviewed, total: plan.total, warnings: plan.warnings };
		} finally {
			if (tally.updated + tally.deleted > 0) this.afterConsolidation(opts.cwd);
		}
	}

	private async runConsolidation(
		opts: ConsolidateOptions,
		interactive?: InteractiveConsolidateOptions,
		tally: Omit<InteractiveConsolidationResult, "reviewed" | "total" | "warnings"> = { proposed: 0, accepted: 0, skipped: 0, stopped: false, updated: 0, deleted: 0, stale: [] },
	): Promise<{ plan: ConsolidationPlan }> {
		this.reloadSettingsIfChanged();
		if (!this.semif.configured) throw new CandidateError("consolidation needs the SemIf judge (set its endpoint in /realmem settings)");
		const step = opts.onStep ?? (() => {});
		const ctx = this.scopes(opts.cwd);
		this.sync(opts.cwd);
		const stores = ctx.stores.filter((s) => !opts.scopes || opts.scopes.includes(s.kind));
		const cfg = this.settings.consolidate;
		const ops: ConsolidationOp[] = [];
		const warnings: string[] = [];
		const live = new Map<string, PlannedMemory>();
		const deleted = new Map<string, MemoryRow>();
		const rows: MemoryRow[] = [];
		for (const s of stores) {
			for (let offset = 0; ; offset += 500) {
				const batch = this.db.list([s.id], { limit: 500, offset, order: "used" });
				rows.push(...batch);
				if (batch.length < 500) break;
			}
		}
		const whole = (k: ScopeKind) => [k === "global" ? "~" : "."];
		const fromRow = (r: MemoryRow): PlannedMemory => ({ row: r, caption: r.caption, content: r.content, paths: r.paths ?? whole(r.kind), usageAdd: 0 });
		const view = (m: PlannedMemory): MemoryView => ({ id: m.row.id, caption: m.caption, content: m.content, paths: m.paths });
		for (const r of rows) live.set(r.id, fromRow(r));

		/** Ask about a step before it changes anything; false = skipped or stopped. */
		const ask = async (op: ConsolidationOp, before: PlannedMemory[], after: MemoryView | undefined, progress: string): Promise<boolean> => {
			if (!interactive) return true;
			tally.proposed++;
			const answer = await interactive.approve({ op, before: before.map(view), after, progress });
			if (answer === "accept") tally.accepted++;
			else if (answer === "stop") tally.stopped = true;
			else tally.skipped++;
			return answer === "accept";
		};
		/** Record a step (already applied to the simulated state); interactive runs write it at once. */
		const commit = async (op: ConsolidationOp, changed: PlannedMemory[], removed: MemoryRow[]): Promise<void> => {
			ops.push(op);
			for (const r of removed) {
				live.delete(r.id);
				deleted.set(r.id, r);
			}
			if (!interactive) return;
			const r = await this.db.withLock(WRITE_LOCK, async () => {
				this.index.sync(ctx.stores);
				return this.writeConsolidation(ctx, { ops: [op], changed, deleted: removed });
			});
			tally.updated += r.updated;
			tally.deleted += r.deleted;
			tally.stale.push(...r.stale);
			// Later steps compare against what is on disk now (a stale memory keeps its edited text).
			for (const m of [...changed.map((c) => c.row), ...removed]) {
				const f = this.db.getById(m.id, [m.store]);
				if (!f) {
					live.delete(m.id);
					continue;
				}
				live.set(m.id, fromRow(f));
				deleted.delete(m.id);
			}
			interactive.onWritten?.({ updated: tally.updated, deleted: tally.deleted, stale: [...tally.stale] });
		};

		// Least used first: weak memories are folded into strong ones, not the other way round.
		const order = [...rows].sort((a, b) => a.usedCount - b.usedCount || (a.updated ?? "").localeCompare(b.updated ?? ""));
		const unionPaths = (into: PlannedMemory, from: PlannedMemory): string[] =>
			isWholeScope(from.paths) || isWholeScope(into.paths) ? into.paths : normalizePathScopes([...into.paths, ...from.paths], into.row.kind);
		let reviewed = 0;
		for (const r of order) {
			if (opts.signal?.aborted) throw new Error("aborted");
			if (tally.stopped) break;
			const m = live.get(r.id);
			if (!m) continue;
			reviewed++;
			const progress = `review ${reviewed}/${rows.length}`;
			step(`reviewing ${reviewed}/${rows.length}`);
			// Neighbours from the same store only, so folding never moves facts between scopes.
			let vectors: Float32Array[] = [];
			if (this.embedder.configured) {
				try {
					vectors = [(await this.index.documentVector(m.caption, m.content, opts.signal)).vec];
				} catch (err) {
					if (opts.signal?.aborted) throw err;
				}
			}
			const store = stores.find((s) => s.id === r.store);
			if (!store) continue;
			const hits = this.index.hybrid([store], { vectors, texts: [m.caption, m.content], limit: cfg.neighbors + 1 });
			const neighbors: ReviewNeighbor[] = [];
			for (const h of hits) {
				const n = live.get(h.memory.id);
				if (!n || n.row.id === m.row.id || n.row.store !== m.row.store) continue;
				neighbors.push({ id: n.row.id, kind: n.row.kind, caption: n.caption, content: n.content, paths: n.paths });
			}
			const req = buildReviewRequest(m, neighbors.slice(0, cfg.neighbors), { projectName: ctx.project?.name }, { ...this.settings.candidates, maxNeighbors: cfg.neighbors });
			const answers: SemIfResponse["answers"] = {};
			for (const chunk of chunkQuestions(req.questions, this.settings.semif.maxQuestions)) {
				Object.assign(answers, (await this.semif.evaluate(req.state, chunk, opts.signal)).response.answers);
			}
			const included = new Set(req.included.map((n) => n.id));
			const d = decideReview(readReview(answers), { ...this.settings.thresholds, ...cfg }, (id) => included.has(id) && live.has(id));
			if (d.action === "keep") continue;
			if (d.action === "forget") {
				const op: ConsolidationOp = { kind: "forget", id: m.row.id, caption: m.caption, reason: d.reason };
				if (await ask(op, [m], undefined, progress)) await commit(op, [], [m.row]);
				continue;
			}
			if (d.action === "revise") {
				step(`revising ${m.row.id.slice(0, 8)}`);
				const { result, fallback } = await safeRewrite({ mode: "revise", target: { caption: m.caption, content: m.content }, signal: opts.signal }, opts.rewriter, opts.signal);
				if (fallback) warnings.push(`revise ${m.row.id}: ${fallback}`);
				if (result.caption === m.caption && result.content === m.content) continue;
				const op: ConsolidationOp = { kind: "revise", id: m.row.id, before: m.caption, caption: result.caption, reason: d.reason, model: result.model };
				if (!(await ask(op, [m], { ...view(m), caption: result.caption, content: result.content }, progress))) continue;
				m.caption = result.caption;
				m.content = result.content;
				await commit(op, [m], []);
				continue;
			}
			// Fold m into the neighbour d.target (covered, merge or supersede).
			const t = live.get(d.target) as PlannedMemory;
			let caption = t.caption;
			let content = t.content;
			let model: string | undefined;
			if (d.action !== "covered") {
				step(`${d.action === "merge" ? "merging" : "superseding"} ${m.row.id.slice(0, 8)}`);
				// Supersede: the more recently updated memory states the current truth.
				const mNewer = (m.row.updated ?? "") >= (t.row.updated ?? "");
				const pair =
					d.action === "merge"
						? { mode: "merge" as const, target: t, candidate: m }
						: { mode: "edit" as const, target: mNewer ? t : m, candidate: mNewer ? m : t };
				const { result, fallback } = await safeRewrite(
					{
						mode: pair.mode,
						target: { caption: pair.target.caption, content: pair.target.content },
						candidate: { caption: pair.candidate.caption, content: pair.candidate.content },
						signal: opts.signal,
					},
					opts.rewriter,
					opts.signal,
				);
				if (fallback) warnings.push(`${d.action} ${m.row.id} → ${t.row.id}: ${fallback}`);
				caption = result.caption;
				content = result.content;
				model = result.model;
			}
			const paths = unionPaths(t, m);
			const op: ConsolidationOp = { kind: "fold", how: d.action, from: m.row.id, into: t.row.id, fromCaption: m.caption, caption, reason: d.reason, model };
			if (!(await ask(op, [m, t], { id: t.row.id, caption, content, paths }, progress))) continue;
			t.caption = caption;
			t.content = content;
			t.paths = paths;
			t.usageAdd += m.row.usedCount + m.usageAdd;
			await commit(op, [t], [m.row]);
		}

		let repoSummary: string | undefined;
		const project = ctx.project;
		const projectMems = [...live.values()].filter((m) => m.row.kind !== "global");
		if ((opts.paths ?? cfg.paths) && project && projectMems.length > 0 && !tally.stopped) {
			if (!opts.completer) warnings.push("paths not revised: no Edit/Merge model is available");
			else {
				try {
					repoSummary = await this.revisePaths(project.root, project.name, project.isGit, projectMems, opts, warnings, async (op, m, after, progress) => {
						if (!(await ask(op, [m], { ...view(m), paths: after }, progress))) return !tally.stopped;
						m.paths = after;
						await commit(op, [m], []);
						return true;
					});
				} catch (err) {
					if (opts.signal?.aborted) throw err;
					warnings.push(`paths not revised: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		const changed = [...live.values()].filter(
			(m) => m.caption !== m.row.caption || m.content !== m.row.content || !samePaths(m.paths, m.row.paths ?? whole(m.row.kind)) || m.usageAdd > 0,
		);
		return { plan: { stores: stores.map((s) => s.id), total: rows.length, reviewed, ops, changed, deleted: [...deleted.values()], repoSummary, warnings } };
	}

	/** Summarise the repository (cached per file tree) and let the model revise the memories' paths. */
	private async revisePaths(
		root: string,
		name: string,
		isGit: boolean,
		mems: PlannedMemory[],
		opts: ConsolidateOptions,
		warnings: string[],
		/** Propose one path change; returns false to stop. */
		propose: (op: ConsolidationOp, m: PlannedMemory, after: string[], progress: string) => Promise<boolean>,
	): Promise<string> {
		const complete = opts.completer as Completer;
		const cfg = this.settings.consolidate;
		const step = opts.onStep ?? (() => {});
		this.resetRepoCache();
		const git = repoFiles(root, isGit);
		const repo = git.files ? git : { ...git, files: walkFiles(root) };
		const tree = renderTree(repo.files ?? [], cfg.treeLines);
		const key = `${SUMMARY_META}${root}`;
		const treeHash = sha256(tree);
		let summary: string | undefined;
		try {
			const cached = JSON.parse(this.db.getMeta(key) ?? "null") as { tree?: string; summary?: string } | null;
			if (cached?.tree === treeHash && cached.summary) summary = cached.summary;
		} catch {
			// recompute
		}
		if (!summary) {
			step("summarising the repository");
			let readme: string | undefined;
			for (const f of ["README.md", "README", "readme.md", "README.rst"]) {
				try {
					readme = readFileSync(join(root, f), "utf8");
					break;
				} catch {
					// next
				}
			}
			const r = await complete({ system: SUMMARY_SYSTEM, prompt: buildSummaryPrompt(name, tree, readme), maxTokens: 2048, signal: opts.signal });
			summary = r.text.trim();
			if (!summary) throw new Error("the model returned an empty repository summary");
			this.db.setMeta(key, JSON.stringify({ tree: treeHash, summary, at: now() }));
		}
		const exists = (scope: string) => scopeExists(root, scope, repo);
		for (let i = 0; i < mems.length; i += cfg.pathBatch) {
			if (opts.signal?.aborted) throw new Error("aborted");
			const batch = mems.slice(i, i + cfg.pathBatch);
			step(`revising paths ${Math.min(i + batch.length, mems.length)}/${mems.length}`);
			const prompt = buildPathsPrompt(
				summary,
				tree,
				batch.map((m) => ({ id: m.row.id, caption: m.caption, content: m.content, paths: m.paths, missing: m.paths.filter((p) => !exists(p)) })),
			);
			let text: string;
			try {
				text = (await complete({ system: PATHS_SYSTEM, prompt, maxTokens: 4096, cache: true, signal: opts.signal })).text;
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				warnings.push(`paths of ${batch.length} memories not revised: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			const answer = parsePathsAnswer(text, batch.map((m) => m.row.id), exists);
			if (answer.size === 0) warnings.push(`paths of ${batch.length} memories not revised: the model gave no usable answer`);
			for (const m of batch) {
				const next = answer.get(m.row.id);
				if (!next || samePaths(next, m.paths)) continue;
				const op: ConsolidationOp = { kind: "paths", id: m.row.id, caption: m.caption, before: m.paths, after: next };
				if (!(await propose(op, m, next, `paths ${mems.indexOf(m) + 1}/${mems.length}`))) return summary;
			}
		}
		return summary;
	}

	/** Write a consolidation plan. Memories changed since the plan was made are left alone. */
	async applyConsolidation(cwd: string, plan: ConsolidationPlan): Promise<ConsolidationResult> {
		const ctx = this.scopes(cwd);
		const out = await this.db.withLock(WRITE_LOCK, async () => {
			this.index.sync(ctx.stores);
			return this.writeConsolidation(ctx, plan);
		});
		this.afterConsolidation(cwd);
		return out;
	}

	/** Write (part of) a plan; call under WRITE_LOCK after syncing the index. */
	private writeConsolidation(ctx: ScopeContext, plan: Pick<ConsolidationPlan, "ops" | "changed" | "deleted">): ConsolidationResult {
		const stale: string[] = [];
		const fresh = (r: MemoryRow) => {
			const f = this.db.getById(r.id, [r.store]);
			return f && f.hash === r.hash && JSON.stringify(f.paths ?? null) === JSON.stringify(r.paths ?? null) ? f : undefined;
		};
		const whole = (k: ScopeKind) => [k === "global" ? "~" : "."];
		let updated = 0;
		let removed = 0;
		const notWritten = new Set<string>();
		for (const m of plan.changed) {
			const f = fresh(m.row);
			const store = this.storeById(ctx, m.row.store);
			if (!f || !store) {
				stale.push(m.row.id);
				notWritten.add(m.row.id);
				continue;
			}
			const textChanged = m.caption !== f.caption || m.content !== f.content || !samePaths(m.paths, f.paths ?? whole(f.kind));
			if (textChanged) {
				this.index.writeMemory(
					store,
					{ id: f.id, caption: m.caption, content: m.content, paths: normalizePathScopes(m.paths, f.kind), created: f.created ?? undefined, updated: now() },
					f.file,
				);
				updated++;
			}
			if (m.usageAdd > 0) this.db.bumpUsage([f.id], "reinforce", m.usageAdd);
		}
		// A memory folded into another is only deleted when the memory that absorbed it was written.
		const into = new Map<string, string>();
		for (const op of plan.ops) if (op.kind === "fold") into.set(op.from, op.into);
		const finalTarget = (id: string) => {
			let cur = id;
			for (let i = 0; i < 1000 && into.has(cur); i++) cur = into.get(cur) as string;
			return cur;
		};
		for (const r of plan.deleted) {
			const f = fresh(r);
			if (!f || (into.has(r.id) && notWritten.has(finalTarget(r.id)))) {
				stale.push(r.id);
				continue;
			}
			this.index.deleteMemory(f);
			removed++;
		}
		return { updated, deleted: removed, stale };
	}

	/** Background work after consolidation writes: embeddings, path urgency, path checks. */
	private afterConsolidation(cwd: string): void {
		void this.embedInBackground();
		void this.refreshUrgencyInBackground(cwd);
		try {
			this.checkPaths(cwd, true);
		} catch {
			// git unavailable
		}
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
			pending: this.db.countPending(ctx.project?.root),
			config: {
				embedding: this.embedder.configured ? this.settings.embedding.endpoint : null,
				semif: this.semif.configured ? this.settings.semif.endpoint : null,
				rewriteModel: this.settings.rewriteModel || null,
			},
			writeLock: this.db.lockHolder(WRITE_LOCK) ?? null,
		};
	}
}
