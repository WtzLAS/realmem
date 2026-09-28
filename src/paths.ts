/**
 * Path scopes: the files, directories and globs a memory applies to.
 *
 * Stored scopes are relative to the store's root:
 *  - project memories: relative to the project root; "." (the default) = whole project;
 *  - global memories:  "~" (the default) = the user directory / everywhere, "~/x" under
 *    the user directory, or an absolute path outside it.
 * A scope is a plain path (a file or a directory and everything under it) or a glob
 * (`*`, `?`, `**`, `[...]`, `{a,b}`, matched with path.matchesGlob).
 *
 * All comparisons happen on absolute paths: stored scopes are resolved against their
 * root, and touched paths (from the agent's tool calls) are absolute and canonical.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, matchesGlob, normalize, posix } from "node:path";
import { canonicalPath, type ScopeKind } from "./files.ts";

const GLOB_CHARS = /[*?[\]{}]/;

export function isGlob(scope: string): boolean {
	return GLOB_CHARS.test(scope);
}

/** Leading path segments of a glob that contain no glob characters. */
export function staticPrefix(glob: string): string {
	const out: string[] = [];
	for (const seg of glob.split("/")) {
		if (GLOB_CHARS.test(seg)) break;
		out.push(seg);
	}
	return out.join("/");
}

function under(child: string, parent: string): boolean {
	return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function globMatch(path: string, glob: string): boolean {
	try {
		return matchesGlob(path, glob);
	} catch {
		return false;
	}
}

/** Scopes covering the whole store root (no paths, `.` for projects, `~` for global). */
export function isWholeScope(paths: string[] | undefined): boolean {
	return !paths || paths.length === 0 || paths.includes(".") || paths.includes("~");
}

let home: { raw: string; canonical: string } | undefined;

/** Canonical user directory (the root of global path scopes; REALMEM_USER_HOME overrides it for tests). */
export function homeRoot(): string {
	const raw = process.env.REALMEM_USER_HOME || homedir();
	if (home?.raw !== raw) home = { raw, canonical: canonicalPath(raw) };
	return home.canonical;
}

/** Resolve a stored scope to an absolute path (undefined when its root is unknown). */
export function toAbsoluteScope(scope: string, kind: ScopeKind, projectRoot: string | undefined): string | undefined {
	if (kind === "global") {
		const h = homeRoot();
		if (scope === "~" || scope === ".") return h;
		if (scope.startsWith("~/")) return posix.join(h, scope.slice(2));
		if (isAbsolute(scope)) return scope;
		return posix.join(h, scope);
	}
	if (!projectRoot) return undefined;
	return scope === "." ? projectRoot : posix.join(projectRoot, scope);
}

/** Express an absolute scope in a store's frame (undefined when the store cannot hold it). */
export function fromAbsoluteScope(abs: string, kind: ScopeKind, projectRoot: string | undefined): string | undefined {
	if (kind === "global") {
		const h = homeRoot();
		if (abs === h) return "~";
		if (under(abs, h)) return `~/${abs.slice(h.length + 1)}`;
		return abs;
	}
	if (!projectRoot) return undefined;
	if (abs === projectRoot) return ".";
	if (under(abs, projectRoot)) return abs.slice(projectRoot.length + 1);
	return undefined;
}

/** Absolute scopes of a memory, or undefined when it covers its whole root. */
export function absoluteScopes(m: { kind: ScopeKind; paths?: string[] | null }, projectRoot: string | undefined): string[] | undefined {
	if (isWholeScope(m.paths ?? undefined)) return undefined;
	const out = (m.paths as string[]).map((p) => toAbsoluteScope(p, m.kind, projectRoot)).filter((p): p is string => !!p);
	return out.length > 0 ? out : undefined;
}

/** Resolve a path argument given by the agent or user (relative to cwd, `~/…`, absolute; globs allowed). */
export function resolvePathArg(p: string, cwd: string): string | undefined {
	let raw = p.trim().replace(/^file:\/\//, "").replace(/\\/g, "/");
	if (!raw || raw.length > 1024) return undefined;
	if (raw === "~") return homeRoot();
	if (raw.startsWith("~/")) raw = posix.join(homeRoot(), raw.slice(2));
	const abs = normalize(isAbsolute(raw) ? raw : join(canonicalPath(cwd), raw));
	const out = canonicalPath(abs).replace(/\\/g, "/");
	return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** Human form of an absolute path: relative to cwd, else `~/…`, else absolute. */
export function displayPath(abs: string, cwd: string): string {
	const c = canonicalPath(cwd);
	if (abs === c) return ".";
	if (under(abs, c)) return abs.slice(c.length + 1);
	const h = homeRoot();
	if (abs === h) return "~";
	if (under(abs, h)) return `~/${abs.slice(h.length + 1)}`;
	return abs;
}

/** Does `scope` apply to the touched project-relative path? */
export function scopeCovers(scope: string, touched: string): boolean {
	if (scope === ".") return true;
	if (isGlob(scope)) return globMatch(touched, scope) || (scope.endsWith("/**") && under(touched, scope.slice(0, -3)));
	return under(touched, scope);
}

/** Specificity of a scope: deeper plain paths are more specific than shallow ones and than globs. */
export function specificity(scope: string): number {
	if (scope === ".") return 0;
	if (isGlob(scope)) {
		const p = staticPrefix(scope);
		return (p ? p.split("/").length : 0) + 0.5;
	}
	return scope.split("/").length + 1;
}

/** Highest specificity among `paths` covering any of `touched`, or -1 when none covers. */
export function coverSpecificity(paths: string[] | undefined, touched: string[]): number {
	if (!paths) return -1;
	let best = -1;
	for (const s of paths) {
		if (s === ".") continue;
		for (const t of touched) if (scopeCovers(s, t)) best = Math.max(best, specificity(s));
	}
	return best;
}

/** Could two scopes refer to the same files? (Conservative: unsure means yes.) */
export function scopesOverlap(a: string, b: string): boolean {
	if (a === "." || b === ".") return true;
	const ga = isGlob(a);
	const gb = isGlob(b);
	if (!ga && !gb) return under(a, b) || under(b, a);
	if (ga && !gb) return globMatch(b, a) || relatedPrefix(staticPrefix(a), b);
	if (!ga && gb) return globMatch(a, b) || relatedPrefix(staticPrefix(b), a);
	return a === b || relatedPrefix(staticPrefix(a), staticPrefix(b));
}

function relatedPrefix(a: string, b: string): boolean {
	if (a === "" || b === "") return true;
	return under(a, b) || under(b, a);
}

/** Do two path-scope lists overlap? Whole-scope lists overlap with everything. */
export function pathsOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
	if (isWholeScope(a) || isWholeScope(b)) return true;
	for (const x of a as string[]) for (const y of b as string[]) if (scopesOverlap(x, y)) return true;
	return false;
}

/** Is every scope of `inner` already covered by some scope of `outer`? */
export function pathsCover(outer: string[] | undefined, inner: string[] | undefined): boolean {
	if (isWholeScope(outer)) return true;
	if (isWholeScope(inner)) return false;
	return (inner as string[]).every((i) =>
		(outer as string[]).some((o) => {
			if (o === i) return true;
			if (isGlob(i)) return !isGlob(o) && under(staticPrefix(i), o) && staticPrefix(i) !== "";
			return scopeCovers(o, i);
		}),
	);
}

/** Drop plain scopes already covered by another plain scope (`a` covers `a/b`). */
export function reduceScopes(paths: string[]): string[] {
	if (paths.includes(".")) return ["."];
	const plain = paths.filter((p) => !isGlob(p));
	return paths.filter((p) => isGlob(p) || !plain.some((q) => q !== p && under(p, q))).sort();
}

// ---------------------------------------------------------------------------
// Touched paths
// ---------------------------------------------------------------------------

const PATH_KEYS = new Set(["path", "paths", "file", "files", "filepath", "file_path", "filename", "dir", "directory", "cwd", "target", "targets", "cwdpath"]);
const TOKEN_RE = /^[\w.@~+%=,-][\w./@~+%=,-]*$/;

function shellTokens(command: string): string[] {
	const out: string[] = [];
	for (let tok of command.split(/[\s|;&<>()`]+/)) {
		tok = tok.replace(/^['"]+|['"]+$/g, "");
		const eq = tok.match(/^--?[\w-]+=(.+)$/);
		if (eq) tok = eq[1];
		if (!tok || tok.startsWith("-") || tok.startsWith("$") || tok.includes("://")) continue;
		if (!TOKEN_RE.test(tok)) continue;
		out.push(tok);
		if (out.length >= 64) break;
	}
	return out;
}

/**
 * Absolute (canonical) paths an agent touched with a tool call. Explicit path arguments
 * are taken as given; words of shell commands only when they exist on disk.
 */
export function touchedPaths(toolName: string, input: Record<string, unknown> | undefined, cwd: string): string[] {
	if (!input || toolName.startsWith("realmem_")) return [];
	const out = new Set<string>();
	const add = (p: unknown, mustExist: boolean) => {
		if (typeof p !== "string" || p === "." || p === ".." || /[*?[\]{}]/.test(p)) return;
		const abs = resolvePathArg(p, cwd);
		if (!abs || abs === "/") return;
		if (mustExist && !existsSync(abs)) return;
		out.add(abs);
	};
	for (const [k, v] of Object.entries(input)) {
		if (!PATH_KEYS.has(k.toLowerCase())) continue;
		if (Array.isArray(v)) for (const x of v.slice(0, 32)) add(x, false);
		else add(v, false);
	}
	const command = input.command;
	if (typeof command === "string" && (toolName === "bash" || toolName === "powershell" || toolName.endsWith("bash") || toolName === "bg_run")) {
		for (const tok of shellTokens(command)) add(tok, true);
	}
	return [...out].slice(0, 32);
}

// ---------------------------------------------------------------------------
// Stale path detection
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
	} catch {
		return undefined;
	}
}

export interface RepoFiles {
	head: string;
	/** Tracked + untracked (non-ignored) files, project-relative. */
	files: string[] | undefined;
	/** old path → new path (renames recorded in recent history, chains resolved). */
	renames: Map<string, string>;
}

const repoCache = new Map<string, RepoFiles>();

export function repoFiles(root: string, isGit: boolean): RepoFiles {
	if (!isGit) return { head: "", files: undefined, renames: new Map() };
	const head = git(root, ["rev-parse", "-q", "--verify", "HEAD"])?.trim() ?? "";
	const cached = repoCache.get(root);
	if (cached && cached.head === head) return cached;
	const list = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
	const files = list === undefined ? undefined : list.split("\0").filter(Boolean);
	const renames = new Map<string, string>();
	const log = head ? git(root, ["log", "-M", "--diff-filter=R", "--name-status", "--format=", "-n", "300"]) : undefined;
	if (log) {
		// Newest first: a later rename of the same file wins, chains resolve forward.
		const pairs: Array<[string, string]> = [];
		for (const line of log.split("\n")) {
			const parts = line.split("\t");
			if (parts.length === 3 && parts[0].startsWith("R")) pairs.push([parts[1], parts[2]]);
		}
		for (const [from, to] of pairs.reverse()) {
			for (const [k, v] of renames) if (v === from) renames.set(k, to);
			renames.set(from, to);
		}
	}
	const out = { head, files, renames };
	repoCache.set(root, out);
	return out;
}

export function clearRepoCache(): void {
	repoCache.clear();
}

/** Does a scope still refer to something in the project? */
export function scopeExists(root: string, scope: string, repo: RepoFiles): boolean {
	if (scope === ".") return true;
	if (isGlob(scope)) {
		if (!repo.files) return true; // unknown without git: do not flag
		return repo.files.some((f) => globMatch(f, scope));
	}
	return existsSync(join(root, scope));
}

/** Suggest where a missing plain scope moved to, from git rename history. */
export function suggestRename(scope: string, repo: RepoFiles, root: string): string | undefined {
	if (isGlob(scope)) return undefined;
	const direct = repo.renames.get(scope);
	if (direct && existsSync(join(root, direct))) return direct;
	const votes = new Map<string, number>();
	for (const [from, to] of repo.renames) {
		if (!from.startsWith(`${scope}/`)) continue;
		const suffix = from.slice(scope.length);
		if (!to.endsWith(suffix)) continue;
		const dest = to.slice(0, to.length - suffix.length);
		if (dest && existsSync(join(root, dest))) votes.set(dest, (votes.get(dest) ?? 0) + 1);
	}
	let best: string | undefined;
	let n = 0;
	for (const [d, c] of votes) if (c > n) [best, n] = [d, c];
	return best;
}

