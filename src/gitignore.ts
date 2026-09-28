/**
 * Detect when git ignores the shared store (`.pi/realmem`), so shared memories would
 * silently never be committed, and work out a fix that is verified before it is shown.
 *
 * gitignore semantics are subtle (a file cannot be re-included when a parent directory
 * is excluded; nested .gitignore files beat the root one; info/exclude and the global
 * excludes file rank lowest), so candidate fixes are tried in a scratch repository that
 * reproduces the project's ignore sources, and only a fix that works there is suggested.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";

/** Store directory relative to the project root, in git's `/` form. */
export const SHARED_REL = ".pi/realmem";
/** A path that stands for any memory file in the shared store. */
const PROBE = `${SHARED_REL}/0000000000000000000000.md`;

export interface IgnoreFix {
	/** File to edit, as git reports it (relative to the project root, or absolute). */
	file: string;
	/** Lines to append at the end of `file`. */
	lines: string[];
	/** Why this fix has that shape. */
	note?: string;
}

export interface IgnoreProblem {
	/** Ignore file containing the deciding rule (as reported by `git check-ignore -v`). */
	source: string;
	line: number;
	pattern: string;
	/** A verified fix, or undefined when none of the candidates worked. */
	fix?: IgnoreFix;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		return { code: 0, out };
	} catch (err) {
		const e = err as { status?: number | null; stdout?: string };
		return { code: typeof e.status === "number" ? e.status : 128, out: typeof e.stdout === "string" ? e.stdout : "" };
	}
}

interface Verdict {
	ignored: boolean;
	source?: string;
	line?: number;
	pattern?: string;
}

/** `git check-ignore -v --no-index` for one path; undefined when git fails. */
function checkIgnore(cwd: string, path: string, extra: string[] = []): Verdict | undefined {
	const r = git(cwd, [...extra, "check-ignore", "-v", "--no-index", "--", path]);
	if (r.code === 1) return { ignored: false };
	if (r.code !== 0) return undefined;
	// <source>:<line>:<pattern>\t<path>; with -v a matching negation (`!…`) also exits 0.
	const m = r.out.split("\n")[0]?.match(/^(.*):(\d+):(.*)\t/);
	if (!m) return undefined;
	const pattern = m[3];
	return { ignored: !pattern.startsWith("!"), source: m[1], line: Number(m[2]), pattern };
}

/** Is the shared store ignored in the repository at `root`? Undefined when it is not (or unknown). */
export function checkSharedIgnored(root: string): IgnoreProblem | undefined {
	const v = checkIgnore(root, PROBE);
	if (!v?.ignored || !v.source || v.line === undefined || v.pattern === undefined) return undefined;
	return { source: v.source, line: v.line, pattern: v.pattern, fix: findFix(root, v.source) };
}

/** Candidate fixes, most targeted first: (file relative to root, lines to append). */
function candidates(source: string): Array<{ file: string; lines: string[]; note?: string }> {
	const out: Array<{ file: string; lines: string[]; note?: string }> = [];
	// A nested .gitignore on the way to the store beats the root one: fix it where it is.
	const rel = source.replace(/\\/g, "/");
	if (!isAbsolute(rel) && posix.basename(rel) === ".gitignore") {
		const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
		if (dir === SHARED_REL) out.push({ file: rel, lines: ["!*"] });
		else if (dir && SHARED_REL.startsWith(`${dir}/`)) {
			const sub = SHARED_REL.slice(dir.length + 1);
			out.push({ file: rel, lines: [`!/${sub}/`, `!/${sub}/**`] });
		}
	}
	out.push({ file: ".gitignore", lines: [`!/${SHARED_REL}/`, `!/${SHARED_REL}/**`] });
	out.push({
		file: ".gitignore",
		lines: ["!/.pi/", "/.pi/*", `!/${SHARED_REL}/`, `!/${SHARED_REL}/**`],
		note: "git cannot re-include files inside an ignored directory, so `.pi` itself is re-included and everything else in it stays ignored",
	});
	return out;
}

/** Try each candidate in a scratch repository with the project's ignore sources; return the first that works. */
function findFix(root: string, source: string): IgnoreFix | undefined {
	const scratch = mkdtempSync(join(tmpdir(), "realmem-gi-"));
	try {
		if (git(scratch, ["init", "-q"]).code !== 0) return undefined;
		// Same global excludes file as the project (it may come from a conditional include).
		const excludes = git(root, ["config", "--path", "--get", "core.excludesFile"]).out.trim();
		const extra = excludes ? ["-c", `core.excludesFile=${excludes}`] : [];
		const infoExclude = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).out.trim();
		const scratchExclude = join(scratch, ".git", "info", "exclude");
		const ignoreFiles = [".gitignore", ".pi/.gitignore", `${SHARED_REL}/.gitignore`];
		for (const c of candidates(source)) {
			rmSync(join(scratch, ".gitignore"), { force: true });
			rmSync(join(scratch, ".pi"), { recursive: true, force: true });
			mkdirSync(join(scratch, SHARED_REL), { recursive: true });
			for (const f of ignoreFiles) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(scratch, f));
			mkdirSync(dirname(scratchExclude), { recursive: true });
			if (infoExclude && existsSync(infoExclude)) copyFileSync(infoExclude, scratchExclude);
			else writeFileSync(scratchExclude, "");
			const target = join(scratch, c.file);
			const before = existsSync(target) ? readFileSync(target, "utf8") : "";
			writeFileSync(target, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${c.lines.join("\n")}\n`);
			const v = checkIgnore(scratch, PROBE, extra);
			if (v && !v.ignored) return c;
		}
		return undefined;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Human explanation with the fix, for notifications and status output. */
export function describeIgnoreProblem(p: IgnoreProblem): string {
	const lines = [
		`The shared memory store ${SHARED_REL}/ is ignored by git (${p.source}:${p.line}: \`${p.pattern}\`), so project-shared memories are never committed or shared with collaborators.`,
	];
	if (p.fix) {
		lines.push(`Fix: append these lines to ${p.fix.file}:`);
		for (const l of p.fix.lines) lines.push(`    ${l}`);
		if (p.fix.note) lines.push(`(${p.fix.note}.)`);
	} else {
		lines.push(`Fix: remove or narrow line ${p.line} of ${p.source} so that ${SHARED_REL}/ is not ignored.`);
	}
	lines.push(`Check with: git check-ignore -v --no-index ${PROBE}  (no output = fixed)`);
	return lines.join("\n");
}
