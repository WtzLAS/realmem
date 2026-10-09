/**
 * Model-facing tools: realmem_recall, realmem_remember, realmem_status, realmem_list, realmem_forget.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CandidateError, type Realmem } from "../../src/engine.ts";
import { SCOPE_LABEL } from "../../src/files.ts";
import { formatList, formatOutcomeForModel, formatRecall, formatStatus, memoryEnvelope, SCOPE_ARG } from "../../src/format.ts";
import { type Completer, createCompleter, createRewriter, type Rewriter, resolveModel } from "../../src/rewrite.ts";

export interface ToolHost {
	engine(ctx: ExtensionContext): Realmem;
	/** Called after a successful remember (e.g. to refresh status, drain the queue). */
	afterRemember(ctx: ExtensionContext, status: string): void;
	/** Project-relative paths the agent touched recently in this session. */
	recentPaths(): string[];
	/** Memories the model has now seen in full (so path notes do not repeat them). */
	markSeen(ids: string[]): void;
}

const SCOPE_VALUES = ["global", "project-shared", "project-personal"] as const;

export function rewriterFor(engine: Realmem, ctx: ExtensionContext): { rewriter?: Rewriter; completer?: Completer; model?: string; error?: string } {
	const model = resolveModel(engine.settings.rewriteModel, ctx.modelRegistry, ctx.model);
	if (!model) {
		return { error: engine.settings.rewriteModel ? `rewrite model ${engine.settings.rewriteModel} not found` : "no model selected for rewrites" };
	}
	return {
		rewriter: createRewriter(ctx.modelRegistry, model),
		completer: createCompleter(ctx.modelRegistry, model),
		model: `${model.provider}/${model.id}`,
	};
}

function text(t: string) {
	return [{ type: "text" as const, text: t }];
}

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	pi.registerTool({
		name: "realmem_recall",
		label: "realmem recall",
		description:
			"Search long-term memory (realmem) with hybrid semantic + keyword search. Pass several keywords or short statements describing the task, component, command, error, or question. Results are ordered by path (memories about the given or recently touched paths first), then most used; paginated. Pass `paths` alone to list the memories attached to those files/directories, or `ids` to read memories shown as captions.",
		promptSnippet: "Search long-term memory; call it before starting any work and whenever you enter a new area",
		promptGuidelines: [
			"Call realmem_recall before starting any task (and again when switching areas or hitting surprises), with 2-8 keywords or short statements covering the task.",
		],
		parameters: Type.Object({
			queries: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
					maxItems: 16,
					description: "Keywords or short statements, e.g. ['release process', 'publish npm package', 'CI secrets']",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
					maxItems: 16,
					description: "Files or directories (relative to the cwd) the question is about; their memories rank first. Alone: list memories attached to them.",
				}),
			),
			ids: Type.Optional(Type.Array(Type.String({ minLength: 6, maxLength: 40 }), { maxItems: 32, description: "Memory ids to read in full" })),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "Result page (default 1)" })),
			scope: Type.Optional(StringEnum(SCOPE_VALUES, { description: "Only search one scope" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const engine = host.engine(ctx);
			const queries = params.queries ?? [];
			const parts: string[] = [];
			const shown: string[] = [];
			let details: Record<string, unknown> = {};
			if (params.ids && params.ids.length > 0) {
				const { found, missing } = engine.getMemories(ctx.cwd, params.ids);
				for (const m of found) {
					parts.push(memoryEnvelope(m, 8000));
					shown.push(m.id);
				}
				if (missing.length > 0) parts.push(`Not found: ${missing.join(", ")}`);
				details.ids = found.map((m) => m.id);
			}
			if (queries.length > 0 || (params.paths && params.paths.length > 0) || parts.length === 0) {
				if (queries.length === 0 && !(params.paths && params.paths.length > 0)) throw new Error("pass queries, paths or ids");
				const r = await engine.recall(ctx.cwd, queries, {
					page: params.page,
					scope: params.scope ? SCOPE_ARG[params.scope] : undefined,
					signal,
					paths: params.paths,
					focus: host.recentPaths(),
				});
				parts.push(formatRecall(r, queries.length > 0 ? queries : (params.paths ?? [])));
				shown.push(...r.items.map((i) => i.memory.id));
				details = { ...details, ids: [...((details.ids as string[]) ?? []), ...r.items.map((i) => i.memory.id)], total: r.total, page: r.page, pages: r.pages, embedError: r.embedError };
			}
			host.markSeen(shown);
			return { content: text(parts.join("\n\n")), details };
		},
	});

	pi.registerTool({
		name: "realmem_remember",
		label: "realmem remember",
		description:
			"Store one durable fact in long-term memory (realmem). Requires a short caption (one-line title) and self-contained content. A surprise gate checks it against existing memories: duplicates only reinforce the old memory, contradictions edit it, related facts are merged, unimportant or transient facts are skipped. Never include secrets.",
		promptSnippet: "Store one durable, non-obvious fact (caption + content) in long-term memory",
		promptGuidelines: [
			"Call realmem_remember as soon as you learn a durable, non-obvious fact (setup, build/test/release steps, architecture, conventions, pitfalls, user preferences, machine-specific workarounds): one fact per call, never secrets or transient status.",
		],
		parameters: Type.Object({
			caption: Type.String({ minLength: 3, maxLength: 160, description: "One-line title, specific enough to recognise the fact in a list" }),
			content: Type.String({
				minLength: 1,
				maxLength: 8000,
				description: "The fact itself in Markdown: concise, self-contained, with exact commands, paths and names",
			}),
			scope: Type.Optional(
				StringEnum(SCOPE_VALUES, {
					description:
						"global = all projects (user preferences, general knowledge); project-shared = synced to collaborators via git; project-personal = this machine/user only. Omit to let realmem decide.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
					maxItems: 16,
					description:
						"Files, directories or globs the fact applies to: relative to the cwd (e.g. 'src/db', 'package.json', '**/migrations/*.sql'), `~/…` or absolute. The memory is then shown automatically when you touch those paths. Omit for the whole project (project memories) or the whole user directory (global memories).",
				}),
			),
			user_requested: Type.Optional(Type.Boolean({ description: "true when the user explicitly asked to remember this (skips the importance gate)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const engine = host.engine(ctx);
			const rw = rewriterFor(engine, ctx);
			try {
				const outcome = await engine.remember(
					{
						caption: params.caption,
						content: params.content,
						scope: params.scope ? SCOPE_ARG[params.scope] : undefined,
						paths: params.paths,
						source: "agent",
						force: params.user_requested === true,
					},
					{
						cwd: ctx.cwd,
						rewriter: rw.rewriter,
						signal,
						queueOnFailure: true,
						onStep: (s) => onUpdate?.({ content: text(`realmem: ${s}…`), details: undefined }),
					},
				);
				host.afterRemember(ctx, outcome.status);
				return {
					content: text(formatOutcomeForModel(outcome)),
					details: {
						status: outcome.status,
						id: outcome.memory?.id,
						scope: outcome.memory ? SCOPE_LABEL[outcome.memory.kind] : undefined,
						reasons: outcome.decision?.reasons,
					},
					usage: outcome.trace.rewrite?.usage,
				};
			} catch (err) {
				if (err instanceof CandidateError) throw new Error(err.message);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "realmem_status",
		label: "realmem status",
		description: "Report the state of long-term memory (realmem): detected project, stores and memory counts, embedding index, queued candidates.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const engine = host.engine(ctx);
			const s = engine.status(ctx.cwd);
			return { content: text(formatStatus(s)), details: s };
		},
	});

	pi.registerTool({
		name: "realmem_list",
		label: "realmem list",
		description:
			"Rarely needed: list stored memories (id | scope | paths | used | caption), grouped by path then most used, paginated. Output can be large; prefer realmem_recall to find relevant memories.",
		parameters: Type.Object({
			page: Type.Optional(Type.Integer({ minimum: 1, description: "Page (default 1)" })),
			scope: Type.Optional(StringEnum(SCOPE_VALUES, { description: "Only list one scope" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const engine = host.engine(ctx);
			engine.sync(ctx.cwd);
			const sc = engine.scopes(ctx.cwd);
			const stores = (params.scope ? sc.stores.filter((s) => s.kind === SCOPE_ARG[params.scope as string]) : sc.stores).map((s) => s.id);
			const pageSize = engine.settings.list.pageSize;
			const total = engine.db.count(stores);
			const pages = Math.max(1, Math.ceil(total / pageSize));
			const page = Math.min(Math.max(1, params.page ?? 1), pages);
			const rows = engine.db.list(stores, { limit: pageSize, offset: (page - 1) * pageSize, order: "path" });
			return { content: text(formatList(rows, total, page, pageSize)), details: { total, page, pages } };
		},
	});

	pi.registerTool({
		name: "realmem_forget",
		label: "realmem forget",
		description:
			"Delete memories from long-term memory (realmem) by id. Use only for memories that are wrong, obsolete or unwanted and cannot be corrected with realmem_remember; ids are shown by realmem_recall / realmem_list.",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ minLength: 6, maxLength: 40 }), { minItems: 1, maxItems: 32, description: "Memory ids (or unique prefixes) to delete" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const engine = host.engine(ctx);
			const r = await engine.forget(ctx.cwd, params.ids);
			const lines = r.deleted.map((m) => `deleted ${m.id} [${SCOPE_LABEL[m.kind]}] ${m.caption}`);
			if (r.missing.length) lines.push(`not found: ${r.missing.join(", ")}`);
			return { content: text(lines.join("\n") || "nothing deleted"), details: { deleted: r.deleted.map((m) => m.id), missing: r.missing } };
		},
	});
}
