import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeSettings } from "../src/config.ts";
import type { MemoryRow } from "../src/db.ts";
import { pathTier } from "../src/engine.ts";
import { normalizePathScopes } from "../src/files.ts";
import { formatPathNotes } from "../src/format.ts";
import { buildJudgeRequest, decide, NONE, readSignals, urgencyTier } from "../src/judge.ts";
import {
	clearRepoCache,
	absoluteScopes,
	coverSpecificity,
	displayPath,
	homeRoot,
	pathsCover,
	pathsOverlap,
	resolvePathArg,
	repoFiles,
	scopeCovers,
	scopeExists,
	suggestRename,
	touchedPaths,
} from "../src/paths.ts";

test("scopes: files, directories and globs", () => {
	assert.ok(scopeCovers("packages/web", "packages/web/src/a.ts"));
	assert.ok(scopeCovers("packages/web", "packages/web"));
	assert.ok(!scopeCovers("packages/web", "packages/webapp/a.ts"), "no prefix confusion");
	assert.ok(scopeCovers("package.json", "package.json"));
	assert.ok(!scopeCovers("package.json", "packages/x/package.json"));
	assert.ok(scopeCovers("**/migrations/*.sql", "db/migrations/001.sql"));
	assert.ok(scopeCovers("packages/*/package.json", "packages/web/package.json"));
	assert.ok(scopeCovers("infra/**", "infra"), "dir/** covers the dir itself");
	assert.ok(!scopeCovers("**/*.sql", "db/x.ts"));
	assert.ok(coverSpecificity(["packages/web/src"], ["packages/web/src/a.ts"]) > coverSpecificity(["packages/web"], ["packages/web/src/a.ts"]));
	assert.ok(coverSpecificity(["packages/web"], ["packages/web/a"]) > coverSpecificity(["packages/**"], ["packages/web/a"]), "plain beats glob");
	assert.equal(coverSpecificity(["docs"], ["src/a.ts"]), -1);
	assert.deepEqual(normalizePathScopes(["src/a", "src", "**/*.sql", "./x/"]), ["**/*.sql", "src", "x"]);
});

test("scopes: overlap and cover", () => {
	assert.ok(pathsOverlap(["packages/a"], ["packages/a/src"]));
	assert.ok(!pathsOverlap(["packages/a"], ["packages/b"]));
	assert.ok(pathsOverlap(["packages/a"], undefined), "project-wide overlaps everything");
	assert.ok(pathsOverlap(["packages/*/src"], ["packages/a"]), "glob vs dir under its prefix");
	assert.ok(!pathsOverlap(["docs/**"], ["packages/a"]));
	assert.ok(pathsOverlap(["**/*.sql"], ["db"]), "unanchored glob: unsure means overlap");
	assert.ok(pathsCover(["packages"], ["packages/a/b.ts"]));
	assert.ok(!pathsCover(["packages/a"], ["packages/b"]));
	assert.ok(pathsCover(undefined, ["x"]));
	assert.ok(!pathsCover(["x"], undefined));
});

test("touched paths from tool calls", () => {
	const root = mkdtempSync(join(tmpdir(), "realmem-touch-"));
	try {
		mkdirSync(join(root, "src", "db"), { recursive: true });
		writeFileSync(join(root, "src", "db", "schema.sql"), "");
		writeFileSync(join(root, "package.json"), "{}");
		const R = resolvePathArg(".", root) as string; // canonical root (macOS: /private/var/…)
		const rel = (xs: string[]) => xs.map((x) => (x.startsWith(`${R}/`) ? x.slice(R.length + 1) : x));
		assert.deepEqual(rel(touchedPaths("read", { path: "src/db/schema.sql" }, root)), ["src/db/schema.sql"]);
		assert.deepEqual(rel(touchedPaths("edit", { path: join(root, "src/new.ts") }, root)), ["src/new.ts"], "explicit paths need not exist");
		assert.deepEqual(touchedPaths("read", { path: "/etc/hosts" }, root), [resolvePathArg("/etc/hosts", root)], "outside projects too (global notes)");
		assert.deepEqual(touchedPaths("read", { path: "~/.gitconfig" }, root), [`${homeRoot()}/.gitconfig`]);
		assert.deepEqual(rel(touchedPaths("read", { path: "schema.sql" }, join(root, "src", "db"))), ["src/db/schema.sql"], "relative to cwd");
		const bash = rel(touchedPaths("bash", { command: "cat package.json | jq . && ls src/db --color=auto; rm -rf nothere" }, root)).sort();
		assert.deepEqual(bash, ["package.json", "src/db"], "shell words only when they exist; `.` is ignored");
		assert.deepEqual(touchedPaths("realmem_recall", { paths: ["src"] }, root), []);
		assert.equal(displayPath(`${R}/src/db`, root), "src/db");
		assert.equal(displayPath(`${homeRoot()}/.config/x`, "/"), "~/.config/x");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale paths: missing scopes and git rename suggestions", () => {
	const root = mkdtempSync(join(tmpdir(), "realmem-stale-"));
	try {
		const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: root });
		g("init", "-q");
		mkdirSync(join(root, "old", "mod"), { recursive: true });
		writeFileSync(join(root, "old", "mod", "a.ts"), "export const a = 1;\n".repeat(20));
		writeFileSync(join(root, "old", "mod", "b.ts"), "export const b = 2;\n".repeat(20));
		g("add", ".");
		g("commit", "-qm", "one");
		g("mv", "old", "new");
		g("commit", "-qm", "move");
		clearRepoCache();
		const repo = repoFiles(root, true);
		assert.ok(!scopeExists(root, "old/mod", repo));
		assert.ok(scopeExists(root, "new/mod/a.ts", repo));
		assert.ok(scopeExists(root, "**/*.ts", repo));
		assert.ok(!scopeExists(root, "**/*.sql", repo));
		assert.equal(suggestRename("old/mod/a.ts", repo, root), "new/mod/a.ts");
		assert.equal(suggestRename("old/mod", repo, root), "new/mod");
		assert.equal(suggestRename("old", repo, root), "new");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function row(id: string, caption: string, paths?: string[], kind: MemoryRow["kind"] = "shared"): MemoryRow {
	return {
		rid: Math.floor(Math.random() * 1e6),
		id,
		store: "s",
		kind,
		file: `/tmp/${id}.md`,
		caption,
		content: `${caption} body`,
		paths,
		hash: id,
		created: null,
		updated: null,
		mtime: 0,
		size: 0,
		vecHash: null,
		flags: null,
		usedCount: 0,
		injectCount: 0,
		lastUsed: null,
	};
}

const T = normalizeSettings({}).thresholds;
const choice = (pick: string, p: number, all: string[]) => ({
	type: "choice" as const,
	choice: pick,
	probabilities: Object.fromEntries(all.map((k) => [k, k === pick ? p : (1 - p) / Math.max(1, all.length - 1)])),
	confidence: p,
});
const base = {
	importance: { type: "score" as const, score: 2, legend: {}, probabilities: {}, confidence: 0.8 },
	durable: { type: "noul" as const, noul: 0.9 },
	unsafe: { type: "noul" as const, noul: 0.01 },
};

test("judge: path questions are asked only when relevant", () => {
	const scopes = ["personal", "shared", "global"] as const;
	const cfg = { max: 40, stateTokenBudget: 7000, perMemoryChars: 800 };
	const withPaths = buildJudgeRequest({ caption: "c", content: "x", paths: ["/p/src/db"], source: "agent" }, [], { scopes: [...scopes], projectRoot: "/p" }, cfg);
	assert.equal(withPaths.questions.path_urgency?.type, "score");
	assert.equal(withPaths.questions.path_scope, undefined, "no path inference");
	assert.match(withPaths.state, /Applies to paths: src\/db/);
	const plain = buildJudgeRequest({ caption: "c", content: "x", source: "agent" }, [], { scopes: [...scopes] }, cfg);
	assert.equal(plain.questions.path_urgency, undefined, "no paths: whole root, no urgency");
	const global = buildJudgeRequest({ caption: "c", content: "x", paths: [`${homeRoot()}/.config/nvim`], source: "agent" }, [], { scopes: ["global"] }, cfg);
	assert.equal(global.questions.path_urgency?.type, "score", "global memories take paths too");
	assert.match(global.state, /Applies to paths: ~\/\.config\/nvim/);
});

test("judge: disjoint paths are not a conflict; defaults; urgency; widening", () => {
	const scopes: MemoryRow["kind"][] = ["personal", "shared", "global"];
	const a = row("AAAAAAAAAAAAAAAAAAAAAA", "Tests use jest", ["packages/a"]);
	const ids = [a.id, NONE];
	const actions = ["Add", "Edit", "Merge", "Reinforce"];
	const run = (cand: Record<string, unknown>, answers: Record<string, unknown>) =>
		decide(
			{
				candidate: { caption: "Tests use vitest", content: "x", source: "agent", ...cand },
				neighbors: [{ memory: a, score: 1 }],
				scopes,
				projectRoot: "/p",
				signals: readSignals({ ...base, ...answers } as never),
			},
			T,
		);
	const conflictEdit = { conflict_with: choice(a.id, 0.9, ids), action: choice("Edit", 0.8, actions), scope: choice("Project Shared", 0.9, ["Project Personal", "Project Shared", "Global"]) };
	let d = run({ paths: ["/p/packages/b"] }, conflictEdit);
	assert.equal(d.action, "add", d.reasons.join("; "));
	assert.ok(d.reasons.some((r) => r.includes("disjoint")));
	d = run({ paths: ["/p/packages/a/src"] }, conflictEdit);
	assert.equal(d.action, "edit", "overlapping paths still conflict");
	d = run({}, conflictEdit);
	assert.equal(d.action, "edit", "unscoped candidate = whole project, overlaps everything");
	assert.equal(d.paths, undefined, "no inference: whole root");
	assert.ok(d.reasons.some((r) => r.includes("whole project (default)")));

	d = run({ paths: ["/p/packages/c"] }, { path_urgency: { type: "score", score: 1.8, legend: {}, probabilities: {}, confidence: 0.5 } });
	assert.deepEqual(d.paths, ["/p/packages/c"]);
	assert.equal(d.urgency, 1.8);
	// Paths outside the project make it a global memory.
	d = run({ paths: [`${homeRoot()}/.config/tool`] }, {});
	assert.equal(d.scope, "global", d.reasons.join("; "));

	const exact = decide({ candidate: { caption: "x", content: "y", paths: ["/p/packages/b"], source: "agent" }, neighbors: [], exact: a, scopes, projectRoot: "/p" }, T);
	assert.equal(exact.action, "reinforce");
	assert.equal(exact.widen, true, "same fact for another path widens the old memory");

	assert.equal(urgencyTier(1.9, T), "high");
	assert.equal(urgencyTier(1.0, T), "mid");
	assert.equal(urgencyTier(0.2, T), "low");
	assert.equal(urgencyTier(undefined, T), "mid");
});

test("recall ranking: focus paths, then project-wide, then elsewhere", () => {
	const root = "/p";
	const focus = ["/p/packages/web/src/app.ts"];
	const onFocus = row("a", "web", ["packages/web"]);
	const wide = row("b", "wide", ["."]);
	const other = row("c", "api", ["packages/api"]);
	const glob = row("d", "sql", ["**/*.sql"]);
	assert.ok(pathTier(onFocus, focus, root) > pathTier(wide, focus, root));
	assert.ok(pathTier(wide, focus, root) > pathTier(other, focus, root));
	assert.equal(pathTier(glob, focus, root), 0);
	assert.ok(pathTier(row("e", "deeper", ["packages/web/src"]), focus, root) > pathTier(onFocus, focus, root), "more specific first");
	assert.ok(pathTier(onFocus, ["/p/packages"], root) >= 2, "focus directory containing the scope counts");
	const g = row("g", "global everywhere", ["~"], "global");
	assert.equal(pathTier(g, focus, root), 1, "`~` = whole scope");
	const gs = row("h", "nvim", ["~/.config/nvim"], "global");
	assert.ok(pathTier(gs, [`${homeRoot()}/.config/nvim/init.lua`], root) >= 2);
	assert.deepEqual(absoluteScopes(gs, root), [`${homeRoot()}/.config/nvim`]);
	assert.deepEqual(absoluteScopes(row("i", "abs", ["/opt/tool"], "global"), root), ["/opt/tool"]);
});

test("path notes: High full, Mid caption, Low counted, budget demotes", () => {
	const hi = row("HHHHHHHHHHHHHHHHHHHHHH", "Run migrations first", ["db"]);
	const mid = row("MMMMMMMMMMMMMMMMMMMMMM", "Schema owner is team X", ["db"]);
	const low = row("LLLLLLLLLLLLLLLLLLLLLL", "Old naming history", ["db"]);
	const r = formatPathNotes(
		["db/schema.sql"],
		[
			{ memory: hi, tier: "high" },
			{ memory: mid, tier: "mid" },
			{ memory: low, tier: "low" },
		],
		{ maxFull: 3, maxCaptions: 8, charBudget: 6000 },
	);
	assert.ok(r);
	assert.match(r.text, /^<realmem-path-notes touched="db\/schema.sql">/);
	assert.match(r.text, /<memory id="HHHHHHHHHHHHHHHHHHHHHH"[^>]*>\n# Run migrations first\nRun migrations first body/);
	assert.match(r.text, /- \[MMMMMMMMMMMMMMMMMMMMMM\] Schema owner is team X/);
	assert.ok(!r.text.includes("Old naming history"), "low urgency is only counted");
	assert.match(r.text, /1 more memory is attached/);
	assert.deepEqual(r.displayed, [hi.id, mid.id]);
	assert.deepEqual(r.hinted, [low.id]);
	const tight = formatPathNotes(["db"], [{ memory: hi, tier: "high" }], { maxFull: 0, maxCaptions: 8, charBudget: 6000 });
	assert.match(tight?.text ?? "", /- \[HHHHHHHHHHHHHHHHHHHHHH\]/, "no full slots: caption");
	assert.equal(formatPathNotes(["db"], [], { maxFull: 3, maxCaptions: 8, charBudget: 6000 }), undefined);
});
