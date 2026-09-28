/**
 * Drives the /realmem pages headlessly: a fake ctx.ui.custom() instantiates each
 * component, renders it (checking every line fits the width) and feeds scripted keys.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeSettings, saveSettings } from "../src/config.ts";
import { Realmem } from "../src/engine.ts";
import { openDebug } from "../extensions/realmem/debug-page.ts";
import { openManage } from "../extensions/realmem/manage-page.ts";
import { openSettings } from "../extensions/realmem/settings-page.ts";

const KEY = { enter: "\r", esc: "\x1b", backspace: "\x7f", down: "\x1b[B", up: "\x1b[A" };
const WIDTH = 72;

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	underline: (t: string) => t,
	strikethrough: (t: string) => t,
} as unknown as Theme;

type Script = (c: Component, frame: () => string[]) => void | Promise<void>;

function fakeCtx(cwd: string, scripts: Script[], answers: { select?: string[]; confirm?: boolean[]; editor?: (string | undefined)[]; input?: string[] }) {
	const notes: Array<[string, string]> = [];
	const frames: string[][] = [];
	const tui = { terminal: { rows: 30, columns: WIDTH }, requestRender() {} };
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: { getAvailable: () => [{ provider: "p", id: "m", name: "M" }], find: () => undefined, complete: async () => ({}) },
		ui: {
			notify: (m: string, t = "info") => notes.push([t, m]),
			setStatus() {},
			select: async () => answers.select?.shift(),
			confirm: async () => answers.confirm?.shift() ?? false,
			editor: async () => answers.editor?.shift(),
			input: async () => answers.input?.shift(),
			custom: <T>(factory: (tui: unknown, theme: Theme, kb: unknown, done: (v: T) => void) => Component | Promise<Component>) =>
				new Promise<T>((resolve, reject) => {
					let comp: (Component & { dispose?(): void }) | undefined;
					let finished = false;
					const done = (v: T) => {
						finished = true;
						comp?.dispose?.();
						resolve(v);
					};
					Promise.resolve(factory(tui, theme, {}, done))
						.then(async (c) => {
							comp = c;
							if (finished) return comp.dispose?.();
							const frame = () => {
								const lines = c.render(WIDTH);
								for (const l of lines) assert.ok(visibleWidth(l) <= WIDTH, `line wider than ${WIDTH}: ${JSON.stringify(l)}`);
								frames.push(lines);
								return lines;
							};
							frame();
							const script = scripts.shift();
							if (!script) throw new Error("no script left for this screen");
							await script(c, frame);
							const guard = setTimeout(() => {
								if (!finished) reject(new Error(`screen still open after its script:\n${c.render(WIDTH).join("\n")}`));
							}, 5000);
							guard.unref();
						})
						.catch(reject);
				}),
		},
	};
	return { ctx: ctx as any, notes, frames };
}

const type = (c: Component, s: string) => {
	for (const ch of s) c.handleInput?.(ch);
};

let srv: Server;
let url: string;
let base: string;
let proj: string;

before(async () => {
	initTheme("dark");
	srv = createServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			const body = data ? JSON.parse(data) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "m" }, { id: "semif-other" }] }));
			if (req.url === "/v1/embeddings") {
				const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
				return res.end(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: [1, t.length % 5, 0.5, 0.1] })) }));
			}
			const answers: Record<string, unknown> = {};
			for (const [k, q] of Object.entries<any>(body.questions)) {
				if (q.type === "noul") answers[k] = { type: "noul", noul: k === "unsafe" ? 0.01 : 0.95 };
				else if (q.type === "score" && k === "path_urgency")
					answers[k] = { type: "score", score: 1.7, legend: { 0: "Low", 1: "Mid", 2: "High" }, probabilities: { 0: 0.05, 1: 0.2, 2: 0.75 }, confidence: 0.6 };
				else if (q.type === "score") answers[k] = { type: "score", score: 2.4, legend: { 0: "trivial" }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.3, 3: 0.5 }, confidence: 0.4 };
				else {
					const keys = Object.keys(q.criteria);
					const pick = k === "action" ? "Add" : k === "scope" ? "Global" : "none";
					answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 0.9 : 0.1 / keys.length])), confidence: 0.9 };
				}
			}
			res.end(JSON.stringify({ model: "mock", answers }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	base = mkdtempSync(join(tmpdir(), "realmem-tui-"));
	proj = mkdtempSync(join(tmpdir(), "realmem-tuiproj-"));
	saveSettings(join(base, "config.json"), normalizeSettings({ embedding: { endpoint: url, apiKey: "", model: "m", dimensions: 4 }, semif: { endpoint: url, apiKey: "", model: "m" } }));
});

after(() => {
	srv.close();
	rmSync(base, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
});

test("debug page: dry run shows every step and writes only on request", async () => {
	const e = new Realmem(base);
	try {
		let report: string[] = [];
		const { ctx, notes } = fakeCtx(
			proj,
			[
				() => {}, // loader: wait for the dry run
				(c, frame) => {
					// Page through the whole scrollable report.
					for (let i = 0; i < 20; i++) {
						report.push(...frame());
						c.handleInput?.(" ");
					}
					c.handleInput?.("w");
				},
			],
			{ editor: ["Prefer ripgrep\nUse `rg` instead of grep for code search; it respects .gitignore."], confirm: [true] },
		);
		await openDebug(ctx, e, () => {});
		const text = report.join("\n");
		for (const s of ["Result: would add to global", "Embedding", "Similar memories", "SemIf judge", "Decision", "w write to memory"]) assert.ok(text.includes(s), `report shows ${s}`);
		const files = readdirSync(join(base, "global")).filter((f) => f.endsWith(".md"));
		assert.equal(files.length, 1, "written after confirming");
		assert.match(readFileSync(join(base, "global", files[0]), "utf8"), /caption: Prefer ripgrep/);
		assert.ok(notes.some(([, m]) => m.includes("remembered")));
	} finally {
		e.close();
	}
});

test("manage page: browse, filter, view metadata, edit and delete", async () => {
	const e = new Realmem(base);
	try {
		await e.remember({ caption: "Prefer fd over find", content: "Use `fd` for file search.", source: "user", force: true, scope: "global" }, { cwd: proj });
		let detail: string[] = [];
		const { ctx } = fakeCtx(
			proj,
			[
				(c) => {
					type(c, "fd over");
					c.handleInput?.(KEY.enter);
				},
				(c, frame) => {
					detail = frame();
					c.handleInput?.("e");
				},
				(c) => c.handleInput?.("d"),
				(c) => c.handleInput?.(KEY.esc),
			],
			{ editor: ["Use `fd` (fd-find) for file search; it is faster than find."], confirm: [true] },
		);
		await openManage(ctx, e);
		const text = detail.join("\n");
		for (const s of ["Prefer fd over find", "scope", "global", "used", "file", "content"]) assert.ok(text.includes(s), `detail shows ${s}`);
		const files = readdirSync(join(base, "global")).filter((f) => f.endsWith(".md"));
		assert.equal(files.length, 1, "only the ripgrep memory is left");
		assert.ok(!readFileSync(join(base, "global", files[0]), "utf8").includes("fd-find"));
	} finally {
		e.close();
	}
});

test("path urgency: debug page shows the judge's breakdown, manage page shows the stored one", async () => {
	const e = new Realmem(base);
	try {
		let report = "";
		const { ctx } = fakeCtx(
			proj,
			[
				() => {}, // loader
				(c) => c.handleInput?.("p"), // first report: set candidate paths
				() => {}, // loader (rerun with paths)
				(c, frame) => {
					for (let i = 0; i < 20; i++) {
						report += `${frame().join("\n")}\n`;
						c.handleInput?.(" ");
					}
					c.handleInput?.("w");
				},
			],
			{ editor: ["Migrations are append-only\nNever edit a migration that was released; add a new one.", "db/migrations"], confirm: [true] },
		);
		await openDebug(ctx, e, () => {});
		for (const s of ["Path urgency", "candidate: 1.70/2 → high (shown in full on path touch)", "High", "75.0%", "confidence 60.0%", "on write: stored with the new memory", "p paths: db/mi"])
			assert.ok(report.includes(s), `debug report shows ${s}`);

		const m = e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 99, offset: 0 }).find((x) => x.caption === "Migrations are append-only");
		assert.ok(m, "committed");
		const g = e.db.getUrgency(m.store, m.id);
		assert.equal(g?.score, 1.7);
		assert.deepEqual(g?.probabilities, { 0: 0.05, 1: 0.2, 2: 0.75 });
		assert.equal(g?.confidence, 0.6);

		let list = "";
		let detail = "";
		const { ctx: ctx2 } = fakeCtx(
			proj,
			[
				(c, frame) => {
					type(c, "append-only");
					list = frame().join("\n");
					c.handleInput?.(KEY.enter);
				},
				(c, frame) => {
					for (let i = 0; i < 5; i++) {
						detail += `${frame().join("\n")}\n`;
						c.handleInput?.(" ");
					}
					c.handleInput?.(KEY.esc);
				},
				(c) => c.handleInput?.(KEY.esc),
			],
			{},
		);
		await openManage(ctx2, e);
		assert.ok(list.includes("G● "), `list shows the urgency tier:\n${list}`);
		for (const s of ["path urgency", "1.70/2 → high (shown in full on path touch)", "judged when remembered", "High", "75.0%", "confidence 60.0%", "full ≥ 1.50"])
			assert.ok(detail.includes(s), `manage detail shows ${s}`);
		await e.deleteMemory(m);
	} finally {
		e.close();
	}
});

test("settings page: SemIf model is picked from the server's /v1/models list", async () => {
	const e = new Realmem(base);
	try {
		let picker = "";
		const { ctx } = fakeCtx(
			proj,
			[
				async (c, frame) => {
					type(c, "SemIf model");
					c.handleInput?.(KEY.enter); // open the remote picker
					for (let i = 0; i < 50 && !frame().join("\n").includes("on the server"); i++) await new Promise((r) => setTimeout(r, 10));
					picker = frame().join("\n");
					type(c, "other");
					c.handleInput?.(KEY.enter);
					c.handleInput?.(KEY.esc);
				},
			],
			{},
		);
		await openSettings(ctx, e);
		for (const s of ["SemIf model · 2 models on the server", "semif-other", "(auto)", "type a name"]) assert.ok(picker.includes(s), `picker shows ${s}:\n${picker}`);
		assert.equal(e.settings.semif.model, "semif-other");
		assert.equal(JSON.parse(readFileSync(join(base, "config.json"), "utf8")).semif.model, "semif-other", "persisted");
	} finally {
		e.close();
	}
});

test("settings page: edit a number through the submenu, save, clear the embedding cache", async () => {
	const e = new Realmem(base);
	try {
		await e.remember({ caption: "Prefer jq for JSON", content: "Use `jq` to inspect JSON output.", source: "user", force: true, scope: "global" }, { cwd: proj });
		await e.index.embedMissing();
		const fp = e.index.fingerprint;
		assert.ok(e.db.embeddingStats(fp).cached > 0);
		const { ctx, notes, frames } = fakeCtx(
			proj,
			[
				(c, frame) => {
					type(c, "dimensions");
					c.handleInput?.(KEY.enter); // open the input submenu
					const sub = frame().join("\n");
					assert.ok(sub.includes("Embedding dimensions"));
					for (let i = 0; i < 6; i++) c.handleInput?.(KEY.backspace);
					type(c, "99999");
					c.handleInput?.(KEY.enter); // rejected: above the maximum
					assert.ok(frame().join("\n").includes("maximum is 4096"));
					for (let i = 0; i < 6; i++) c.handleInput?.(KEY.backspace);
					type(c, "8");
					c.handleInput?.(KEY.enter); // rejected: below the minimum
					assert.ok(frame().join("\n").includes("minimum is 32"));
					c.handleInput?.(KEY.backspace);
					type(c, "64");
					c.handleInput?.(KEY.enter);
					c.handleInput?.(KEY.esc);
				},
			],
			{},
		);
		await openSettings(ctx, e);
		assert.ok(frames.length >= 2);
		assert.equal(e.settings.embedding.dimensions, 64);
		assert.equal(JSON.parse(readFileSync(join(base, "config.json"), "utf8")).embedding.dimensions, 64, "persisted");
		assert.ok(notes.some(([, m]) => m.includes("embedding cache cleared")));
		assert.equal(e.db.embeddingStats(fp).cached, 0);
		assert.ok(existsSync(join(base, "realmem.sqlite")));
	} finally {
		e.close();
	}
});
