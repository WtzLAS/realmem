import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { SHARED_SUBDIR } from "./config.ts";
import type { StoreRef } from "./files.ts";
import { sha256 } from "./text.ts";

export interface ProjectInfo {
	/** Absolute project root (git top-level, else the working directory). */
	root: string;
	name: string;
	/** Stable key: `git-<root commit>` or `path-<hash of root>`. */
	key: string;
	keySource: "git" | "path";
	/** Path-derived key; personal memories stored under it before the repo had a commit are migrated. */
	pathKey: string;
	isGit: boolean;
	/** Working directory relative to the root (`.` at the root). */
	relCwd: string;
}

export interface ScopeContext {
	project?: ProjectInfo;
	global: StoreRef;
	shared?: StoreRef;
	personal?: StoreRef;
	/** Stores visible from this context, most specific first. */
	stores: StoreRef[];
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	} catch {
		return undefined;
	}
}

/** Walk up looking for a `.git` entry (cheap pre-check before spawning git). */
function findGitDir(start: string): string | undefined {
	let dir = start;
	const { root } = parse(dir);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dir === root) return undefined;
		dir = dirname(dir);
	}
}

const projectCache = new Map<string, ProjectInfo | undefined>();

/** Detect the project for a working directory. Undefined for the home directory or filesystem root. */
export function detectProject(cwd: string): ProjectInfo | undefined {
	const abs = canonical(cwd);
	if (projectCache.has(abs)) return projectCache.get(abs);
	let info: ProjectInfo | undefined;
	const home = canonical(homedir());
	let root: string | undefined;
	let key: string | undefined;
	let keySource: "git" | "path" = "path";
	if (findGitDir(abs)) {
		const top = git(abs, ["rev-parse", "--show-toplevel"]);
		if (top) {
			root = canonical(top);
			const roots = git(root, ["rev-list", "--max-parents=0", "HEAD"]);
			const first = roots
				?.split(/\s+/)
				.filter((r) => /^[0-9a-f]{40,64}$/.test(r))
				.sort()[0];
			if (first) {
				key = `git-${first.slice(0, 20)}`;
				keySource = "git";
			}
		}
	}
	if (!root) root = abs;
	const isRootless = root === home || root === parse(root).root;
	if (!isRootless) {
		const pathKey = `path-${sha256(root).slice(0, 20)}`;
		key ??= pathKey;
		let relCwd = abs === root ? "." : abs.slice(root.length + 1).replace(/\\/g, "/");
		if (!abs.startsWith(root)) relCwd = ".";
		info = { root, name: basename(root), key, keySource, pathKey, isGit: keySource === "git" || existsSync(join(root, ".git")), relCwd };
	}
	projectCache.set(abs, info);
	return info;
}

export function clearProjectCache(): void {
	projectCache.clear();
}

export function sharedStoreDir(root: string): string {
	return join(root, SHARED_SUBDIR);
}

export function globalStore(globalDir: string): StoreRef {
	return { id: "g", kind: "global", dir: globalDir };
}

export function sharedStore(root: string): StoreRef {
	const dir = sharedStoreDir(root);
	return { id: `s:${sha256(canonical(root)).slice(0, 16)}`, kind: "shared", dir };
}

export function personalStore(personalRoot: string, key: string): StoreRef {
	return { id: `p:${key}`, kind: "personal", dir: join(personalRoot, key) };
}

export function scopeContext(cwd: string, globalDir: string, personalRoot: string): ScopeContext {
	const project = detectProject(cwd);
	const g = globalStore(globalDir);
	if (!project) return { global: g, stores: [g] };
	const shared = sharedStore(project.root);
	const personal = personalStore(personalRoot, project.key);
	return { project, global: g, shared, personal, stores: [personal, shared, g] };
}

export function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A repository without commits gets a path-derived key; after the first commit the
 * key becomes `git-<root commit>`. Move personal memories stored under the old key.
 * Returns the number of files moved.
 */
export function migratePersonalStore(personalRoot: string, project: ProjectInfo): number {
	if (project.keySource !== "git" || project.pathKey === project.key) return 0;
	const from = join(personalRoot, project.pathKey);
	if (!isDirectory(from)) return 0;
	const to = join(personalRoot, project.key);
	if (!existsSync(to)) {
		mkdirSync(personalRoot, { recursive: true, mode: 0o700 });
		renameSync(from, to);
		return readdirSync(to).filter((f) => f.endsWith(".md")).length;
	}
	let moved = 0;
	for (const name of readdirSync(from)) {
		const dest = join(to, name);
		if (existsSync(dest)) continue;
		renameSync(join(from, name), dest);
		if (name.endsWith(".md")) moved++;
	}
	try {
		rmdirSync(from);
	} catch {
		// leftovers with clashing names stay for manual review
	}
	return moved;
}

/** Record which project a personal store belongs to (for humans browsing the directory). */
export function writeProjectInfo(dir: string, project: ProjectInfo): void {
	const file = join(dir, "project.json");
	if (existsSync(file)) return;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(file, `${JSON.stringify({ name: project.name, root: project.root, key: project.key }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	} catch {
		// raced or read-only: not important
	}
}
