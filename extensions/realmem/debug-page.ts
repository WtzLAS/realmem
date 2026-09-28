/**
 * /realmem debug page: run the remember path (embedding, search, SemIf judge,
 * decision, rewrite) on a candidate and show every step, without touching the
 * memory base unless the user explicitly commits the result.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SemIfAnswer } from "../../src/api.ts";
import { CandidateError, type Realmem, type RememberOutcome, urgencyBasis } from "../../src/engine.ts";
import { SCOPE_LABEL, type ScopeKind } from "../../src/files.ts";
import { scopePaths } from "../../src/format.ts";
import { urgencyTier } from "../../src/judge.ts";
import { oneLine, truncate } from "../../src/text.ts";
import { rewriterFor } from "./tools.ts";
import { runWithLoader, showText } from "./ui.ts";
import { urgencyBreakdown, urgencySummary } from "./urgency-view.ts";

const pct = (p: number | undefined) => (p === undefined ? "n/a" : `${(p * 100).toFixed(1)}%`);

function answerLines(t: Theme, name: string, a: SemIfAnswer, labels: Map<string, string>): string[] {
	const out: string[] = [];
	if (a.type === "noul") {
		out.push(`${t.fg("accent", name)} (noul): P(yes) = ${pct(a.noul)}`);
		return out;
	}
	if (a.type === "score") {
		out.push(`${t.fg("accent", name)} (score): ${a.score.toFixed(3)}, confidence ${pct(a.confidence)}`);
		for (const [k, p] of Object.entries(a.probabilities)) out.push(`    ${k} ${(a.legend[k] ?? "").padEnd(26)} ${pct(p)}`);
		return out;
	}
	out.push(`${t.fg("accent", name)} (choice): ${a.choice}, confidence ${pct(a.confidence)}`);
	const sorted = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
	for (const [k, p] of sorted.slice(0, 6)) out.push(`    ${pct(p).padStart(6)}  ${k}${labels.has(k) ? t.fg("muted", `  ${labels.get(k)}`) : ""}`);
	if (sorted.length > 6) out.push(t.fg("dim", `    … ${sorted.length - 6} more options`));
	return out;
}

/** Urgency the judge gave the candidate, what the write would store, and the target's current one. */
function pathUrgencyLines(t: Theme, o: RememberOutcome, engine: Realmem): string[] {
	const th = engine.settings.thresholds;
	const out: string[] = [];
	const d = o.decision;
	if (!engine.settings.paths.inject) out.push(t.fg("warning", "path notes are off (settings): urgency has no effect right now"));
	if (!d?.paths) {
		out.push(
			t.fg(
				"muted",
				o.candidate.paths
					? "not used: the candidate's paths were dropped, it covers the whole root"
					: "not asked: no paths, the memory covers the whole root and is never shown on path touch",
			),
		);
	} else if (d.urgency === undefined) {
		out.push(t.fg("muted", o.trace.judge ? "judge returned no path_urgency answer" : "not judged (SemIf not run)"));
	} else {
		out.push(`candidate: ${urgencySummary(t, d.urgency, th)}`);
		out.push(...urgencyBreakdown(t, { score: d.urgency, probabilities: d.urgencyProbs, confidence: d.urgencyConfidence }, th, "  "));
		const effect =
			d.action === "add"
				? "stored with the new memory"
				: d.action === "edit" || d.action === "merge" || (d.action === "reinforce" && d.widen)
					? "not stored: the target's content or paths change, so its urgency is re-judged in the background"
					: "not stored: the target keeps its own urgency";
		out.push(t.fg("muted", `on write: ${effect}`));
	}
	const target = d?.target;
	if (target && scopePaths(target)) {
		const g = engine.db.getUrgency(target.store, target.id);
		const current = g && g.basis === urgencyBasis(target);
		out.push(
			`target ${target.id}: ${g ? (current ? urgencySummary(t, g.score, th) : t.fg("warning", `stale ${g.score.toFixed(2)}/2, re-judged soon`)) : "not judged yet (caption)"}`,
		);
	} else if (target) out.push(t.fg("muted", `target ${target.id}: covers the whole root, no urgency`));
	return out;
}

function reportLines(o: RememberOutcome, showState: boolean, engine: Realmem): (t: Theme) => string[] {
	const th = engine.settings.thresholds;
	return (t) => {
		const out: string[] = [];
		const h = (s: string) => {
			out.push("", t.fg("accent", t.bold(`■ ${s}`)));
		};
		out.push(`${t.bold("Result:")} ${o.status === "planned" ? t.fg("warning", o.message) : o.message}`);
		if (o.error) out.push(t.fg("error", o.error));

		h("Candidate");
		out.push(`caption: ${o.candidate.caption}`);
		if (o.candidate.scopeHint) out.push(`scope hint: ${SCOPE_LABEL[o.candidate.scopeHint]}`);
		out.push(`paths: ${o.candidate.paths ? o.candidate.paths.join(", ") : "(none: whole project root, or ~ for global)"}`);
		for (const l of o.candidate.content.split("\n")) out.push(t.fg("muted", `  ${l}`));
		const sf = o.safety;
		out.push(
			`local safety scan: ${sf.secrets.length || sf.injections.length ? t.fg("warning", [...sf.secrets, ...sf.injections].join(", ")) : t.fg("success", "clean")}${sf.redacted ? " (redacted)" : ""}`,
		);

		h("Embedding");
		const e = o.trace.embed;
		if (e?.error) out.push(t.fg("error", `failed after ${e.ms} ms: ${e.error} (fell back to keyword search)`));
		else out.push(e ? `${e.dims} dims, ${e.cached ? "from cache" : `${e.tokens} tokens`}, ${e.ms} ms` : t.fg("muted", "not run (no embedding endpoint or exact duplicate)"));

		h("Similar memories (hybrid vector + BM25, RRF)");
		const s = o.trace.search;
		if (s) out.push(t.fg("muted", `${s.neighbors} found (${s.vecHits} by vector, ${s.ftsHits} by keywords) in ${s.ms} ms`));
		const included = new Set(o.judgeRequest?.included.map((n) => n.memory.id));
		for (const n of o.neighbors.slice(0, 20)) {
			const tag = included.has(n.memory.id) ? "" : t.fg("dim", " (not sent)");
			out.push(
				`${n.memory.id}  rrf ${n.score.toFixed(4)}  cos ${n.vecScore === undefined ? "  —  " : n.vecScore.toFixed(3)}  bm25 ${n.ftsScore === undefined ? " — " : n.ftsScore.toFixed(2)}  [${SCOPE_LABEL[n.memory.kind]}] ${oneLine(n.memory.caption, 80)}${tag}`,
			);
		}
		if (o.neighbors.length > 20) out.push(t.fg("dim", `… ${o.neighbors.length - 20} more`));
		if (o.neighbors.length === 0) out.push(t.fg("muted", "none"));

		h("SemIf judge");
		const j = o.trace.judge;
		if (!j) out.push(t.fg("muted", "not run"));
		else {
			out.push(
				t.fg(
					"muted",
					`${j.requests} request(s), ${j.ms} ms, ${j.inputTokens} input tokens, state ≈${o.judgeRequest?.stateTokens ?? 0} tokens, ${o.judgeRequest?.included.length ?? 0} memories in state${o.judgeRequest?.omitted ? `, ${o.judgeRequest.omitted} omitted (budget)` : ""}`,
				),
			);
			for (const tr of j.traces) out.push(t.fg("dim", `  ${tr.status} ${tr.url} ${tr.ms} ms${tr.requestId ? ` id=${tr.requestId}` : ""}${tr.attempts > 1 ? ` (${tr.attempts} attempts)` : ""}`));
			const labels = new Map(o.neighbors.map((n) => [n.memory.id, oneLine(n.memory.caption, 60)]));
			for (const r of o.judgeResponses ?? []) for (const [name, a] of Object.entries(r.answers)) out.push(...answerLines(t, name, a, labels));
		}

		h("Decision");
		if (o.decision) {
			if (o.decision.paths) out.push(`paths: ${o.decision.paths.join(", ")}${o.decision.urgency !== undefined ? ` · urgency ${o.decision.urgency.toFixed(2)}/2 (${urgencyTier(o.decision.urgency, th)})` : ""}${o.decision.widen ? " · widens target" : ""}`);
			out.push(`${t.bold(o.decision.action.toUpperCase())} → ${SCOPE_LABEL[o.decision.scope]}${o.decision.target ? ` · target ${o.decision.target.id} "${oneLine(o.decision.target.caption, 60)}"` : ""}`);
			for (const r of o.decision.reasons) out.push(t.fg("muted", `  • ${r}`));
		} else out.push(t.fg("muted", "none"));

		h("Path urgency");
		out.push(...pathUrgencyLines(t, o, engine));

		if (o.before || o.proposed) {
			h(o.trace.rewrite ? `Rewrite (${o.trace.rewrite.model}, ${o.trace.rewrite.ms} ms)` : "Memory to write");
			if (o.trace.rewrite?.fallback) out.push(t.fg("warning", `fallback: ${o.trace.rewrite.fallback}`));
			if (o.before) {
				out.push(t.fg("toolDiffRemoved", `- # ${o.before.caption}`));
				for (const l of o.before.content.split("\n")) out.push(t.fg("toolDiffRemoved", `- ${l}`));
			}
			if (o.proposed) {
				out.push(t.fg("toolDiffAdded", `+ # ${o.proposed.caption}`));
				for (const l of o.proposed.content.split("\n")) out.push(t.fg("toolDiffAdded", `+ ${l}`));
			}
		}

		if (showState && o.judgeRequest) {
			h("SemIf state (as sent)");
			for (const l of o.judgeRequest.state.split("\n")) out.push(t.fg("dim", l));
			h("SemIf questions");
			for (const l of truncate(JSON.stringify(o.judgeRequest.questions, null, 2), 20_000).split("\n")) out.push(t.fg("dim", l));
		}
		return out;
	};
}

async function askCandidate(ctx: ExtensionCommandContext, prev?: { caption: string; content: string }): Promise<{ caption: string; content: string } | undefined> {
	const text = await ctx.ui.editor(
		"Candidate fact: first line = caption, the rest = content",
		prev ? `${prev.caption}\n${prev.content}` : "Build the project with pnpm\nRun `pnpm install` once, then `pnpm build`. The output lands in dist/.",
	);
	if (!text?.trim()) return undefined;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const first = lines.findIndex((l) => l.trim());
	const caption = lines[first].replace(/^#+\s*/, "").trim();
	const content = lines.slice(first + 1).join("\n").trim() || caption;
	return { caption, content };
}

export async function openDebug(ctx: ExtensionCommandContext, engine: Realmem, onCommit: () => void): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/realmem debug needs the interactive TUI", "warning");
		return;
	}
	let cand = await askCandidate(ctx);
	if (!cand) return;
	let scope: ScopeKind | undefined;
	let force = false;
	let paths: string[] | undefined;
	for (;;) {
		const input = { caption: cand.caption, content: cand.content, paths, scope, force, source: "debug" as const };
		const rw = rewriterFor(engine, ctx);
		const r = await runWithLoader(ctx, "running remember path (dry run)", (signal, setMessage) =>
			engine.remember(input, { cwd: ctx.cwd, dryRun: true, rewriter: rw.rewriter, signal, onStep: (s) => setMessage(`dry run: ${s}`) }),
		);
		if (r.cancelled) return;
		if (r.error || !r.value) {
			const msg = r.error instanceof CandidateError || r.error instanceof Error ? r.error.message : String(r.error);
			const again = await showText(ctx, "realmem debug · failed", (t) => [t.fg("error", msg)], [{ id: "edit" as const, key: "e", label: "edit candidate" }]);
			if (again !== "edit") return;
			cand = (await askCandidate(ctx, cand)) ?? cand;
			continue;
		}
		const outcome = r.value;
		let showState = false;
		let action: "commit" | "edit" | "state" | "scope" | "paths" | "force" | "rerun" | undefined;
		for (;;) {
			const canCommit = outcome.status === "planned";
			action = await showText(ctx, `realmem debug · ${outcome.status}${rw.model ? ` · rewrite model ${rw.model}` : ""}`, reportLines(outcome, showState, engine), [
				...(canCommit ? [{ id: "commit" as const, key: "w", label: "write to memory" }] : []),
				{ id: "edit" as const, key: "e", label: "edit candidate" },
				{ id: "scope" as const, key: "s", label: `scope: ${scope ? SCOPE_LABEL[scope] : "auto"}` },
				{ id: "paths" as const, key: "p", label: `paths: ${paths ? oneLine(paths.join(", "), 30) : "none"}` },
				{ id: "force" as const, key: "f", label: `user_requested: ${force ? "yes" : "no"}` },
				{ id: "rerun" as const, key: "r", label: "rerun" },
				{ id: "state" as const, key: "v", label: showState ? "hide raw request" : "show raw request" },
			]);
			if (action === "state") {
				showState = !showState;
				continue;
			}
			break;
		}
		if (!action) return;
		if (action === "commit") {
			const ok = await ctx.ui.confirm("Write to memory?", `${outcome.message}\n\nThis changes the memory base.`);
			if (!ok) continue;
			try {
				const done = await engine.commitPlanned(outcome, { cwd: ctx.cwd });
				onCommit();
				ctx.ui.notify(`realmem: ${done.message}`, "info");
			} catch (err) {
				ctx.ui.notify(`realmem: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return;
		}
		if (action === "edit") cand = (await askCandidate(ctx, cand)) ?? cand;
		else if (action === "force") force = !force;
		else if (action === "paths") {
			const v = await ctx.ui.editor(
				"Candidate paths, one per line: files, directories or globs relative to the cwd, ~/… or absolute (empty = whole root)",
				(paths ?? []).join("\n"),
			);
			if (v !== undefined) {
				const list = v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
				paths = list.length > 0 ? list : undefined;
			}
		}
		else if (action === "scope") {
			const sc = engine.scopes(ctx.cwd);
			const opts = ["auto", ...sc.stores.map((s) => SCOPE_LABEL[s.kind])];
			const pick = await ctx.ui.select("Scope hint", opts);
			if (pick) scope = pick === "auto" ? undefined : (Object.keys(SCOPE_LABEL) as ScopeKind[]).find((k) => SCOPE_LABEL[k] === pick);
		}
	}
}
