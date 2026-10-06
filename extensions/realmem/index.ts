/**
 * realmem — surprise-gated, on-demand long-term memory for Pi.
 *
 * Registers the realmem tools, the /realmem command (manage, settings, debug,
 * import, status, …), a frozen per-session system prompt section, and a skill.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Realmem } from "../../src/engine.ts";
import { formatPathNotes, formatStatus } from "../../src/format.ts";
import { describeIgnoreProblem, SHARED_REL } from "../../src/gitignore.ts";
import { displayPath, touchedPaths } from "../../src/paths.ts";
import { buildSessionPrompt, SNAPSHOT_ENTRY, SNAPSHOT_VERSION, type SessionSnapshot } from "../../src/prompt.ts";
import { sha256 } from "../../src/text.ts";
import { openDebug } from "./debug-page.ts";
import { PathNoteState } from "./path-notes.ts";
import { openManage } from "./manage-page.ts";
import { openSettings } from "./settings-page.ts";
import { registerTools, rewriterFor } from "./tools.ts";
import { runWithLoader, showText } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "..", "skills");
const CONTEXT_FILE_RE = /(?:^|[\\/])(?:AGENTS(?:\.override)?|CLAUDE)\.md$/i;

const SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "manage", description: "browse, read, edit, move and delete memories" },
	{ name: "settings", description: "models, endpoints, API keys, thresholds" },
	{ name: "debug", description: "dry-run the remember path and inspect embedding/SemIf/decision" },
	{ name: "add", description: "remember a fact yourself (runs the full gate)" },
	{ name: "import", description: "import AGENTS.md / CLAUDE.md into realmem via the agent" },
	{ name: "status", description: "project, stores, index and queue status" },
	{ name: "embed", description: "embed memories that have no vector yet" },
	{ name: "reindex", description: "clear the embedding cache and re-embed everything" },
	{ name: "retry", description: "retry candidates queued while the judge was unreachable" },
	{ name: "prune-paths", description: "drop paths that no longer exist; delete memories whose paths are all gone" },
	{ name: "fix-gitignore", description: "check whether .pi/realmem is ignored by git and add the fix to .gitignore" },
];

export default function realmem(pi: ExtensionAPI) {
	let engine: Realmem | undefined;
	let snapshot: SessionSnapshot | undefined;
	let pendingImport: { files: Array<{ path: string; hash: string }>; results: string[] } | undefined;
	let draining = false;
	const notes = new PathNoteState();

	const getEngine = (): Realmem => {
		engine ??= new Realmem();
		return engine;
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const e = getEngine();
			const sc = e.scopes(ctx.cwd);
			const n = e.db.count(sc.stores.map((s) => s.id));
			const pending = e.db.countPending();
			const setup = e.semifClient.configured ? "" : " · setup: /realmem settings";
			ctx.ui.setStatus("realmem", `🧠 ${n}${pending ? ` (+${pending} queued)` : ""}${setup}`);
		} catch {
			ctx.ui.setStatus("realmem", "🧠 !");
		}
	};

	const drain = (ctx: ExtensionContext) => {
		if (draining) return;
		const e = getEngine();
		if (e.db.countPending() === 0) return;
		draining = true;
		const rw = rewriterFor(e, ctx);
		const cwd = ctx.cwd;
		void e
			.drainPending(cwd, rw.rewriter)
			.then((done) => {
				if (done.length > 0 && ctx.hasUI) ctx.ui.notify(`realmem: processed ${done.length} queued memor${done.length === 1 ? "y" : "ies"}`, "info");
			})
			.catch(() => {})
			.finally(() => {
				draining = false;
				try {
					refreshStatus(ctx);
				} catch {
					// session replaced meanwhile
				}
			});
	};

	registerTools(pi, {
		engine: () => getEngine(),
		recentPaths: () => notes.recentPaths(),
		markSeen: (ids) => notes.markShown(ids),
		afterRemember: (ctx, status) => {
			pendingImport?.results.push(status);
			refreshStatus(ctx);
			if (status !== "queued") drain(ctx);
		},
	});

	pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

	pi.on("session_start", async (_event, ctx) => {
		snapshot = undefined;
		notes.reset(ctx.sessionManager.getBranch());
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY) {
				const data = entry.data as SessionSnapshot | undefined;
				if (typeof data?.v === "number" && data.v >= 1 && typeof data.prompt === "string") snapshot = data; // older snapshots stay valid: never change a running session's prompt
			}
		}
		let e: Realmem;
		try {
			e = getEngine();
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`realmem failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		// Other memory systems' tools are hidden so the model only uses realmem.
		const hide = new Set(e.settings.prompt.hideTools);
		if (hide.size > 0) {
			const active = pi.getActiveTools();
			if (active.some((t) => hide.has(t))) pi.setActiveTools(active.filter((t) => !hide.has(t)));
		}
		try {
			const report = e.sync(ctx.cwd);
			if (report.flagged > 0 && ctx.hasUI) {
				ctx.ui.notify(`realmem: ${report.flagged} memor${report.flagged === 1 ? "y was" : "ies were"} quarantined by the safety scan; review with /realmem manage or clean up with /realmem prune-paths`, "warning");
			}
			if (report.errors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`realmem: ${report.errors.length} unreadable memory file(s), e.g. ${report.errors[0].file}: ${report.errors[0].error}`, "warning");
			}
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`realmem sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		if (!e.semifClient.configured && ctx.hasUI) {
			ctx.ui.notify("realmem: no SemIf judge endpoint is set, so new memories are only queued. Configure it (and the embedding API) in /realmem settings.", "warning");
		}
		try {
			e.resetRepoCache();
			const project = e.scopes(ctx.cwd).project;
			const ignored = project?.isGit ? e.sharedIgnored(project.root) : undefined;
			if (ignored && ctx.hasUI) {
				ctx.ui.notify(`realmem: ${describeIgnoreProblem(ignored)}\nOr run /realmem fix-gitignore to apply it.`, "warning");
			}
			const paths = e.checkPaths(ctx.cwd);
			if (paths.stale > 0 && ctx.hasUI) {
				ctx.ui.notify(`realmem: ${paths.stale} memor${paths.stale === 1 ? "y refers" : "ies refer"} to paths that no longer exist; review with /realmem manage`, "warning");
			}
		} catch {
			// git unavailable: skip
		}
		refreshStatus(ctx);
		void e.embedInBackground().then(() => refreshStatus(ctx)).catch(() => {});
		void e.refreshUrgencyInBackground(ctx.cwd);
		drain(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		let e: Realmem;
		try {
			e = getEngine();
		} catch {
			return;
		}
		const opts = event.systemPromptOptions;
		if (!snapshot) {
			// First prompt of the session: compute the realmem section once and freeze it,
			// so the prompt prefix never changes for the rest of the session.
			const strip: string[] = [];
			const mode = e.settings.prompt.stripContextFiles;
			if (mode !== "never") {
				for (const f of opts.contextFiles) {
					if (!CONTEXT_FILE_RE.test(f.path)) continue;
					if (mode === "always" || e.db.isContextImported(sha256(f.content))) strip.push(f.path);
				}
			}
			let top: ReturnType<Realmem["topMemories"]> = [];
			let total = 0;
			let pathMap: ReturnType<Realmem["pathMap"]> = [];
			try {
				top = e.topMemories(ctx.cwd, e.settings.prompt.topCaptions);
				total = e.db.count(e.scopes(ctx.cwd).stores.map((s) => s.id));
				if (e.settings.paths.inject) pathMap = e.pathMap(ctx.cwd, 10);
			} catch {
				// index unavailable: prompt without captions
			}
			const project = e.scopes(ctx.cwd).project;
			snapshot = {
				v: SNAPSHOT_VERSION,
				prompt: buildSessionPrompt({ top, total, projectName: project?.name, stripped: strip, pathMap }),
				strip,
				createdAt: new Date().toISOString(),
			};
			pi.appendEntry(SNAPSHOT_ENTRY, snapshot);
		}
		if (snapshot.strip.length > 0) {
			const strip = new Set(snapshot.strip);
			opts.contextFiles = opts.contextFiles.filter((f) => !strip.has(f.path));
		}
		opts.sections.realmem = snapshot.prompt;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!pendingImport) return;
		const e = getEngine();
		const { files, results } = pendingImport;
		pendingImport = undefined;
		const stored = results.filter((s) => s === "added" || s === "edited" || s === "merged" || s === "reinforced" || s === "queued").length;
		if (stored === 0) {
			if (ctx.hasUI) ctx.ui.notify("realmem: the import stored no memories; context files were not marked as imported", "warning");
			return;
		}
		for (const f of files) e.db.markContextImported(f.hash, f.path);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`realmem: import stored ${stored} fact(s); marked ${files.length} context file(s) as imported${e.settings.prompt.stripContextFiles === "imported" ? " (left out of the prompt from the next session on)" : ""}`,
				"info",
			);
		}
		refreshStatus(ctx);
	});

	// Path notes: memories attached to the paths a tool call touched, appended to its result.
	pi.on("tool_result", (event, ctx) => {
		if (!engine || event.toolName.startsWith("realmem_")) return;
		const e = engine;
		if (!e.settings.paths.inject) return;
		const touched = touchedPaths(event.toolName, event.input, ctx.cwd);
		if (touched.length === 0) return;
		notes.touch(touched);
		// Pick up memories pulled via git or edited by hand (cheap when nothing changed).
		if (Date.now() - notes.lastSync > 5_000) {
			notes.lastSync = Date.now();
			try {
				e.sync(ctx.cwd);
			} catch {
				// index busy: use what we have
			}
		}
		const found = e.notesForPaths(ctx.cwd, touched, notes.shownIds);
		const rendered = formatPathNotes(
			touched.map((t) => displayPath(t, ctx.cwd)),
			found,
			e.settings.paths,
		);
		if (!rendered) return;
		notes.markShown([...rendered.displayed, ...rendered.hinted]);
		if (rendered.displayed.length > 0) e.db.bumpUsage(rendered.displayed, "inject");
		return { content: [...event.content, { type: "text" as const, text: rendered.text }] };
	});

	// Persist the ids shown on this branch so a resumed or reloaded session does not repeat them.
	pi.on("turn_end", () => {
		const draft = notes.flush();
		return draft ? { entries: [draft] } : undefined;
	});

	pi.on("session_tree", (_event, ctx) => {
		notes.reset(ctx.sessionManager.getBranch());
	});

	// After a compaction the summarised tool results (and their path notes) are gone:
	// notes shown before the first kept entry may be shown again.
	pi.on("session_compact", (_event, ctx) => {
		notes.reset(ctx.sessionManager.getBranch(), { keepUnflushed: true });
	});

	// Calls to other memory systems' tools are refused, even when they stay active.
	pi.on("tool_call", (event) => {
		if (!engine) return;
		if (!engine.settings.prompt.hideTools.includes(event.toolName)) return;
		return {
			block: true,
			reason: `${event.toolName} is disabled: realmem is the only long-term memory. Use realmem_recall / realmem_remember instead.`,
		};
	});

	pi.on("session_shutdown", () => {
		pendingImport = undefined;
		snapshot = undefined;
		if (engine) {
			engine.close();
			engine = undefined;
		}
	});

	// ---------------------------------------------------------------------------
	// /realmem command
	// ---------------------------------------------------------------------------

	const importContext = async (ctx: ExtensionCommandContext, e: Realmem) => {
		const files = ctx.getSystemPromptOptions().contextFiles?.filter((f) => CONTEXT_FILE_RE.test(f.path)) ?? [];
		const todo = files.filter((f) => !e.db.isContextImported(sha256(f.content)));
		if (todo.length === 0) {
			ctx.ui.notify(files.length ? "realmem: all AGENTS.md / CLAUDE.md files are already imported" : "realmem: no AGENTS.md / CLAUDE.md files in context", "info");
			return;
		}
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Import context files into realmem?",
				`${todo.map((f) => `• ${f.path}`).join("\n")}\n\nThe agent will split them into facts and store each with realmem_remember. The files themselves are not modified.`,
			);
			if (!ok) return;
		}
		pendingImport = { files: todo.map((f) => ({ path: f.path, hash: sha256(f.content) })), results: [] };
		const agentDir = dirname(e.paths.base);
		const body = todo
			.map((f) => {
				const hint = f.path.startsWith(agentDir) ? "global (user-level file)" : "project-shared unless a fact is machine- or user-specific";
				return `<instruction_file path="${f.path}" default_scope="${hint}">\n${f.content}\n</instruction_file>`;
			})
			.join("\n\n");
		pi.sendUserMessage(
			[
				"Import these instruction files into realmem long-term memory.",
				"Split them into self-contained facts (one topic each: setup, build/test commands, architecture, conventions, release steps, preferences, pitfalls) and call realmem_remember once per fact with a specific caption and complete content (keep commands and paths verbatim), user_requested=true, and the scope given by default_scope.",
				"Skip generic advice that any competent agent follows anyway, and anything that only restates how to use other memory systems. Do not change any files. When done, reply with a short summary of what was stored.",
				"",
				body,
			].join("\n"),
		);
	};

	const addFact = async (ctx: ExtensionCommandContext, e: Realmem, initial: string) => {
		const text = initial.trim() ? initial : await ctx.ui.editor("Remember: first line = caption, the rest = content", "");
		if (!text?.trim()) return;
		const lines = text.replace(/\r\n/g, "\n").split("\n");
		const first = lines.findIndex((l) => l.trim());
		const caption = lines[first].replace(/^#+\s*/, "").trim();
		const content = lines.slice(first + 1).join("\n").trim() || caption;
		const rw = rewriterFor(e, ctx);
		const r = await runWithLoader(ctx, "remembering", (signal, setMessage) =>
			e.remember({ caption, content, source: "user", force: true }, { cwd: ctx.cwd, rewriter: rw.rewriter, signal, queueOnFailure: true, onStep: setMessage }),
		);
		if (r.error) ctx.ui.notify(`realmem: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
		else if (r.value) ctx.ui.notify(`realmem: ${r.value.message}`, r.value.status === "rejected" ? "warning" : "info");
		refreshStatus(ctx);
	};

	pi.registerCommand("realmem", {
		description: "realmem long-term memory: manage, settings, debug, add, import, status, embed, reindex, retry, prune-paths",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const p = prefix.trim().toLowerCase();
			if (p.includes(" ")) return null;
			const items = SUBCOMMANDS.filter((s) => s.name.startsWith(p)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			let e: Realmem;
			try {
				e = getEngine();
			} catch (err) {
				ctx.ui.notify(`realmem failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			const trimmed = args.trim();
			let sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
			const rest = trimmed.slice(sub.length).trim();
			if (!sub) {
				if (!ctx.hasUI) sub = "status";
				else {
					const pick = await ctx.ui.select(
						"realmem",
						SUBCOMMANDS.map((s) => `${s.name} — ${s.description}`),
					);
					if (!pick) return;
					sub = pick.split(" ")[0];
				}
			}
			try {
				switch (sub) {
					case "manage":
					case "list":
						await openManage(ctx, e, rest);
						break;
					case "settings":
					case "config":
						await openSettings(ctx, e);
						drain(ctx);
						break;
					case "debug":
						await openDebug(ctx, e, () => refreshStatus(ctx));
						break;
					case "add":
					case "remember":
						await addFact(ctx, e, rest);
						break;
					case "import":
						await importContext(ctx, e);
						break;
					case "status": {
						const text = formatStatus(e.status(ctx.cwd));
						if (ctx.mode === "tui") await showText(ctx, "realmem status", () => text.split("\n"));
						else ctx.ui.notify(text, "info");
						break;
					}
					case "embed":
					case "reindex": {
						if (sub === "reindex") {
							const ok = !ctx.hasUI || (await ctx.ui.confirm("Re-embed everything?", "This clears the embedding cache and embeds every memory again."));
							if (!ok) return;
							e.db.clearEmbeddings();
							e.index.checkFingerprint();
						}
						e.sync(ctx.cwd);
						const r = await runWithLoader(ctx, "embedding memories", (signal) => e.index.embedMissing(signal));
						if (r.error) ctx.ui.notify(`realmem: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
						else if (r.value) ctx.ui.notify(r.value.error ? `realmem: embedded ${r.value.embedded}, then failed: ${r.value.error}` : `realmem: embedded ${r.value.embedded} memories (${r.value.tokens} tokens)`, r.value.error ? "warning" : "info");
						break;
					}
					case "retry": {
						const rw = rewriterFor(e, ctx);
						const r = await runWithLoader(ctx, "retrying queued memories", (signal) => e.drainPending(ctx.cwd, rw.rewriter, signal));
						if (r.error) ctx.ui.notify(`realmem: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
						else ctx.ui.notify(`realmem: processed ${r.value?.length ?? 0} queued candidate(s); ${e.db.countPending()} left`, "info");
						break;
					}
					case "prune-paths":
					case "prune": {
						const preview = await e.prunePaths(ctx.cwd, { dryRun: true });
						if (preview.updated.length === 0 && preview.deleted.length === 0) {
							ctx.ui.notify("realmem: no memory refers to a missing path", "info");
							break;
						}
						const lines = [
							...preview.updated.map((u) => `edit   ${u.memory.caption}: drop ${u.removed.join(", ")}`),
							...preview.deleted.map((m) => `delete ${m.caption}: ${(m.paths ?? []).join(", ")}`),
						];
						if (ctx.hasUI && !(await ctx.ui.confirm(`Prune ${lines.length} memor${lines.length === 1 ? "y" : "ies"}?`, lines.join("\n")))) return;
						const r = await e.prunePaths(ctx.cwd);
						ctx.ui.notify(`realmem: removed missing paths from ${r.updated.length} memor${r.updated.length === 1 ? "y" : "ies"}, deleted ${r.deleted.length}`, "info");
						break;
					}
					case "fix-gitignore":
						await fixGitignore(ctx, e);
						break;
					default:
						ctx.ui.notify(`realmem: unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map((s) => s.name).join(", ")}`, "warning");
				}
			} catch (err) {
				ctx.ui.notify(`realmem: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			refreshStatus(ctx);
		},
	});
}

/** Show the gitignore problem for the shared store and, after confirmation, append the verified fix. */
async function fixGitignore(ctx: ExtensionCommandContext, e: Realmem): Promise<void> {
	const project = e.scopes(ctx.cwd).project;
	if (!project?.isGit) {
		ctx.ui.notify("realmem: not in a git repository; nothing to fix", "info");
		return;
	}
	const problem = e.sharedIgnored(project.root, true);
	if (!problem) {
		ctx.ui.notify(`realmem: ${SHARED_REL}/ is not ignored by git; project-shared memories will be committed`, "info");
		return;
	}
	const text = describeIgnoreProblem(problem);
	const fix = problem.fix;
	if (!fix || !ctx.hasUI) {
		ctx.ui.notify(`realmem: ${text}`, "warning");
		return;
	}
	const target = isAbsolute(fix.file) ? fix.file : join(project.root, fix.file);
	const ok = await ctx.ui.confirm(`Append to ${fix.file}?`, `${text}\n\nAppend the lines above to ${target}?`);
	if (!ok) return;
	const before = existsSync(target) ? readFileSync(target, "utf8") : "";
	const block = `${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}# realmem: share project memories (${SHARED_REL}) through git\n${fix.lines.join("\n")}\n`;
	writeFileSync(target, before + block);
	const after = e.sharedIgnored(project.root, true);
	if (after) ctx.ui.notify(`realmem: ${fix.file} was updated, but ${SHARED_REL}/ is still ignored:\n${describeIgnoreProblem(after)}`, "error");
	else ctx.ui.notify(`realmem: updated ${fix.file}; ${SHARED_REL}/ is no longer ignored. Commit ${fix.file} and ${SHARED_REL}/ to share memories.`, "info");
}
