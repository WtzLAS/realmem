/**
 * /realmem consolidate: run the consolidation review and ask about every step
 * (forget, fold, revise, path change) with its full before/after text. An accepted
 * step is written at once; a skipped one is left alone.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { type ConsolidationProposal, formatProposal, type ProposalAnswer } from "../../src/consolidate.ts";
import type { ConsolidateOptions, ConsolidationResult, InteractiveConsolidationResult, Realmem } from "../../src/engine.ts";
import { TextView } from "./ui.ts";

const KEYS = [
	{ key: "y", label: "accept" },
	{ key: "n", label: "skip" },
	{ key: "q", label: "stop" },
];

function answerFor(data: string): ProposalAnswer | undefined {
	if (data === "y") return "accept";
	if (data === "n") return "skip";
	if (data === "q" || matchesKey(data, Key.escape)) return "stop";
	return undefined;
}

/** Loader while the judge works; a proposal screen while it waits for an answer. */
class ConsolidateScreen implements Component {
	readonly loader: CancellableLoader;
	private view: TextView | undefined;
	private answer: ((a: ProposalAnswer) => void) | undefined;
	private status = "starting";
	private written = "";

	private readonly tui: TUI;
	private readonly theme: Theme;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.loader = new CancellableLoader(tui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), this.loaderText());
	}

	private loaderText(): string {
		return `consolidating: ${this.status}${this.written} (esc to cancel)`;
	}

	setStatus(status: string): void {
		this.status = status;
		this.loader.setMessage(this.loaderText());
	}

	setWritten(text: string): void {
		this.written = text ? ` · ${text}` : "";
		this.loader.setMessage(this.loaderText());
	}

	ask(p: ConsolidationProposal): Promise<ProposalAnswer> {
		const t = this.theme;
		const lines = formatProposal(p);
		const title = `realmem consolidate · ${p.progress}${this.written}`;
		return new Promise<ProposalAnswer>((resolve) => {
			this.answer = resolve;
			this.view = new TextView(
				this.tui,
				t,
				title,
				(th) => [th.fg("accent", lines[0] ?? ""), ...lines.slice(1)],
				KEYS,
				(data) => {
					const a = answerFor(data);
					if (!a) return false;
					this.view = undefined;
					this.answer = undefined;
					this.tui.requestRender();
					resolve(a);
					return true;
				},
			);
			this.tui.requestRender();
		});
	}

	/** Unblock a pending question (the run is ending). */
	release(): void {
		this.answer?.("stop");
		this.answer = undefined;
		this.view = undefined;
	}

	render(width: number): string[] {
		return this.view ? this.view.render(width) : this.loader.render(width);
	}

	handleInput(data: string): void {
		if (this.view) this.view.handleInput(data);
		else this.loader.handleInput(data);
	}

	invalidate(): void {
		this.view?.invalidate();
		this.loader.invalidate();
	}

	dispose(): void {
		this.release();
		this.loader.dispose();
	}
}

export interface ConsolidateRun {
	value?: InteractiveConsolidationResult;
	error?: unknown;
	cancelled?: boolean;
	/** What was written before the run ended (also on cancel or error). */
	written: ConsolidationResult;
}

/** Run an interactive consolidation in the TUI (select dialogs elsewhere; without a UI every step is accepted). */
export async function runConsolidate(ctx: ExtensionCommandContext, engine: Realmem, opts: ConsolidateOptions): Promise<ConsolidateRun> {
	let written: ConsolidationResult = { updated: 0, deleted: 0, stale: [] };
	const writtenText = () => (written.updated + written.deleted > 0 ? `written: ${written.updated} updated, ${written.deleted} deleted` : "");
	if (ctx.mode !== "tui") {
		const approve = async (p: ConsolidationProposal): Promise<ProposalAnswer> => {
			if (!ctx.hasUI) return "accept";
			const pick = await ctx.ui.select(`${p.progress}\n${formatProposal(p).join("\n")}`, ["Accept", "Skip", "Stop"]);
			return pick === "Accept" ? "accept" : pick === "Skip" ? "skip" : "stop";
		};
		try {
			const value = await engine.consolidate({ ...opts, approve, onWritten: (d) => (written = d) });
			return { value, written };
		} catch (error) {
			return { error, written };
		}
	}
	return ctx.ui.custom<ConsolidateRun>((tui, theme, _kb, done) => {
		const screen = new ConsolidateScreen(tui, theme);
		let finished = false;
		const finish = (r: Omit<ConsolidateRun, "written">) => {
			if (finished) return;
			finished = true;
			screen.release();
			done({ ...r, written });
		};
		screen.loader.onAbort = () => finish({ cancelled: true });
		engine
			.consolidate({
				...opts,
				signal: screen.loader.signal,
				onStep: (s) => screen.setStatus(s),
				approve: (p) => (finished ? Promise.resolve<ProposalAnswer>("stop") : screen.ask(p)),
				onWritten: (d) => {
					written = d;
					screen.setWritten(writtenText());
				},
			})
			.then((value) => finish({ value }))
			.catch((error: unknown) => finish(screen.loader.aborted ? { cancelled: true } : { error }));
		return screen;
	});
}
