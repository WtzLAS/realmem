import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SecretAction = "reject" | "redact";
export type StripMode = "imported" | "always" | "never";

export interface Settings {
	embedding: {
		/** Base URL, with or without a trailing `/v1`. */
		endpoint: string;
		/** API key; `$VAR` or `env:VAR` reads an environment variable. */
		apiKey: string;
		model: string;
		/** Matryoshka dimensions (32..4096). */
		dimensions: number;
		/** Instruction used when embedding recall queries. */
		queryInstruction: string;
		timeoutMs: number;
		/** Max inputs per embedding request. */
		batchSize: number;
	};
	semif: {
		endpoint: string;
		apiKey: string;
		model: string;
		timeoutMs: number;
		/** Questions per /v1/systemone request (the server's --max-questions). */
		maxQuestions: number;
	};
	/** `provider/model` used for Edit and Merge rewrites. Empty = current session model. */
	rewriteModel: string;
	thresholds: {
		/** Minimum expected importance (0..3 score) to Add or Merge. */
		minImportance: number;
		/** Minimum P(durable) to change the memory base (Reinforce is exempt). */
		minDurable: number;
		/** Maximum P(unsafe) (secret or prompt injection per SemIf) before a candidate is refused. */
		maxUnsafe: number;
		/** Minimum probability for a `covered_by` pick to count. */
		covered: number;
		/** Minimum probability for a `conflict_with` pick to count. */
		conflict: number;
		/** Minimum probability for a `merge_with` pick to count. */
		merge: number;
		/** Minimum scope probability for moving a fact out of its target's store (Add instead of Edit/Merge). */
		scopeMove: number;
		/** Minimum cosine similarity for a vector hit to count as relevant during recall. */
		recallMinSimilarity: number;
	};
	candidates: {
		/** Max similar memories sent to SemIf (1..254). */
		max: number;
		/** Approximate token budget for the SemIf state (each question prompt must fit the server cache). */
		stateTokenBudget: number;
		/** Max characters of one memory's content inside the SemIf state. */
		perMemoryChars: number;
	};
	recall: {
		pageSize: number;
		/** Size of the relevant set that is then ordered by used_count and paginated. */
		maxResults: number;
	};
	list: {
		pageSize: number;
	};
	prompt: {
		/** Number of most-used captions injected into the session system prompt. */
		topCaptions: number;
		/**
		 * Remove AGENTS.md / CLAUDE.md context files from the system prompt:
		 * `imported` = only files whose current content was imported with /realmem import.
		 */
		stripContextFiles: StripMode;
		/** Tools of other memory systems to deactivate at session start. */
		hideTools: string[];
	};
	safety: {
		secretAction: SecretAction;
	};
}

export const DEFAULT_SETTINGS: Settings = {
	embedding: {
		endpoint: "",
		apiKey: "",
		model: "Qwen/Qwen3-Embedding-8B",
		dimensions: 1024,
		queryInstruction: "Given a question or keywords about a software project, retrieve memory notes that answer it",
		timeoutMs: 60_000,
		batchSize: 32,
	},
	semif: {
		endpoint: "",
		apiKey: "",
		model: "semif-exl3-bridge",
		timeoutMs: 180_000,
		maxQuestions: 16,
	},
	rewriteModel: "",
	thresholds: {
		minImportance: 0.8,
		minDurable: 0.5,
		maxUnsafe: 0.5,
		covered: 0.5,
		conflict: 0.5,
		merge: 0.5,
		scopeMove: 0.7,
		recallMinSimilarity: 0.35,
	},
	candidates: {
		max: 40,
		stateTokenBudget: 7000,
		perMemoryChars: 800,
	},
	recall: {
		pageSize: 8,
		maxResults: 32,
	},
	list: {
		pageSize: 50,
	},
	prompt: {
		topCaptions: 20,
		stripContextFiles: "imported",
		hideTools: ["ctx_memory"],
	},
	safety: {
		secretAction: "reject",
	},
};

export function agentDirFromEnv(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return resolve(env.replace(/^~(?=$|[\\/])/, homedir()));
	return join(homedir(), ".pi", "agent");
}

export interface RealmemPaths {
	base: string;
	config: string;
	db: string;
	globalDir: string;
	personalRoot: string;
}

export function realmemPaths(base: string): RealmemPaths {
	return {
		base,
		config: join(base, "config.json"),
		db: join(base, "realmem.sqlite"),
		globalDir: join(base, "global"),
		personalRoot: join(base, "personal"),
	};
}

/** Project-relative directory of the shared (git-synced) store. */
export const SHARED_SUBDIR = join(".pi", "realmem");

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeInto<T>(defaults: T, patch: unknown): T {
	if (!isObject(defaults) || !isObject(patch)) {
		if (patch === undefined || patch === null) return defaults;
		if (Array.isArray(defaults)) return (Array.isArray(patch) ? patch.filter((x) => typeof x === "string") : defaults) as T;
		if (typeof patch === typeof defaults) return patch as T;
		return defaults;
	}
	const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
	for (const key of Object.keys(defaults as Record<string, unknown>)) {
		out[key] = mergeInto((defaults as Record<string, unknown>)[key], patch[key]);
	}
	return out as T;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

export function normalizeSettings(raw: unknown): Settings {
	const s = mergeInto(structuredClone(DEFAULT_SETTINGS), raw);
	s.embedding.dimensions = Math.round(clamp(s.embedding.dimensions, 32, 4096));
	s.embedding.batchSize = Math.round(clamp(s.embedding.batchSize, 1, 2048));
	s.embedding.timeoutMs = Math.round(clamp(s.embedding.timeoutMs, 1000, 600_000));
	s.semif.timeoutMs = Math.round(clamp(s.semif.timeoutMs, 1000, 1_800_000));
	s.semif.maxQuestions = Math.round(clamp(s.semif.maxQuestions, 1, 64));
	for (const k of ["covered", "conflict", "merge", "scopeMove", "minDurable", "maxUnsafe", "recallMinSimilarity"] as const) {
		s.thresholds[k] = clamp(s.thresholds[k], 0, 1);
	}
	s.thresholds.minImportance = clamp(s.thresholds.minImportance, 0, 3);
	s.candidates.max = Math.round(clamp(s.candidates.max, 1, 254));
	s.candidates.stateTokenBudget = Math.round(clamp(s.candidates.stateTokenBudget, 500, 1_000_000));
	s.candidates.perMemoryChars = Math.round(clamp(s.candidates.perMemoryChars, 80, 20_000));
	s.recall.pageSize = Math.round(clamp(s.recall.pageSize, 1, 100));
	s.recall.maxResults = Math.round(clamp(s.recall.maxResults, 1, 500));
	s.list.pageSize = Math.round(clamp(s.list.pageSize, 1, 500));
	s.prompt.topCaptions = Math.round(clamp(s.prompt.topCaptions, 0, 200));
	if (s.safety.secretAction !== "redact") s.safety.secretAction = "reject";
	if (!["imported", "always", "never"].includes(s.prompt.stripContextFiles)) s.prompt.stripContextFiles = "imported";
	return s;
}

export function loadSettings(file: string): Settings {
	if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
	try {
		return normalizeSettings(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return structuredClone(DEFAULT_SETTINGS);
	}
}

export function saveSettings(file: string, settings: Settings): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort
	}
}

export function settingsMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/** Resolve `$VAR` / `env:VAR` references. */
export function resolveSecret(value: string): string {
	const v = value.trim();
	const m = /^(?:\$\{?|env:)([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v);
	if (m) return process.env[m[1]] ?? "";
	return v;
}

/** Normalize an API base URL: strip trailing slashes and a trailing `/v1`. */
export function normalizeEndpoint(url: string): string {
	return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Identity of the embedding space. Changing it invalidates every cached vector. */
export function embeddingFingerprint(s: Settings): string {
	return `${normalizeEndpoint(s.embedding.endpoint)}|${s.embedding.model.toLowerCase()}|${s.embedding.dimensions}`;
}

export function maskSecret(value: string): string {
	const v = value.trim();
	if (!v) return "(none)";
	if (/^(?:\$\{?|env:)[A-Za-z_]/.test(v)) return v;
	if (v.length <= 8) return "•".repeat(v.length);
	return `${v.slice(0, 3)}…${v.slice(-3)}`;
}
