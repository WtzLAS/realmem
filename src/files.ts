import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, posix } from "node:path";
import { parseDocument, stringify } from "yaml";
import { newId, parseId, toCanonicalUuid } from "./ids.ts";
import { textHash } from "./text.ts";

export type ScopeKind = "global" | "shared" | "personal";

export const SCOPE_LABEL: Record<ScopeKind, string> = {
	global: "global",
	shared: "project-shared",
	personal: "project-personal",
};

export interface StoreRef {
	/** Stable store identifier used in the index (`g`, `s:<hash>`, `p:<projectKey>`). */
	id: string;
	kind: ScopeKind;
	dir: string;
}

/** A memory fact as stored on disk. */
export interface MemoryFile {
	/** Compact (base64url) UUIDv7. */
	id: string;
	caption: string;
	content: string;
	/** Path scope relative to the project root (project memories only). */
	paths?: string[];
	created?: string;
	updated?: string;
}

export interface ParsedMemory extends MemoryFile {
	file: string;
	hash: string;
}

export const MAX_CAPTION = 160;
export const MAX_CONTENT = 8000;

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export class MemoryParseError extends Error {}

/** Parse a memory markdown file. */
export function parseMemoryMarkdown(text: string, kind: ScopeKind = "shared"): MemoryFile {
	const m = FRONTMATTER_RE.exec(text);
	if (!m) throw new MemoryParseError("missing YAML frontmatter");
	const doc = parseDocument(m[1], { uniqueKeys: false, prettyErrors: false });
	if (doc.errors.length > 0) throw new MemoryParseError(`invalid frontmatter: ${doc.errors[0].message}`);
	const fm = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
	if (!fm || typeof fm !== "object") throw new MemoryParseError("frontmatter is not a mapping");
	const id = parseId(fm.id);
	if (!id) throw new MemoryParseError("frontmatter `id` is missing or not a UUID");
	const caption = typeof fm.caption === "string" ? fm.caption.trim() : "";
	if (!caption) throw new MemoryParseError("frontmatter `caption` is missing");
	const content = text.slice(m[0].length).replace(/^\s*\n/, "").trimEnd();
	let paths: string[] | undefined;
	if (Array.isArray(fm.paths)) paths = fm.paths.filter((p): p is string => typeof p === "string");
	else if (typeof fm.paths === "string") paths = [fm.paths];
	else if (typeof fm.path === "string") paths = [fm.path];
	const date = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : undefined);
	return {
		id,
		caption,
		content,
		paths: paths ? normalizePathScopes(paths, kind) : undefined,
		created: date(fm.created),
		updated: date(fm.updated),
	};
}

export function serializeMemory(mem: MemoryFile, kind: ScopeKind): string {
	const fm: Record<string, unknown> = {
		id: toCanonicalUuid(mem.id),
		caption: mem.caption,
	};
	// Unspecified paths default to the whole root: "." (project) or "~" (user directory, global).
	fm.paths = mem.paths && mem.paths.length > 0 ? mem.paths : [kind === "global" ? "~" : "."];
	if (mem.created) fm.created = mem.created;
	if (mem.updated) fm.updated = mem.updated;
	const yaml = stringify(fm, { lineWidth: 0 }).trimEnd();
	return `---\n${yaml}\n---\n\n${mem.content.trim()}\n`;
}

/** Normalize project-relative path scopes. Invalid entries (absolute, escaping the root) are dropped. */
export function normalizePathScopes(paths: string[], kind: ScopeKind = "shared"): string[] {
	const global = kind === "global";
	const whole = global ? "~" : ".";
	const out = new Set<string>();
	for (const raw of paths) {
		if (typeof raw !== "string") continue;
		let p = raw.trim().replace(/\\/g, "/");
		if (!p) continue;
		if (global) {
			// "~", "~/x" (under the user directory) or an absolute path elsewhere.
			if (p === "." || p === "~" || p === "~/") {
				out.add("~");
				continue;
			}
			if (/^[A-Za-z]:\//.test(p)) p = p.replace(/^([A-Za-z]):/, "/$1");
			if (p.startsWith("~/")) p = `~/${posix.normalize(p.slice(2))}`;
			else if (isAbsolute(p)) p = posix.normalize(p);
			else p = `~/${posix.normalize(p)}`;
			p = p.replace(/\/+$/, "");
			if (p === "~/." || p === "~") p = "~";
			if (p.startsWith("~/../") || p === "~/.." || p === "") continue;
			out.add(p);
			continue;
		}
		if (isAbsolute(p) || /^[A-Za-z]:\//.test(p) || p.startsWith("~")) continue;
		p = posix.normalize(p).replace(/\/+$/, "");
		if (p === "" || p === "./") p = ".";
		if (p === ".." || p.startsWith("../")) continue;
		out.add(p);
	}
	if (out.has(whole)) return [whole];
	// Drop plain scopes already covered by another plain scope (`a` covers `a/b`).
	const isGlob = (p: string) => /[*?[\]{}]/.test(p);
	const plain = [...out].filter((p) => !isGlob(p));
	return [...out].filter((p) => isGlob(p) || !plain.some((q) => q !== p && p.startsWith(`${q}/`))).sort((a, b) => a.localeCompare(b));
}

/** realpath of the longest existing prefix (so non-existing children still resolve through symlinks). */
export function canonicalPath(p: string): string {
	let head = normalize(p);
	const tail: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(head), ...tail.reverse());
		} catch {
			const parent = dirname(head);
			if (parent === head) return normalize(p);
			tail.push(basename(head));
			head = parent;
		}
	}
}

export function memoryFileName(id: string): string {
	return `${toCanonicalUuid(id)}.md`;
}

/** Atomically write a file (temp + fsync + rename). */
export function atomicWrite(file: string, data: string, mode = 0o644): void {
	const dir = join(file, "..");
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	const fd = openSync(tmp, "w", mode);
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
}

export function readMemoryFile(file: string, kind: ScopeKind = "shared"): ParsedMemory {
	const text = readFileSync(file, "utf8");
	const mem = parseMemoryMarkdown(text, kind);
	return { ...mem, file, hash: textHash(mem.caption, mem.content) };
}

export interface DirEntry {
	file: string;
	mtimeMs: number;
	size: number;
}

/** List `*.md` memory files in a store directory (non-recursive, hidden files skipped). */
export function listStoreFiles(dir: string): DirEntry[] {
	if (!existsSync(dir)) return [];
	const out: DirEntry[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	for (const name of names) {
		if (!name.endsWith(".md") || name.startsWith(".")) continue;
		if (/^readme\.md$/i.test(name)) continue;
		const file = join(dir, name);
		try {
			const st = statSync(file);
			if (!st.isFile()) continue;
			out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
		} catch {
			// vanished between readdir and stat
		}
	}
	out.sort((a, b) => a.file.localeCompare(b.file));
	return out;
}

/**
 * Turn a hand-written markdown file without realmem frontmatter into a memory:
 * caption = first heading or first line, content = the rest.
 */
export function adoptPlainMarkdown(text: string, now = new Date()): MemoryFile | undefined {
	const body = text.replace(/^\uFEFF/, "").trim();
	if (!body) return undefined;
	const fm = FRONTMATTER_RE.exec(body);
	let fields: Record<string, unknown> = {};
	let rest = body;
	if (fm) {
		try {
			const parsed = parseDocument(fm[1]).toJS({ maxAliasCount: 0 });
			if (parsed && typeof parsed === "object") fields = parsed as Record<string, unknown>;
		} catch {
			// ignore broken frontmatter, keep text
		}
		rest = body.slice(fm[0].length).trim();
	}
	let caption = typeof fields.caption === "string" ? fields.caption.trim() : "";
	if (!caption) {
		const lines = rest.split(/\r?\n/);
		const first = lines.findIndex((l) => l.trim() !== "");
		if (first < 0) return undefined;
		caption = lines[first].replace(/^#+\s*/, "").trim();
		rest = lines.slice(first + 1).join("\n").trim();
		if (!rest) rest = caption;
	}
	const paths = Array.isArray(fields.paths) ? normalizePathScopes(fields.paths.filter((p): p is string => typeof p === "string")) : undefined;
	const iso = now.toISOString();
	return { id: parseId(fields.id) ?? newId(now.getTime()), caption: caption.slice(0, MAX_CAPTION), content: rest, paths, created: iso, updated: iso };
}
