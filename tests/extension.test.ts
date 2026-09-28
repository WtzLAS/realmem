import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { normalizeSettings, saveSettings } from "../src/config.ts";
import { clearProjectCache } from "../src/project.ts";

type Handler = (event: any, ctx: any) => any;

let srv: Server;
let base: string;
let proj: string;

before(async () => {
	srv = createServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			const body = data ? JSON.parse(data) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/embeddings") {
				const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
				res.end(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: [t.length % 7, 1, 0.5, 0.25] })), usage: { prompt_tokens: 1 } }));
				return;
			}
			const answers: Record<string, unknown> = {};
			for (const [k, q] of Object.entries<any>(body.questions)) {
				if (q.type === "noul") answers[k] = { type: "noul", noul: k === "unsafe" ? 0.01 : 0.95 };
				else if (q.type === "score") answers[k] = { type: "score", score: 2.5, legend: {}, probabilities: {}, confidence: 0.9 };
				else {
					const keys = Object.keys(q.criteria);
					const pick = k === "action" ? "Add" : k === "scope" ? "Project Shared" : "none";
					answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 0.9 : 0.1 / keys.length])), confidence: 0.9 };
				}
			}
			res.end(JSON.stringify({ model: "mock", answers }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	base = mkdtempSync(join(tmpdir(), "realmem-ext-"));
	proj = mkdtempSync(join(tmpdir(), "realmem-extproj-"));
	execFileSync("git", ["init", "-q"], { cwd: proj });
	process.env.REALMEM_HOME = base;
	saveSettings(
		join(base, "config.json"),
		normalizeSettings({ embedding: { endpoint: url, apiKey: "", model: "m", dimensions: 4 }, semif: { endpoint: url, apiKey: "", model: "m" } }),
	);
});

after(() => {
	srv.close();
	rmSync(base, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
	delete process.env.REALMEM_HOME;
});

test("extension registers tools, skill, command; freezes the session prompt; strips imported context files", async () => {
	const { default: realmem } = await import("../extensions/realmem/index.ts");
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let active = ["read", "bash", "ctx_memory", "realmem_recall"];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		on: (e: string, h: Handler) => {
			handlers.set(e, [...(handlers.get(e) ?? []), h]);
			return () => {};
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active,
		setActiveTools: (t: string[]) => {
			active = t;
		},
		sendUserMessage: () => {},
	};
	realmem(pi);
	assert.deepEqual([...tools.keys()].sort(), ["realmem_list", "realmem_recall", "realmem_remember", "realmem_status"]);
	assert.ok(commands.has("realmem"));
	const emit = async (e: string, ev: any, ctx: any) => {
		let last: any;
		for (const h of handlers.get(e) ?? []) last = await h(ev, ctx);
		return last;
	};
	const skills = await emit("resources_discover", { type: "resources_discover", cwd: proj, reason: "startup" }, {});
	assert.ok(skills.skillPaths[0].endsWith("skills"));

	const statuses: Record<string, string | undefined> = {};
	const ctx: any = {
		cwd: proj,
		hasUI: true,
		mode: "print",
		ui: { setStatus: (k: string, v: string) => (statuses[k] = v), notify: () => {} },
		sessionManager: { getBranch: () => entries },
		modelRegistry: { find: () => undefined, complete: async () => ({}) },
		model: undefined,
	};
	await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.ok(!active.includes("ctx_memory"), "other memory tools hidden");
	const blocked = await emit("tool_call", { type: "tool_call", toolCallId: "x", toolName: "ctx_memory", input: {} }, ctx);
	assert.equal(blocked?.block, true, "calls to other memory tools are blocked");
	assert.equal(await emit("tool_call", { type: "tool_call", toolCallId: "y", toolName: "bash", input: {} }, ctx), undefined);

	// Remember via the tool.
	const res = await tools.get("realmem_remember").execute("1", { caption: "Run tests with node --test", content: "`npm test` runs node --test over tests/*.test.ts." }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /remembered/);
	assert.equal(res.details.status, "added");
	const rec = await tools.get("realmem_recall").execute("2", { queries: ["how to run tests"] }, undefined, undefined, ctx);
	assert.match(rec.content[0].text, /<memory id="[A-Za-z0-9_-]{22}" scope="project-shared" used="0">/);
	const list = await tools.get("realmem_list").execute("3", {}, undefined, undefined, ctx);
	assert.match(list.content[0].text, /\| shared \| \* \| 1 \| Run tests/);
	const st = await tools.get("realmem_status").execute("4", {}, undefined, undefined, ctx);
	assert.match(st.content[0].text, /project-shared: 1 memories/);

	// Mark an AGENTS.md as imported, then the first prompt freezes the section and strips it.
	const { Realmem } = await import("../src/engine.ts");
	const { sha256 } = await import("../src/text.ts");
	const agents = { path: join(proj, "AGENTS.md"), content: "# Agents\nUse npm test." };
	const other = { path: join(proj, "NOTES.md"), content: "keep" };
	const e = new Realmem();
	e.db.markContextImported(sha256(agents.content), agents.path);
	e.close();

	const opts = () => ({ contextFiles: [agents, other], sections: {} as Record<string, string> });
	const ev1 = { type: "before_agent_start", prompt: "hi", systemPromptOptions: opts() };
	await emit("before_agent_start", ev1, ctx);
	assert.ok(ev1.systemPromptOptions.sections.realmem.includes("ONLY memory system"));
	assert.ok(ev1.systemPromptOptions.sections.realmem.includes("Run tests with node --test"), "top captions listed");
	assert.deepEqual(ev1.systemPromptOptions.contextFiles.map((f) => f.path), [other.path]);
	assert.equal(entries.length, 1, "snapshot persisted in session");

	// More memories later must not change the frozen prompt.
	await tools.get("realmem_remember").execute("5", { caption: "Lint with biome", content: "Run `npx biome check .` before committing." }, undefined, undefined, ctx);
	const ev2 = { type: "before_agent_start", prompt: "again", systemPromptOptions: opts() };
	await emit("before_agent_start", ev2, ctx);
	assert.equal(ev2.systemPromptOptions.sections.realmem, ev1.systemPromptOptions.sections.realmem, "prompt is byte-identical within a session");

	// Resumed session (new runtime) restores the same snapshot from the session entries.
	await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
	const ev3 = { type: "before_agent_start", prompt: "x", systemPromptOptions: opts() };
	await emit("before_agent_start", ev3, ctx);
	assert.equal(ev3.systemPromptOptions.sections.realmem, ev1.systemPromptOptions.sections.realmem);
	assert.equal(entries.length, 1);
	assert.match(statuses.realmem ?? "", /🧠 2/);
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("warns when .pi/realmem is ignored by git; /realmem fix-gitignore applies the verified fix", async () => {
	clearProjectCache();
	const gproj = mkdtempSync(join(tmpdir(), "realmem-extgi-"));
	execFileSync("git", ["init", "-q"], { cwd: gproj });
	writeFileSync(join(gproj, ".gitignore"), "node_modules/\n.pi/\n");
	try {
		const { default: realmem } = await import("../extensions/realmem/index.ts");
		const handlers = new Map<string, Array<(e: any, c: any) => any>>();
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		realmem({
			on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
			registerTool: (t: any) => tools.set(t.name, t),
			registerCommand: (n: string, c: any) => commands.set(n, c),
			getActiveTools: () => [],
			setActiveTools: () => {},
			getAllTools: () => [],
			appendEntry: () => {},
		} as any);
		const emit = async (e: string, ev: any, c: any) => {
			let last: any;
			for (const h of handlers.get(e) ?? []) last = await h(ev, c);
			return last;
		};
		const notes: Array<[string, string]> = [];
		let confirmed = 0;
		const ctx: any = {
			cwd: gproj,
			hasUI: true,
			mode: "print",
			ui: { setStatus: () => {}, notify: (m: string, l: string) => notes.push([m, l]), confirm: async () => (++confirmed, true) },
			sessionManager: { getBranch: () => [] },
			modelRegistry: { find: () => undefined, complete: async () => ({}) },
			model: undefined,
		};
		await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const warn = notes.find(([m]) => m.includes("is ignored by git"));
		assert.ok(warn, notes.map((n) => n[0]).join("\n"));
		assert.equal(warn[1], "warning");
		assert.match(warn[0], /\.gitignore:2: `\.pi\/`/);
		assert.match(warn[0], /!\/\.pi\/realmem\/\*\*/);
		assert.match(warn[0], /\/realmem fix-gitignore/);

		// Status shows it too, and a shared remember says the memory will not be committed.
		const st = await tools.get("realmem_status").execute("s", {}, undefined, undefined, ctx);
		assert.match(st.content[0].text, /WARNING: The shared memory store \.pi\/realmem\/ is ignored by git/);
		const r = await tools.get("realmem_remember").execute("r", { caption: "Build with make", content: "Run make all." }, undefined, undefined, ctx);
		assert.match(r.content[0].text, /is ignored by git, so this memory will not be committed/);

		// The command appends the fix after confirmation and re-checks.
		notes.length = 0;
		await commands.get("realmem").handler("fix-gitignore", ctx);
		assert.equal(confirmed, 1);
		assert.match(readFileSync(join(gproj, ".gitignore"), "utf8"), /\.pi\/\n\n# realmem: share project memories \(\.pi\/realmem\) through git\n!\/\.pi\/\n\/\.pi\/\*\n!\/\.pi\/realmem\/\n!\/\.pi\/realmem\/\*\*\n$/);
		assert.ok(notes.some(([m, l]) => l === "info" && m.includes("no longer ignored")), notes.map((n) => n[0]).join("\n"));
		const ls = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: gproj, encoding: "utf8" });
		assert.match(ls, /^\.pi\/realmem\/.+\.md$/m, "the shared memory is now visible to git");
		// Running it again reports nothing to do.
		notes.length = 0;
		await commands.get("realmem").handler("fix-gitignore", ctx);
		assert.ok(notes.some(([m]) => m.includes("is not ignored by git")));
		await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	} finally {
		rmSync(gproj, { recursive: true, force: true });
	}
});
