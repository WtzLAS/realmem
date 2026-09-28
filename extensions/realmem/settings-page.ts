/**
 * /realmem settings page.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, type SettingItem, SettingsList, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { EmbeddingClient, SemIfClient } from "../../src/api.ts";
import { DEFAULT_SETTINGS, embeddingFingerprint, maskSecret, normalizeSettings, type Settings } from "../../src/config.ts";
import type { Realmem } from "../../src/engine.ts";
import { ActionSubmenu, FilterPicker, InputSubmenu, RemotePicker } from "./ui.ts";

const NOT_SET = "(not set)";
const AUTO_MODEL = "(auto)";
const TYPE_MODEL = "__type";

type Getter = (s: Settings) => string;
type Setter = (s: Settings, v: string) => void;

interface FieldDef {
	id: string;
	label: string;
	description: string;
	get: Getter;
	set?: Setter;
	kind: "text" | "secret" | "number" | "cycle" | "model" | "remote-model" | "action";
	/** remote-model: list the server's models for the draft settings. */
	listModels?: (draft: Settings, signal: AbortSignal) => Promise<string[]>;
	values?: string[];
	min?: number;
	max?: number;
	integer?: boolean;
	run?: (engine: Realmem, signal: AbortSignal, theme: Theme) => Promise<string[]>;
}

function num(v: string): number {
	return Number(v.trim());
}

function jsonPreview(v: unknown, max = 600): string {
	const s = JSON.stringify(v);
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fields(): FieldDef[] {
	const f: FieldDef[] = [
		{
			id: "rewriteModel",
			label: "Edit/Merge model",
			description: "Pi model that rewrites memories on Edit and Merge. Empty = the session's current model.",
			get: (s) => s.rewriteModel || "(session model)",
			set: (s, v) => {
				s.rewriteModel = v === "(session model)" ? "" : v;
			},
			kind: "model",
		},
		{
			id: "embedding.endpoint",
			label: "Embedding endpoint",
			description: "Base URL of the OpenAI-compatible embeddings API (…/v1/embeddings). Changing it clears the embedding cache.",
			get: (s) => s.embedding.endpoint || NOT_SET,
			set: (s, v) => {
				s.embedding.endpoint = v === NOT_SET ? "" : v;
			},
			kind: "text",
		},
		{
			id: "embedding.apiKey",
			label: "Embedding API key",
			description: "Bearer key. Use $VAR or env:VAR to read it from the environment instead of storing it.",
			get: (s) => maskSecret(s.embedding.apiKey),
			set: (s, v) => {
				s.embedding.apiKey = v === "-" ? "" : v;
			},
			kind: "secret",
		},
		{
			id: "embedding.model",
			label: "Embedding model",
			description: "Picked from the server's /v1/models list. (auto) = the server's only model. Changing it clears the embedding cache.",
			get: (s) => s.embedding.model || AUTO_MODEL,
			set: (s, v) => {
				s.embedding.model = v === AUTO_MODEL ? "" : v;
			},
			kind: "remote-model",
			listModels: (draft, signal) => new EmbeddingClient(draft).listModels(signal),
		},
		{
			id: "embedding.dimensions",
			label: "Embedding dimensions",
			description: "Matryoshka dimensions (32-4096). Smaller is faster and cheaper to store. Changing it clears the embedding cache.",
			get: (s) => String(s.embedding.dimensions),
			set: (s, v) => {
				s.embedding.dimensions = num(v);
			},
			kind: "number",
			min: 32,
			max: 4096,
			integer: true,
		},
		{
			id: "embedding.test",
			label: "  ↳ Test embedding API",
			description: "Call /v1/models and embed a short text with the current settings.",
			get: () => "run",
			kind: "action",
			run: async (engine, signal, theme) => {
				const t0 = Date.now();
				const models = await engine.embeddingClient.health(signal);
				const r = await engine.embeddingClient.embed(["realmem connectivity test"], "document", signal);
				return [
					theme.fg("success", `OK in ${Date.now() - t0} ms`),
					`models: ${jsonPreview(models)}`,
					`vector: ${r.vectors[0].length} dims, ${r.tokens} tokens, first values [${Array.from(r.vectors[0].slice(0, 4))
						.map((x) => x.toFixed(4))
						.join(", ")}…]`,
				];
			},
		},
		{
			id: "semif.endpoint",
			label: "SemIf endpoint",
			description: "Base URL of the System One API (…/v1/systemone), e.g. the SemIf exl3 bridge or TypeSafe Jev.",
			get: (s) => s.semif.endpoint || NOT_SET,
			set: (s, v) => {
				s.semif.endpoint = v === NOT_SET ? "" : v;
			},
			kind: "text",
		},
		{
			id: "semif.apiKey",
			label: "SemIf API key",
			description: "Bearer key. Use $VAR or env:VAR to read it from the environment instead of storing it.",
			get: (s) => maskSecret(s.semif.apiKey),
			set: (s, v) => {
				s.semif.apiKey = v === "-" ? "" : v;
			},
			kind: "secret",
		},
		{
			id: "semif.model",
			label: "SemIf model",
			description: "Picked from the server's /v1/models list. (auto) = the server's only model.",
			get: (s) => s.semif.model || AUTO_MODEL,
			set: (s, v) => {
				s.semif.model = v === AUTO_MODEL ? "" : v;
			},
			kind: "remote-model",
			listModels: (draft, signal) => new SemIfClient(draft).listModels(signal),
		},
		{
			id: "semif.maxQuestions",
			label: "SemIf questions per request",
			description: "Split the judge's questions over several requests if the server limits --max-questions (1-255).",
			get: (s) => String(s.semif.maxQuestions),
			set: (s, v) => {
				s.semif.maxQuestions = num(v);
			},
			kind: "number",
			min: 1,
			max: 255,
			integer: true,
		},
		{
			id: "semif.test",
			label: "  ↳ Test SemIf API",
			description: "Call /v1/models and evaluate a tiny question with the current settings.",
			get: () => "run",
			kind: "action",
			run: async (engine, signal, theme) => {
				const t0 = Date.now();
				const models = await engine.semifClient.health(signal);
				const r = await engine.semifClient.evaluate(
					"The project is built with `pnpm build`.",
					{ ok: { type: "noul", instructions: "Does the state describe how to build a project?" } },
					signal,
				);
				return [theme.fg("success", `OK in ${Date.now() - t0} ms`), `models: ${jsonPreview(models)}`, `answer: ${jsonPreview(r.response.answers)}`];
			},
		},
	];
	const th = (id: keyof Settings["thresholds"], label: string, description: string, max = 1): FieldDef => ({
		id: `thresholds.${id}`,
		label,
		description,
		get: (s) => String(s.thresholds[id]),
		set: (s, v) => {
			s.thresholds[id] = num(v);
		},
		kind: "number",
		min: 0,
		max,
	});
	f.push(
		th("minImportance", "Min importance (0-3)", "Expected importance level needed to Add/Merge: 0 trivial, 1 minor inconvenience, 2 wasted work, 3 broken or harmful result.", 3),
		th("minDurable", "Min P(durable)", "Probability that the fact is durable (not transient task status) needed to change memory."),
		th("maxUnsafe", "Max P(unsafe)", "Refuse a candidate when the judge's probability of a secret or manipulation attempt reaches this."),
		th("covered", "Covered-by threshold", "Minimum probability for a covered_by pick to count (→ Reinforce)."),
		th("conflict", "Conflict threshold", "Minimum probability for a conflict_with pick to count (→ Edit)."),
		th("merge", "Merge threshold", "Minimum probability for a merge_with pick to count (→ Merge)."),
		th("scopeMove", "Scope override threshold", "Scope probability at which a fact is added to its own scope instead of editing/merging a memory in another scope."),
		th("recallMinSimilarity", "Recall min similarity", "Cosine similarity below which vector hits are ignored in recall."),
		th("urgencyHigh", "Path urgency: full (0-2)", "Path urgency score at or above which a path-scoped memory is shown in full when the agent touches its paths.", 2),
		th("urgencyMid", "Path urgency: caption (0-2)", "Path urgency score at or above which only the caption is shown; below it the memory is only counted.", 2),
		{
			id: "paths.inject",
			label: "Show path notes on touch",
			description: "Append memories attached to touched paths to the tool result (<realmem-path-notes>), once per session branch.",
			get: (s) => (s.paths.inject ? "on" : "off"),
			set: (s, v) => {
				s.paths.inject = v === "on";
			},
			kind: "cycle",
			values: ["on", "off"],
		},
		{
			id: "paths.staleCheck",
			label: "Flag missing paths",
			description: "At session start, flag memories whose paths no longer exist (with rename suggestions from git).",
			get: (s) => (s.paths.staleCheck ? "on" : "off"),
			set: (s, v) => {
				s.paths.staleCheck = v === "on";
			},
			kind: "cycle",
			values: ["on", "off"],
		},
		{
			id: "paths.maxFull",
			label: "Path notes: max full",
			description: "Max memories shown in full per tool result (others fall back to captions).",
			get: (s) => String(s.paths.maxFull),
			set: (s, v) => {
				s.paths.maxFull = num(v);
			},
			kind: "number",
			min: 0,
			max: 20,
			integer: true,
		},
		{
			id: "paths.maxCaptions",
			label: "Path notes: max captions",
			description: "Max captions per tool result (others are only counted).",
			get: (s) => String(s.paths.maxCaptions),
			set: (s, v) => {
				s.paths.maxCaptions = num(v);
			},
			kind: "number",
			min: 0,
			max: 50,
			integer: true,
		},
		{
			id: "paths.charBudget",
			label: "Path notes: char budget",
			description: "Character budget for full memory contents per tool result.",
			get: (s) => String(s.paths.charBudget),
			set: (s, v) => {
				s.paths.charBudget = num(v);
			},
			kind: "number",
			min: 500,
			max: 100000,
			integer: true,
		},
		{
			id: "candidates.max",
			label: "Max similar memories to judge",
			description: "Up to this many similar memories (≤254) are sent to SemIf as options.",
			get: (s) => String(s.candidates.max),
			set: (s, v) => {
				s.candidates.max = num(v);
			},
			kind: "number",
			min: 1,
			max: 254,
			integer: true,
		},
		{
			id: "candidates.stateTokenBudget",
			label: "Judge state token budget",
			description: "Approximate token budget for the SemIf state; must fit the server's --cache-size together with each question.",
			get: (s) => String(s.candidates.stateTokenBudget),
			set: (s, v) => {
				s.candidates.stateTokenBudget = num(v);
			},
			kind: "number",
			min: 500,
			max: 1_000_000,
			integer: true,
		},
		{
			id: "recall.pageSize",
			label: "Recall page size",
			description: "Memories returned per realmem_recall page.",
			get: (s) => String(s.recall.pageSize),
			set: (s, v) => {
				s.recall.pageSize = num(v);
			},
			kind: "number",
			min: 1,
			max: 100,
			integer: true,
		},
		{
			id: "prompt.topCaptions",
			label: "Captions in session prompt",
			description: "How many most-used memory captions are listed in the system prompt when a session starts (frozen for the session).",
			get: (s) => String(s.prompt.topCaptions),
			set: (s, v) => {
				s.prompt.topCaptions = num(v);
			},
			kind: "number",
			min: 0,
			max: 200,
			integer: true,
		},
		{
			id: "prompt.stripContextFiles",
			label: "Strip AGENTS.md / CLAUDE.md",
			description: "imported = remove context files whose current content was imported with /realmem import; always; never. Applies to new sessions.",
			get: (s) => s.prompt.stripContextFiles,
			set: (s, v) => {
				s.prompt.stripContextFiles = v as Settings["prompt"]["stripContextFiles"];
			},
			kind: "cycle",
			values: ["imported", "always", "never"],
		},
		{
			id: "prompt.hideTools",
			label: "Hide other memory tools",
			description: "Comma-separated tool names of other memory systems to deactivate at session start (e.g. ctx_memory).",
			get: (s) => s.prompt.hideTools.join(", ") || "(none)",
			set: (s, v) => {
				s.prompt.hideTools = v === "(none)" ? [] : v.split(/[,\s]+/).filter(Boolean);
			},
			kind: "text",
		},
		{
			id: "safety.secretAction",
			label: "On secrets",
			description: "reject = refuse candidates that contain credentials; redact = store them with the secret replaced.",
			get: (s) => s.safety.secretAction,
			set: (s, v) => {
				s.safety.secretAction = v as Settings["safety"]["secretAction"];
			},
			kind: "cycle",
			values: ["reject", "redact"],
		},
		{
			id: "reset",
			label: "Reset thresholds to defaults",
			description: "Restore every threshold and limit (endpoints and keys are kept).",
			get: () => "run",
			kind: "action",
		},
	);
	return f;
}

export async function openSettings(ctx: ExtensionCommandContext, engine: Realmem): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`realmem settings live in ${engine.paths.config}`, "info");
		return;
	}
	const defs = fields();
	let draft = normalizeSettings(structuredClone(engine.settings));
	let dirty = false;
	const fpBefore = embeddingFingerprint(engine.settings);

	const models: SelectItem[] = [
		{ value: "(session model)", label: "(session model)", description: "use the model of the current session" },
		...ctx.modelRegistry.getAvailable().map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, description: m.name })),
	];

	/** Model list from the server (draft endpoint and key), then optionally a typed name. */
	const remoteModelPicker = (tui: TUI, theme: Theme, d: FieldDef, current: string, close: (v?: string) => void): Component => {
		let child: Component;
		const typed = () =>
			new InputSubmenu({
				theme,
				label: d.label,
				help: "Model name sent to the API, when the server does not list it. Empty = (auto).",
				value: current === AUTO_MODEL ? "" : current,
				done: (v) => close(v === undefined ? undefined : v || AUTO_MODEL),
			});
		child = new RemotePicker({
			tui,
			theme,
			title: d.label,
			selected: current,
			load: async (signal) => {
				const probe = normalizeSettings(structuredClone(draft));
				const ids = await (d.listModels?.(probe, signal) ?? Promise.resolve([]));
				const items: SelectItem[] = ids.map((id) => ({ value: id, label: id, description: id === current ? "current" : "listed by the server" }));
				if (current !== AUTO_MODEL && !ids.includes(current)) items.unshift({ value: current, label: current, description: "current (not listed by the server)" });
				return items;
			},
			extra: [
				{ value: AUTO_MODEL, label: AUTO_MODEL, description: "no model set: use the server's only model" },
				{ value: TYPE_MODEL, label: "✎ type a name…", description: "enter a model name by hand" },
			],
			done: (v) => {
				if (v === TYPE_MODEL) {
					child = typed();
					tui.requestRender();
					return;
				}
				close(v);
			},
		});
		return {
			render: (w: number) => child.render(w),
			handleInput: (data: string) => child.handleInput?.(data),
			invalidate: () => child.invalidate(),
		};
	};

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let list: SettingsList;
		const items: SettingItem[] = defs.map((d) => ({
			id: d.id,
			label: d.label,
			description: d.description,
			currentValue: d.get(draft),
			values: d.kind === "cycle" ? d.values : undefined,
			submenu:
				d.kind === "cycle"
					? undefined
					: (current, close) => {
							if (d.kind === "model") {
								return new FilterPicker({ theme, title: d.label, items: models, selected: current, done: (v) => close(v) });
							}
							if (d.kind === "remote-model") return remoteModelPicker(tui, theme, d, current, close);
							if (d.kind === "action") {
								if (d.id === "reset") {
									const keep = { embedding: draft.embedding, semif: draft.semif, rewriteModel: draft.rewriteModel };
									draft = normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), ...keep });
									dirty = true;
									for (const x of defs) list.updateValue(x.id, x.get(draft));
									return new ActionSubmenu({ tui, theme, title: d.label, run: async () => ["Thresholds and limits reset. Esc on the list saves."], done: () => close() });
								}
								// Test against the draft settings without persisting them.
								const probe = normalizeSettings(structuredClone(draft));
								return new ActionSubmenu({
									tui,
									theme,
									title: d.label,
									run: async (signal) => {
										const saved = engine.settings;
										engine.applySettings(probe, false);
										try {
											return (await d.run?.(engine, signal, theme)) ?? [];
										} finally {
											engine.applySettings(saved, false);
										}
									},
									done: () => close(),
								});
							}
							const raw = d.kind === "secret" ? "" : d.get(draft);
							return new InputSubmenu({
								theme,
								label: d.label,
								help: d.kind === "secret" ? `${d.description} Current: ${d.get(draft)}. Enter "-" to clear.` : d.description,
								value: raw === "(none)" || raw === "(session model)" || raw === NOT_SET ? "" : raw,
								secret: d.kind === "secret",
								validate: (v) => {
									if (d.kind !== "number") return undefined;
									const n = Number(v);
									if (!Number.isFinite(n)) return "enter a number";
									if (d.integer && !Number.isInteger(n)) return "enter a whole number";
									if (d.min !== undefined && n < d.min) return `minimum is ${d.min}`;
									if (d.max !== undefined && n > d.max) return `maximum is ${d.max}`;
									return undefined;
								},
								done: (v) => {
									if (v === undefined) return close();
									d.set?.(draft, v);
									draft = normalizeSettings(draft);
									dirty = true;
									close(d.get(draft));
								},
							});
						},
		}));

		list = new SettingsList(
			items,
			Math.min(items.length, Math.max(6, tui.terminal.rows - 10)),
			getSettingsListTheme(),
			(id, value) => {
				const d = defs.find((x) => x.id === id);
				if (!d || d.kind === "action") return;
				if (d.kind === "cycle" || d.kind === "model" || d.kind === "remote-model") {
					d.set?.(draft, value);
					draft = normalizeSettings(draft);
					dirty = true;
				}
			},
			() => done(),
			{ enableSearch: true },
		);

		const header: Component = {
			render: (width: number) => [
				truncateToWidth(theme.fg("accent", theme.bold("realmem settings")), width),
				truncateToWidth(theme.fg("dim", `${engine.paths.config} · changes are saved when you close this page`), width),
				"",
			],
			invalidate() {},
		};
		return {
			render: (width: number) => [...header.render(width), ...list.render(width)],
			invalidate: () => list.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!dirty) return;
	const { embeddingCleared } = engine.applySettings(draft, true);
	const fpAfter = embeddingFingerprint(draft);
	if (embeddingCleared || fpAfter !== fpBefore) {
		ctx.ui.notify("realmem: embedding settings changed, embedding cache cleared; re-embedding in the background", "info");
		engine.sync(ctx.cwd);
		void engine.embedInBackground();
	} else {
		ctx.ui.notify("realmem: settings saved", "info");
	}
}
