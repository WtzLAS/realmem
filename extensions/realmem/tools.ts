/**
 * Model-facing tools: realmem_recall, realmem_remember, realmem_status, realmem_list.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CandidateError, type Realmem } from "../../src/engine.ts";
import { SCOPE_LABEL } from "../../src/files.ts";
import { formatList, formatOutcomeForModel, formatRecall, formatStatus, SCOPE_ARG } from "../../src/format.ts";
import { createRewriter, type Rewriter, resolveModel } from "../../src/rewrite.ts";

export interface ToolHost {
	engine(ctx: ExtensionContext): Realmem;
	/** Called after a successful remember (e.g. to refresh status, drain the queue). */
	afterRemember(ctx: ExtensionContext, status: string): void;
}

const SCOPE_VALUES = ["global", "project-shared", "project-personal"] as const;

export function rewriterFor(engine: Realmem, ctx: ExtensionContext): { rewriter?: Rewriter; model?: string; error?: string } {
	const model = resolveModel(engine.settings.rewriteModel, ctx.modelRegistry, ctx.model);
	if (!model) {
		return { error: engine.settings.rewriteModel ? `rewrite model ${engine.settings.rewriteModel} not found` : "no model selected for rewrites" };
	}
	return { rewriter: createRewriter(ctx.modelRegistry, model), model: `${model.provider}/${model.id}` };
}

function text(t: string) {
	return [{ type: "text" as const, text: t }];
}

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	pi.registerTool({
		name: "realmem_recall",
		label: "realmem recall",
		description:
			"Search long-term memory (realmem) with hybrid semantic + keyword search. Pass several keywords or short statements describing the task, component, command, error, or question. Returns the most relevant memories, most used first, paginated.",
		promptSnippet: "Search long-term memory; call it before starting any work and whenever you enter a new area",
		promptGuidelines: [
			"Call realmem_recall before starting any task (and again when switching areas or hitting surprises), with 2-8 keywords or short statements covering the task.",
		],
		parameters: Type.Object({
			queries: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
				minItems: 1,
				maxItems: 16,
				description: "Keywords or short statements, e.g. ['release process', 'publish npm package', 'CI secrets']",
			}),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "Result page (default 1)" })),
			scope: Type.Optional(StringEnum(SCOPE_VALUES, { description: "Only search one scope" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const engine = host.engine(ctx);
			const r = await engine.recall(ctx.cwd, params.queries, { page: params.page, scope: params.scope ? SCOPE_ARG[params.scope] : undefined, signal });
			return {
				content: text(formatRecall(r, params.queries)),
				details: { ids: r.items.map((i) => i.memory.id), total: r.total, page: r.page, pages: r.pages, embedError: r.embedError },
			};
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
				Type.Array(Type.String(), { maxItems: 16, description: "Project paths (relative to the cwd) the fact applies to; omit for the whole project" }),
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
			"Rarely needed: list stored memories (id | scope | used | caption), most used first, paginated. Output can be large; prefer realmem_recall to find relevant memories.",
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
			const rows = engine.db.list(stores, { limit: pageSize, offset: (page - 1) * pageSize, order: "used" });
			return { content: text(formatList(rows, total, page, pageSize)), details: { total, page, pages } };
		},
	});
}
