/**
 * /realmem manage page: browse every memory visible from the cwd, read its
 * content and metadata, edit, move between scopes, delete, approve quarantined ones.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { MemoryRow } from "../../src/db.ts";
import type { Realmem } from "../../src/engine.ts";
import { SCOPE_LABEL, type ScopeKind } from "../../src/files.ts";
import { canonical, fmtTime, scopePaths } from "../../src/format.ts";
import { idTimestamp } from "../../src/ids.ts";
import { oneLine } from "../../src/text.ts";
import { FilterPicker, runWithLoader, showText } from "./ui.ts";

const SHORT: Record<ScopeKind, string> = { global: "G", shared: "S", personal: "P" };

function memoryLines(engine: Realmem, m: MemoryRow): (theme: Theme) => string[] {
	return (t) => {
		const u = engine.db.usageDetail(m.id);
		const created = m.created ?? (idTimestamp(m.id) ? new Date(idTimestamp(m.id) as number).toISOString() : null);
		const meta: Array<[string, string]> = [
			["id", `${m.id}  (${canonical(m.id)})`],
			["scope", SCOPE_LABEL[m.kind]],
			["paths", m.kind === "global" ? "—" : scopePaths(m) || "."],
			["used", `${u.used} (reinforced ${u.reinforce}, recalled ${u.recall}); last ${fmtTime(u.lastUsed)}`],
			["created", fmtTime(created)],
			["updated", fmtTime(m.updated)],
			["file", m.file],
			["hash", m.hash.slice(0, 16)],
			["vector", m.vecHash === m.hash ? "indexed" : "pending"],
		];
		if (m.flags) meta.push(["quarantine", m.flags]);
		const out = [t.bold(m.caption), ""];
		for (const [k, v] of meta) out.push(`${t.fg("muted", k.padEnd(10))} ${k === "quarantine" ? t.fg("warning", v) : v}`);
		out.push("", t.fg("borderMuted", "content"), "");
		for (const l of m.content.split("\n")) out.push(l);
		return out;
	};
}

async function pickScope(ctx: ExtensionCommandContext, engine: Realmem, exclude: string): Promise<ScopeKind | undefined> {
	const sc = engine.scopes(ctx.cwd);
	const options = sc.stores.filter((s) => s.id !== exclude).map((s) => SCOPE_LABEL[s.kind]);
	const choice = await ctx.ui.select("Move memory to", options);
	if (!choice) return undefined;
	return (Object.keys(SCOPE_LABEL) as ScopeKind[]).find((k) => SCOPE_LABEL[k] === choice);
}

async function memoryPage(ctx: ExtensionCommandContext, engine: Realmem, initial: MemoryRow): Promise<void> {
	let m: MemoryRow | undefined = initial;
	while (m) {
		const actions = [
			{ id: "edit" as const, key: "e", label: "edit content" },
			{ id: "caption" as const, key: "c", label: "caption" },
			{ id: "paths" as const, key: "p", label: "paths" },
			{ id: "move" as const, key: "m", label: "move scope" },
			{ id: "delete" as const, key: "d", label: "delete" },
			...(m.flags ? [{ id: "approve" as const, key: "a", label: "approve (unquarantine)" }] : []),
		];
		const action = await showText(ctx, `realmem · ${SCOPE_LABEL[m.kind]} · ${m.id}`, memoryLines(engine, m), actions);
		if (!action) return;
		const cur: MemoryRow = m;
		try {
			switch (action) {
				case "edit": {
					const content = await ctx.ui.editor(`Edit content: ${oneLine(cur.caption, 60)}`, cur.content);
					if (content !== undefined && content.trim() !== cur.content.trim()) m = await engine.updateMemory(ctx.cwd, cur, { content });
					break;
				}
				case "caption": {
					const caption = await ctx.ui.editor("Edit caption (one line)", cur.caption);
					if (caption !== undefined && caption.trim() && caption.trim() !== cur.caption) m = await engine.updateMemory(ctx.cwd, cur, { caption });
					break;
				}
				case "paths": {
					if (cur.kind === "global") {
						ctx.ui.notify("global memories have no path scope", "info");
						break;
					}
					const v = await ctx.ui.editor("Path scopes relative to the project root, one per line ('.' = whole project)", (cur.paths ?? ["."]).join("\n"));
					if (v !== undefined) m = await engine.updateMemory(ctx.cwd, cur, { paths: v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) });
					break;
				}
				case "move": {
					const kind = await pickScope(ctx, engine, cur.store);
					if (kind) m = await engine.moveMemory(ctx.cwd, cur, kind);
					break;
				}
				case "delete": {
					const ok = await ctx.ui.confirm("Delete memory?", `${cur.caption}\n\nThis deletes ${cur.file}.`);
					if (ok) {
						await engine.deleteMemory(cur);
						ctx.ui.notify("memory deleted", "info");
						return;
					}
					break;
				}
				case "approve": {
					const ok = await ctx.ui.confirm(
						"Approve quarantined memory?",
						`realmem flagged it: ${cur.flags}\n\nApproving makes it visible to the agent again (until its content changes).`,
					);
					if (ok) {
						engine.db.approve(cur.hash);
						m = engine.db.getByRid(cur.rid);
					}
					break;
				}
			}
		} catch (err) {
			ctx.ui.notify(`realmem: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		if (m) m = engine.db.getById(m.id, [m.store]) ?? m;
	}
}

function listItems(rows: MemoryRow[]): SelectItem[] {
	return rows.map((m) => ({
		value: m.id,
		label: `${m.flags ? "⚠" : SHORT[m.kind]} ${String(m.usedCount).padStart(3)}  ${oneLine(m.caption, 90)}`,
		description: `${SCOPE_LABEL[m.kind]}${scopePaths(m) ? ` · ${scopePaths(m)}` : ""} · ${oneLine(m.content, 160)}`,
	}));
}

export async function openManage(ctx: ExtensionCommandContext, engine: Realmem, initialQuery?: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/realmem manage needs the interactive TUI", "warning");
		return;
	}
	engine.sync(ctx.cwd);
	let query = initialQuery?.trim() ?? "";
	let lastSelected: string | undefined;
	for (;;) {
		const sc = engine.scopes(ctx.cwd);
		const storeIds = sc.stores.map((s) => s.id);
		let rows: MemoryRow[];
		let title: string;
		if (query) {
			const r = await runWithLoader(ctx, `searching "${query}"`, (signal) =>
				engine.recall(ctx.cwd, [query], { pageSize: 200, signal, countUsage: false }),
			);
			if (r.cancelled) {
				query = "";
				continue;
			}
			if (r.error) {
				ctx.ui.notify(`realmem: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
				query = "";
				continue;
			}
			rows = (r.value?.items ?? []).map((i) => i.memory);
			title = `realmem · search "${query}" · ${rows.length} results`;
		} else {
			const total = engine.db.count(storeIds, true);
			rows = engine.db.list(storeIds, { limit: 5000, offset: 0, includeFlagged: true, order: "used" });
			const counts = sc.stores.map((s) => `${SCOPE_LABEL[s.kind]} ${engine.db.count([s.id], true)}`).join(" · ");
			title = `realmem · ${total} memories (${counts})${sc.project ? ` · ${sc.project.name}` : ""}`;
		}
		const items: SelectItem[] = [
			{ value: "__search", label: query ? "↺ clear search" : "🔎 semantic search…", description: "hybrid vector + keyword search (does not count as usage)" },
			...listItems(rows),
		];
		const picked = await ctx.ui.custom<string | undefined>(
			(tui, theme, _kb, done) =>
				new FilterPicker({
					theme,
					title: `${title}  —  G global · S shared · P personal · ⚠ quarantined · number = used`,
					items,
					selected: lastSelected,
					maxVisible: Math.max(5, tui.terminal.rows - 8),
					done,
				}),
		);
		if (!picked) return;
		if (picked === "__search") {
			if (query) query = "";
			else query = (await ctx.ui.input("Search memories", "keywords or a question"))?.trim() ?? "";
			continue;
		}
		lastSelected = picked;
		const row = rows.find((r) => r.id === picked);
		if (row) await memoryPage(ctx, engine, row);
		engine.sync(ctx.cwd);
	}
}
