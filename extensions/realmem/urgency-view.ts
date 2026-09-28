/**
 * Path urgency details shared by the manage and debug pages: score, tier under
 * the current thresholds, what the tier does on path touch, the judge's
 * per-level probabilities and confidence.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Settings } from "../../src/config.ts";
import { URGENCY_LEVELS, type UrgencyTier, urgencyTier } from "../../src/judge.ts";

type Thresholds = Pick<Settings["thresholds"], "urgencyHigh" | "urgencyMid">;

export interface UrgencyDetail {
	score: number;
	probabilities?: Record<string, number>;
	confidence?: number;
}

/** What a tier does when the agent touches the memory's paths. */
export const TIER_EFFECT: Record<UrgencyTier, string> = {
	high: "shown in full on path touch",
	mid: "caption shown on path touch",
	low: "only counted on path touch",
};

const LEVEL_NAME = URGENCY_LEVELS.map((l) => l.split(":")[0].trim());
/** Short gloss of each level (full wording: URGENCY_LEVELS, as asked to SemIf). */
const LEVEL_HINT = ["can wait", "caption", "show in full"];

const pct = (p: number | undefined) => (p === undefined ? "n/a" : `${(p * 100).toFixed(1)}%`);

export function tierColor(tier: UrgencyTier): "success" | "accent" | "muted" {
	return tier === "high" ? "success" : tier === "mid" ? "accent" : "muted";
}

/** "1.62/2 → high (shown in full on path touch)" */
export function urgencySummary(t: Theme, score: number, th: Thresholds): string {
	const tier = urgencyTier(score, th);
	return `${score.toFixed(2)}/2 → ${t.fg(tierColor(tier), tier)} (${TIER_EFFECT[tier]})`;
}

/**
 * Per-level probability bars plus confidence and the thresholds in force.
 * `indent` prefixes every line (the pages align these under their own labels).
 */
export function urgencyBreakdown(t: Theme, d: UrgencyDetail, th: Thresholds, indent: string): string[] {
	const out: string[] = [];
	const probs = d.probabilities;
	if (probs && Object.keys(probs).length > 0) {
		const width = 20;
		URGENCY_LEVELS.forEach((_desc, i) => {
			const p = probs[String(i)] ?? 0;
			const bar = "█".repeat(Math.round(p * width)).padEnd(width, "·");
			const name = (LEVEL_NAME[i] ?? String(i)).padEnd(5);
			out.push(`${indent}${name}${pct(p).padStart(7)}  ${t.fg("accent", bar)}  ${t.fg("dim", LEVEL_HINT[i] ?? "")}`);
		});
	} else out.push(`${indent}${t.fg("dim", "per-level probabilities not recorded (judged before they were stored)")}`);
	const conf = d.confidence === undefined ? "" : `confidence ${pct(d.confidence)} · `;
	out.push(`${indent}${t.fg("muted", `${conf}full ≥ ${th.urgencyHigh.toFixed(2)}, caption ≥ ${th.urgencyMid.toFixed(2)}, below: counted`)}`);
	return out;
}
