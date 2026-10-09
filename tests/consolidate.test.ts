/**
 * /realmem consolidate: SemIf review (forget / covered / merge / revise / keep) and the
 * Edit/Merge model's repository summary + path revision, planned then applied.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { normalizeSettings, saveSettings } from "../src/config.ts";
import { buildReviewRequest, type ConsolidationProposal, decideReview, formatPlan, formatProposal, parsePathsAnswer, readReview, renderTree, SUMMARY_SYSTEM } from "../src/consolidate.ts";
import { Realmem } from "../src/engine.ts";
import { parseId } from "../src/ids.ts";
import { clearProjectCache } from "../src/project.ts";
import type { CompletionRequest, RewriteRequest } from "../src/rewrite.ts";

let srv: Server;
let base: string;
let proj: string;
let semifCalls = 0;

/** Scripted review: decided by the caption of the memory under review. */
function review(state: string, questions: Record<string, any>): Record<string, unknown> {
	const subject = /^\[[^\]]+\] \([^)]*\) (.*)$/m.exec(state)?.[1] ?? "";
	const idOf = (caption: string) => new RegExp(`^\\[([^\\]]+)\\] \\([^)]*\\) ${caption}`, "m").exec(state.split("## Other memories")[1] ?? "")?.[1];
	const want: Record<string, string | undefined> = {};
	if (subject.startsWith("DUP")) want.covered_by = idOf("Run tests");
	if (subject.startsWith("LINT part")) want.merge_with = idOf("LINT config");
	const answers: Record<string, unknown> = {};
	for (const [k, q] of Object.entries(questions)) {
		if (q.type === "noul") {
			const p = k === "forget" ? (subject.startsWith("OLD") ? 0.95 : 0.05) : k === "revise" ? (subject.startsWith("VERBOSE") ? 0.9 : 0.1) : 0.1;
			answers[k] = { type: "noul", noul: p };
		} else if (q.type === "score") {
			answers[k] = { type: "score", score: 2.4, legend: {}, probabilities: {}, confidence: 0.8 };
		} else {
			const keys = Object.keys(q.criteria);
			const pick = want[k] && keys.includes(want[k] as string) ? (want[k] as string) : "none";
			answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 0.9 : 0.1 / keys.length])), confidence: 0.9 };
		}
	}
	return answers;
}

before(async () => {
	srv = createServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			const body = data ? JSON.parse(data) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/embeddings") {
				const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
				return res.end(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: [1, (t.length % 7) / 7, 0.5, 0.2] })) }));
			}
			semifCalls++;
			res.end(JSON.stringify({ model: "mock", answers: review(body.state, body.questions) }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	base = mkdtempSync(join(tmpdir(), "realmem-cons-"));
	proj = mkdtempSync(join(tmpdir(), "realmem-consproj-"));
	execFileSync("git", ["init", "-q"], { cwd: proj });
	mkdirSync(join(proj, "src", "lint"), { recursive: true });
	writeFileSync(join(proj, "src", "lint", "rules.ts"), "export {};\n");
	writeFileSync(join(proj, "package.json"), "{}\n");
	execFileSync("git", ["add", "-A"], { cwd: proj });
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: proj });
	saveSettings(
		join(base, "config.json"),
		normalizeSettings({
			embedding: { endpoint: url, model: "mock", dimensions: 4, timeoutMs: 5000 },
			semif: { endpoint: url, model: "mock", maxQuestions: 3, timeoutMs: 5000 },
		}),
	);
});

after(() => {
	srv.close();
	rmSync(base, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
});

function mem(dir: string, n: number, caption: string, content: string, paths?: string[]): string {
	const id = `01900000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
	const p = paths ? `paths:\n${paths.map((x) => `  - ${x}`).join("\n")}\n` : "";
	writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ncaption: ${JSON.stringify(caption)}\n${p}updated: 2026-01-0${n % 9 || 1}T00:00:00.000Z\n---\n\n${content}\n`);
	return parseId(id) as string;
}

test("consolidate plans forget / covered / merge / revise and path revisions, then applies them", async () => {
	clearProjectCache();
	const e = new Realmem(base);
	try {
		const dir = join(proj, ".pi", "realmem");
		mkdirSync(dir, { recursive: true });
		const keepId = mem(dir, 1, "Run tests with npm test", "Run `npm test`; it uses node --test.");
		const dupId = mem(dir, 2, "DUP tests run via npm test", "npm test runs the tests.");
		const oldId = mem(dir, 3, "OLD refactor in progress", "Currently refactoring the parser (task status).");
		const lintId = mem(dir, 4, "LINT config lives in src/lint", "Lint rules are in src/lint/rules.ts.", ["src/lint"]);
		const partId = mem(dir, 5, "LINT part: run lint before commit", "Run the linter before committing.", ["src/lint/rules.ts"]);
		const verboseId = mem(dir, 6, "VERBOSE build", "Build build build: the build is run with npm run build, which builds.");
		const pathId = mem(dir, 7, "Package manifest notes", "package.json has no scripts besides test.", ["gone/old.json"]);
		e.sync(proj);
		e.db.setUsage(keepId, 9);
		e.db.setUsage(lintId, 4);
		e.db.setUsage(dupId, 2);

		const rewrites: RewriteRequest[] = [];
		const prompts: CompletionRequest[] = [];
		const plan = await e.planConsolidation({
			cwd: proj,
			rewriter: async (req) => {
				rewrites.push(req);
				if (req.mode === "revise") return { caption: "Build with npm run build", content: "Build with `npm run build`.", model: "fake" };
				return { caption: req.target.caption, content: `${req.target.content}\n${req.candidate?.content}`, model: "fake" };
			},
			completer: async (req) => {
				prompts.push(req);
				if (req.system === SUMMARY_SYSTEM) return { text: "src/ holds the code; src/lint the lint rules.", model: "fake" };
				return { text: `\`\`\`json\n${JSON.stringify({ [pathId]: ["package.json", "nope/missing.ts"], [lintId]: ["src/lint"] })}\n\`\`\``, model: "fake" };
			},
		});
		assert.ok(semifCalls > 0);
		assert.equal(plan.total, 7);
		const kinds = plan.ops.map((o) => `${o.kind}:${"id" in o ? o.id : o.from}`);
		assert.ok(kinds.includes(`forget:${oldId}`), kinds.join());
		assert.ok(plan.ops.some((o) => o.kind === "fold" && o.how === "covered" && o.from === dupId && o.into === keepId), kinds.join());
		assert.ok(plan.ops.some((o) => o.kind === "fold" && o.how === "merge" && o.from === partId && o.into === lintId), kinds.join());
		assert.ok(kinds.includes(`revise:${verboseId}`), kinds.join());
		const pathOp = plan.ops.find((o) => o.kind === "paths" && o.id === pathId);
		assert.deepEqual(pathOp && pathOp.kind === "paths" ? pathOp.after : undefined, ["package.json"], "missing and invented paths are dropped");
		assert.ok(!plan.ops.some((o) => o.kind === "paths" && o.id === lintId), "unchanged paths are no op");
		assert.equal(plan.repoSummary, "src/ holds the code; src/lint the lint rules.");
		assert.ok(prompts.some((p) => p.system !== SUMMARY_SYSTEM && p.prompt.includes("no longer exist") && p.prompt.includes("gone/old.json")));
		assert.ok(prompts[0].prompt.includes("rules.ts") && !prompts[0].prompt.includes(".pi/realmem"), "the tree lists project files, not the store");
		assert.ok(rewrites.some((r) => r.mode === "merge"));
		assert.ok(formatPlan(plan).length >= 5);
		assert.ok(e.db.getById(oldId), "planning writes nothing");

		const done = await e.applyConsolidation(proj, plan);
		assert.deepEqual(done.stale, []);
		const rows = e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 99, offset: 0 });
		const byId = new Map(rows.map((r) => [r.id, r]));
		assert.ok(!byId.has(oldId) && !byId.has(dupId) && !byId.has(partId));
		assert.equal(rows.length, 4);
		assert.equal(byId.get(keepId)?.usedCount, 11, "usage of the covered memory carries over");
		assert.match(byId.get(lintId)?.content ?? "", /Run the linter before committing/);
		assert.equal(byId.get(verboseId)?.caption, "Build with npm run build");
		assert.deepEqual(byId.get(pathId)?.paths, ["package.json"]);

		// The repository summary is cached per file tree.
		const before = prompts.filter((p) => p.system === SUMMARY_SYSTEM).length;
		await e.planConsolidation({ cwd: proj, completer: async (req) => (prompts.push(req), { text: "{}", model: "fake" }) });
		assert.equal(prompts.filter((p) => p.system === SUMMARY_SYSTEM).length, before);
	} finally {
		e.close();
	}
});

test("apply skips memories edited after the plan was made", async () => {
	clearProjectCache();
	const e = new Realmem(base);
	try {
		const dir = join(proj, ".pi", "realmem");
		const a = mem(dir, 21, "OLD stale note", "Temporary.");
		e.sync(proj);
		const plan = await e.planConsolidation({ cwd: proj, paths: false });
		assert.ok(plan.deleted.some((m) => m.id === a));
		mem(dir, 21, "OLD stale note", "Edited by hand meanwhile.");
		const done = await e.applyConsolidation(proj, plan);
		assert.ok(done.stale.includes(a));
		assert.match(e.db.getById(a)?.content ?? "", /Edited by hand/);
	} finally {
		e.close();
	}
});

test("consolidate unit: review request, decision order, path answers, tree rendering", () => {
	const row = { id: "A", kind: "shared", caption: "x", content: "y", paths: undefined, usedCount: 0, created: null, updated: null } as any;
	const req = buildReviewRequest({ row, caption: "x", content: "y", paths: ["."], usageAdd: 0 }, [], {}, { stateTokenBudget: 4000, perMemoryChars: 400, maxNeighbors: 5 });
	assert.ok(!("covered_by" in req.questions), "no id questions without neighbours");
	assert.ok("forget" in req.questions && "revise" in req.questions && "importance" in req.questions);

	const t = { covered: 0.5, conflict: 0.5, merge: 0.5, forget: 0.7, minImportance: 0.5, revise: 0.7, neighbors: 5, paths: true, pathBatch: 10, treeLines: 100 };
	const pick = (choice: string, p = 0.9) => ({ type: "choice" as const, choice, probabilities: { [choice]: p, none: 1 - p }, confidence: p });
	const s = readReview({ covered_by: pick("B"), merge_with: pick("C"), forget: { type: "noul", noul: 0.2 }, importance: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 1 } });
	assert.deepEqual(decideReview(s, t, () => true), { action: "covered", target: "B", reason: "already stated by another memory (P=90%)" });
	assert.equal(decideReview(s, t, (id) => id !== "B").action, "merge", "an unknown target falls through");
	assert.equal(decideReview({ ...s, forget: 0.8 }, t, () => true).action, "forget");
	assert.equal(decideReview({ importance: 0.2 }, t, () => true).action, "forget");
	assert.equal(decideReview({ importance: 0.2 }, { ...t, minImportance: 0 }, () => true).action, "keep");

	const exists = (p: string) => ["src", "src/a.ts", "README.md"].includes(p) || p === "src/**/*.ts";
	const m = parsePathsAnswer('Sure: {"A": ["./src/", "../etc", "/abs", "ghost.ts"], "B": [".", "src"], "C": ["ghost"], "D": "src"}', ["A", "B", "C", "D"], exists);
	assert.deepEqual(m.get("A"), ["src"]);
	assert.deepEqual(m.get("B"), ["."]);
	assert.ok(!m.has("C") && !m.has("D"));

	const files = Array.from({ length: 30 }, (_, i) => `pkg/deep/dir/f${i}.ts`).concat(["README.md", ".pi/realmem/x.md"]);
	const tree = renderTree(files, 10);
	assert.ok(tree.split("\n").length <= 11);
	assert.match(tree, /README\.md/);
	assert.match(tree, /\(30 files\)/);
	assert.ok(!tree.includes("realmem"));
});

test("interactive consolidate asks about every step and writes accepted ones at once", async () => {
	clearProjectCache();
	const e = new Realmem(base);
	try {
		const dir = join(proj, ".pi", "realmem");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const keepId = mem(dir, 31, "Run tests with npm test", "Run `npm test`; it uses node --test.");
		const dupId = mem(dir, 32, "DUP tests run via npm test", "npm test runs the tests.");
		const oldId = mem(dir, 33, "OLD refactor in progress", "Currently refactoring the parser.");
		const verboseId = mem(dir, 34, "VERBOSE build", "Build build build: npm run build builds.");
		const pathId = mem(dir, 35, "Package manifest notes", "package.json has no scripts besides test.", ["gone/old.json"]);
		e.sync(proj);
		e.db.setUsage(keepId, 9);

		const seen: ConsolidationProposal[] = [];
		const written: number[] = [];
		const res = await e.consolidate({
			cwd: proj,
			rewriter: async (req) =>
				req.mode === "revise"
					? { caption: "Build with npm run build", content: "Build with `npm run build`.", model: "fake" }
					: { caption: req.target.caption, content: req.target.content, model: "fake" },
			completer: async (req) =>
				req.system === SUMMARY_SYSTEM ? { text: "src/ holds the code.", model: "fake" } : { text: JSON.stringify({ [pathId]: ["package.json"] }), model: "fake" },
			approve: async (p) => {
				seen.push(p);
				// The step is not written before it is approved.
				if (p.op.kind === "forget") assert.ok(existsSync(join(dir, `${p.op.id}.md`)) || e.db.getById(p.op.id));
				return p.op.kind === "forget" ? "skip" : "accept";
			},
			onWritten: (d) => written.push(d.updated + d.deleted),
		});
		const kinds = seen.map((p) => p.op.kind);
		assert.ok(kinds.includes("forget") && kinds.includes("fold") && kinds.includes("revise") && kinds.includes("paths"), kinds.join());
		const fold = seen.find((p) => p.op.kind === "fold") as ConsolidationProposal;
		assert.equal(fold.before.length, 2, "a fold shows both memories");
		assert.ok(fold.before[0].content.includes("npm test runs the tests"));
		const rev = seen.find((p) => p.op.kind === "revise") as ConsolidationProposal;
		assert.equal(rev.after?.caption, "Build with npm run build");
		assert.ok(formatProposal(rev).some((l) => l.includes("Build build build")) && formatProposal(rev).some((l) => l.includes("`npm run build`")));
		const paths = seen.find((p) => p.op.kind === "paths") as ConsolidationProposal;
		assert.deepEqual(paths.after?.paths, ["package.json"]);
		assert.ok(seen.every((p) => /^(review|paths) \d+\/\d+$/.test(p.progress)), seen.map((p) => p.progress).join());

		assert.equal(res.skipped, 1);
		assert.equal(res.accepted, seen.length - 1);
		assert.ok(written.length >= 3 && written.every((n, i) => i === 0 || n >= written[i - 1]), "each accepted step is written on its own");
		assert.ok(e.db.getById(oldId), "skipped forget is kept");
		assert.ok(!e.db.getById(dupId), "accepted fold deleted the duplicate");
		assert.equal(e.db.getById(keepId)?.usedCount, 9 + 0, "usage carries over (duplicate had none)");
		assert.equal(e.db.getById(verboseId)?.caption, "Build with npm run build");
		assert.deepEqual(e.db.getById(pathId)?.paths, ["package.json"]);

		// Stop ends the run at the first question and writes nothing.
		let asked = 0;
		const stopped = await e.consolidate({ cwd: proj, paths: false, approve: async () => (asked++, "stop") });
		assert.equal(asked, 1);
		assert.ok(stopped.stopped);
		assert.equal(stopped.updated + stopped.deleted, 0);
		assert.ok(e.db.getById(oldId));
	} finally {
		e.close();
	}
});
