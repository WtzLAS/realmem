/**
 * /realmem manage page: browse every memory visible from the cwd, read its
 * content and metadata, edit, move between scopes, delete, approve quarantined ones.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { MemoryRow } from "../../src/db.ts";
import { type Realmem, urgencyBasis } from "../../src/engine.ts";
import { SCOPE_LABEL, type ScopeKind } from "../../src/files.ts";
import { canonical, fmtTime, scopePaths } from "../../src/format.ts";
import { idTimestamp } from "../../src/ids.ts";
import { oneLine } from "../../src/text.ts";
import { type UrgencyTier, urgencyTier } from "../../src/judge.ts";
import { FilterPicker, runWithLoader, showText } from "./ui.ts";
import { tierColor, urgencyBreakdown, urgencySummary } from "./urgency-view.ts";

const SHORT: Record<ScopeKind, string> = { global: "G", shared: "S", personal: "P" };

const SOURCE_LABEL: Record<string, string> = {
	remember: "judged when remembered",
	judge: "judged in the background (hand-written or edited memory)",
};

/** Path urgency section of a memory page: score, tier, effect on touch, per-level breakdown. */
function urgencyLines(engine: Realmem, m: MemoryRow): (t: Theme) => string[] {
	return (t) => {
		const th = engine.settings.thresholds;
		const pad = (k: string) => t.fg("muted", k.padEnd(10));
		if (!scopePaths(m)) {
			return [`${pad("urgency")} ${t.fg("dim", "n/a: covers the whole root, never shown on path touch (reached through realmem_recall)")}`];
		}
		const out: string[] = [];
		if (!engine.settings.paths.inject) out.push(t.fg("warning", "path notes are off (settings): urgency has no effect right now"));
		const g = engine.db.getUrgency(m.store, m.id);
		if (!g) {
			const tier = urgencyTier(undefined, th);
			out.push(`${pad("urgency")} not judged yet → ${t.fg(tierColor(tier), tier)} until judged (caption shown on path touch)`);
			out.push(`${pad("")} ${t.fg("dim", "judged in the background by SemIf at session start and after writes")}`);
			return out;
		}
		const current = g.basis === urgencyBasis(m);
		if (current) out.push(`${pad("urgency")} ${urgencySummary(t, g.score, th)}`);
		else {
			const tier = urgencyTier(undefined, th);
			out.push(`${pad("urgency")} ${t.fg("warning", `stale: ${g.score.toFixed(2)}/2 was judged for older content or paths`)}`);
			out.push(`${pad("")} treated as ${t.fg(tierColor(tier), tier)} (caption) until re-judged in the background`);
		}
		out.push(`${pad("source")} ${SOURCE_LABEL[g.source] ?? g.source}, ${fmtTime(g.updated)}`);
		out.push(`${pad("levels")}`, ...urgencyBreakdown(t, g, th, "  "));
		return out;
	};
}

const TIER_MARK: Record<UrgencyTier, string> = { high: "●", mid: "◐", low: "○" };

/**
 * Urgency for the list: `mark` is a one-char column next to the scope letter
 * (● full, ◐ caption, ○ count, ? unjudged, blank = whole root), `long` goes in the
 * description ("urgency 1.62 high").
 */
function urgencyTag(engine: Realmem, m: MemoryRow): { mark: string; long: string } {
	if (!scopePaths(m)) return { mark: " ", long: "" };
	const g = engine.db.getUrgency(m.store, m.id);
	if (!g || g.basis !== urgencyBasis(m)) return { mark: "?", long: " · urgency not judged yet" };
	const tier = urgencyTier(g.score, engine.settings.thresholds);
	return { mark: TIER_MARK[tier], long: ` · urgency ${g.score.toFixed(2)} ${tier}` };
}

function memoryLines(engine: Realmem, m: MemoryRow): (theme: Theme) => string[] {
	return (t) => {
		const u = engine.db.usageDetail(m.id);
		const created = m.created ?? (idTimestamp(m.id) ? new Date(idTimestamp(m.id) as number).toISOString() : null);
		const meta: Array<[string, string]> = [
			["id", `${m.id}  (${canonical(m.id)})`],
			["scope", SCOPE_LABEL[m.kind]],
			["paths", scopePaths(m) || (m.kind === "global" ? "~ (user directory, default)" : ". (project root, default)")],
			["used", `${u.used} (reinforced ${u.reinforce}, recalled ${u.recall}); last ${fmtTime(u.lastUsed)}`],
			["shown", `${u.inject}× on path touch`],
			["created", fmtTime(created)],
			["updated", fmtTime(m.updated)],
			["file", m.file],
			["hash", m.hash.slice(0, 16)],
			["vector", m.vecHash === m.hash ? "indexed" : "pending"],
		];
		const urgency = urgencyLines(engine, m);
		const ps = engine.db.getPathState(m.store, m.id);
		if (ps) meta.push(["missing", `${ps.missing.join(", ")}${ps.suggestion ? ` → moved to ${ps.suggestion}? (press f)` : ""}`]);
		if (m.flags) meta.push(["quarantine", m.flags]);
		const out = [t.bold(m.caption), ""];
		for (const [k, v] of meta) out.push(`${t.fg("muted", k.padEnd(10))} ${k === "quarantine" || k === "missing" ? t.fg("warning", v) : v}`);
		out.push("", t.fg("borderMuted", "path urgency"), "", ...urgency(t));
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
			...(engine.db.getPathState(m.store, m.id)?.suggestion ? [{ id: "fix" as const, key: "f", label: "apply suggested path" }] : []),
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
					const v = await ctx.ui.editor(
						cur.kind === "global"
							? "Path scopes, one per line: ~/… under the user directory or absolute paths; files, directories or globs ('~' = everywhere)"
							: "Path scopes relative to the project root, one per line: files, directories or globs like **/*.sql ('.' = whole project)",
						(cur.paths ?? [cur.kind === "global" ? "~" : "."]).join("\n"),
					);
					if (v !== undefined) {
						m = await engine.updateMemory(ctx.cwd, cur, { paths: v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) });
						engine.checkPaths(ctx.cwd);
					}
					break;
				}
				case "fix": {
					const ps = engine.db.getPathState(cur.store, cur.id);
					if (ps?.suggestion && ps.missing.length === 1) {
						const paths = (cur.paths ?? []).map((p) => (p === ps.missing[0] ? (ps.suggestion as string) : p));
						m = await engine.updateMemory(ctx.cwd, cur, { paths });
						engine.checkPaths(ctx.cwd);
					}
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

function listItems(engine: Realmem, rows: MemoryRow[], stale: Set<string>): SelectItem[] {
	return rows.map((m) => {
		const where = scopePaths(m);
		const mark = m.flags ? "⚠" : stale.has(m.id) ? "✗" : SHORT[m.kind];
		const u = urgencyTag(engine, m);
		return {
			value: m.id,
			label: `${mark}${u.mark} ${String(m.usedCount).padStart(3)}  ${where ? `${oneLine(where, 28)} · ` : ""}${oneLine(m.caption, 90)}`,
			description: `${SCOPE_LABEL[m.kind]}${where ? ` · ${where}` : ""}${u.long}${stale.has(m.id) ? " · path missing" : ""} · ${oneLine(m.content, 160)}`,
		};
	});
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
			rows = engine.db.list(storeIds, { limit: 5000, offset: 0, includeFlagged: true, order: "path" });
			const counts = sc.stores.map((s) => `${SCOPE_LABEL[s.kind]} ${engine.db.count([s.id], true)}`).join(" · ");
			title = `realmem · ${total} memories (${counts})${sc.project ? ` · ${sc.project.name}` : ""}`;
		}
		const items: SelectItem[] = [
			{ value: "__search", label: query ? "↺ clear search" : "🔎 semantic search…", description: "hybrid vector + keyword search (does not count as usage)" },
			...listItems(engine, rows, engine.db.stalePathIds(storeIds)),
		];
		const picked = await ctx.ui.custom<string | undefined>(
			(tui, theme, _kb, done) =>
				new FilterPicker({
					theme,
					title: `${title}  —  by path, then used · G global · S shared · P personal · ⚠ quarantined · ✗ path missing · on path touch: ● full ◐ caption ○ count ? unjudged`,
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
