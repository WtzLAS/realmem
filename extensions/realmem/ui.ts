/**
 * Small TUI toolkit for realmem pages: a scrollable text view, a text-input
 * submenu for SettingsList, a filterable picker, and a cancellable task runner.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	type Component,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";

export type LineBuilder = (theme: Theme, width: number) => string[];

export interface KeyHint {
	key: string;
	label: string;
}

function rule(theme: Theme, width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

function hints(theme: Theme, list: KeyHint[], width: number): string {
	const text = list.map((h) => `${theme.fg("accent", h.key)} ${theme.fg("muted", h.label)}`).join(theme.fg("dim", " · "));
	return truncateToWidth(text, width);
}

/** Scrollable, wrapped text screen. */
export class TextView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private title: string;
	private build: LineBuilder;
	private keys: KeyHint[];
	private readonly onKey: (data: string) => boolean;
	private scroll = 0;
	private cache: { width: number; lines: string[] } | undefined;
	private message: string | undefined;

	constructor(tui: TUI, theme: Theme, title: string, build: LineBuilder, keys: KeyHint[], onKey: (data: string) => boolean) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.build = build;
		this.keys = keys;
		this.onKey = onKey;
	}

	setContent(title: string, build: LineBuilder, keys?: KeyHint[]): void {
		this.title = title;
		this.build = build;
		if (keys) this.keys = keys;
		this.cache = undefined;
		this.tui.requestRender();
	}

	setMessage(message: string | undefined): void {
		this.message = message;
		this.tui.requestRender();
	}

	private bodyHeight(): number {
		return Math.max(6, this.tui.terminal.rows - 6);
	}

	private lines(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const out: string[] = [];
		for (const l of this.build(this.theme, width)) {
			if (l === "") out.push("");
			else for (const w of wrapTextWithAnsi(l, Math.max(10, width))) out.push(w);
		}
		this.cache = { width, lines: out };
		return out;
	}

	render(width: number): string[] {
		const t = this.theme;
		const body = this.lines(width);
		const h = this.bodyHeight();
		const maxScroll = Math.max(0, body.length - h);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
		const pos = body.length > h ? t.fg("dim", ` ${this.scroll + 1}-${Math.min(body.length, this.scroll + h)}/${body.length}`) : "";
		const head = truncateToWidth(`${t.fg("accent", t.bold(this.title))}${pos}`, width);
		const out = [head, rule(t, width)];
		for (const l of body.slice(this.scroll, this.scroll + h)) out.push(truncateToWidth(l, width));
		out.push(rule(t, width));
		if (this.message) out.push(truncateToWidth(this.message, width));
		out.push(hints(t, [...this.keys, { key: "↑↓/PgUp/PgDn", label: "scroll" }, { key: "esc", label: "back" }], width));
		return out;
	}

	handleInput(data: string): void {
		const page = this.bodyHeight() - 1;
		if (this.onKey(data)) return;
		if (matchesKey(data, Key.up) || data === "k") this.scroll--;
		else if (matchesKey(data, Key.down) || data === "j") this.scroll++;
		else if (matchesKey(data, Key.pageUp)) this.scroll -= page;
		else if (matchesKey(data, Key.pageDown) || data === " ") this.scroll += page;
		else if (matchesKey(data, Key.home) || data === "g") this.scroll = 0;
		else if (matchesKey(data, Key.end) || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** Show a TextView and resolve with the key action chosen (or undefined on escape). */
export async function showText<T extends string>(
	ctx: ExtensionContext,
	title: string,
	build: LineBuilder,
	actions: Array<KeyHint & { id: T }> = [],
): Promise<T | undefined> {
	return ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
		const view = new TextView(tui, theme, title, build, actions, (data) => {
			if (matchesKey(data, Key.escape) || data === "q") {
				done(undefined);
				return true;
			}
			const a = actions.find((x) => x.key === data);
			if (a) {
				done(a.id);
				return true;
			}
			return false;
		});
		return view;
	});
}

/** Set an Input's value with the cursor at the end (Input.setValue keeps the old cursor, i.e. 0). */
function setInputValue(input: Input, value: string): void {
	input.setValue(value);
	input.handleInput("\x05"); // ctrl+e: end of line
}

/** A SettingsList submenu that edits one text value. */
export class InputSubmenu implements Component {
	private readonly input = new Input();
	private readonly theme: Theme;
	private readonly label: string;
	private readonly help: string;
	private readonly validate: (v: string) => string | undefined;
	private readonly done: (v?: string) => void;
	private readonly keepEmpty: boolean;
	private error: string | undefined;

	constructor(opts: {
		theme: Theme;
		label: string;
		help?: string;
		value: string;
		/** Secrets start empty; an empty submit keeps the old value. */
		secret?: boolean;
		validate?: (v: string) => string | undefined;
		done: (v?: string) => void;
	}) {
		this.theme = opts.theme;
		this.label = opts.label;
		this.help = opts.help ?? "";
		this.validate = opts.validate ?? (() => undefined);
		this.done = opts.done;
		this.keepEmpty = !!opts.secret;
		if (!opts.secret) setInputValue(this.input, opts.value);
		this.input.focused = true;
		this.input.onSubmit = (v) => {
			const value = v.trim();
			if (this.keepEmpty && value === "") return this.done();
			const err = this.validate(value);
			if (err) {
				this.error = err;
				return;
			}
			this.done(value);
		};
		this.input.onEscape = () => this.done();
	}

	render(width: number): string[] {
		const t = this.theme;
		const out = [truncateToWidth(t.fg("accent", t.bold(this.label)), width)];
		if (this.help) for (const l of wrapTextWithAnsi(t.fg("muted", this.help), width)) out.push(l);
		out.push(...this.input.render(width));
		if (this.error) out.push(truncateToWidth(t.fg("error", this.error), width));
		out.push(truncateToWidth(t.fg("dim", this.keepEmpty ? "enter save (empty keeps current) · esc cancel" : "enter save · esc cancel"), width));
		return out;
	}

	handleInput(data: string): void {
		this.error = undefined;
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

/** Filterable picker (type to filter, ↑↓, enter, esc). */
export class FilterPicker implements Component {
	private readonly input = new Input();
	private list: SelectList;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly items: SelectItem[];
	private readonly maxVisible: number;
	private readonly done: (value?: string) => void;

	constructor(opts: { theme: Theme; title: string; items: SelectItem[]; selected?: string; maxVisible?: number; done: (value?: string) => void }) {
		this.theme = opts.theme;
		this.title = opts.title;
		this.items = opts.items;
		this.maxVisible = opts.maxVisible ?? 12;
		this.done = opts.done;
		this.list = this.makeList(opts.items);
		const idx = opts.items.findIndex((i) => i.value === opts.selected);
		if (idx >= 0) this.list.setSelectedIndex(idx);
		this.input.focused = true;
	}

	private makeList(items: SelectItem[]): SelectList {
		const list = new SelectList(items, this.maxVisible, getSelectListTheme());
		list.onSelect = (item) => this.done(item.value);
		list.onCancel = () => this.done();
		return list;
	}

	/** Substring filter over value, label and description (SelectList.setFilter only matches value prefixes). */
	private applyFilter(): void {
		const words = this.input.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		const items =
			words.length === 0
				? this.items
				: this.items.filter((i) => {
						const hay = `${i.value} ${i.label} ${i.description ?? ""}`.toLowerCase();
						return words.every((w) => hay.includes(w));
					});
		this.list = this.makeList(items);
	}

	render(width: number): string[] {
		const t = this.theme;
		return [
			truncateToWidth(t.fg("accent", t.bold(this.title)), width),
			...this.input.render(width).map((l) => truncateToWidth(`${t.fg("dim", "filter: ")}${l}`, width)),
			...this.list.render(width),
			truncateToWidth(t.fg("dim", "type to filter · ↑↓ move · enter select · esc cancel"), width),
		];
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.up) ||
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.pageDown)
		) {
			this.list.handleInput(data);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) this.applyFilter();
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}

/** A submenu that runs an async action and shows its result until a key is pressed. */
export class ActionSubmenu implements Component {
	private readonly theme: Theme;
	private readonly title: string;
	private lines: string[] = [];
	private running = true;
	private readonly controller = new AbortController();
	private readonly done: () => void;

	constructor(opts: { tui: TUI; theme: Theme; title: string; run: (signal: AbortSignal) => Promise<string[]>; done: () => void }) {
		this.theme = opts.theme;
		this.title = opts.title;
		this.done = opts.done;
		this.lines = [opts.theme.fg("muted", "running…")];
		opts
			.run(this.controller.signal)
			.then((l) => {
				this.lines = l;
			})
			.catch((err: unknown) => {
				this.lines = [opts.theme.fg("error", err instanceof Error ? err.message : String(err))];
			})
			.finally(() => {
				this.running = false;
				opts.tui.requestRender();
			});
	}

	render(width: number): string[] {
		const t = this.theme;
		const out = [truncateToWidth(t.fg("accent", t.bold(this.title)), width)];
		for (const l of this.lines) for (const w of wrapTextWithAnsi(l, width)) out.push(w);
		out.push(truncateToWidth(t.fg("dim", this.running ? "esc cancel" : "any key to return"), width));
		return out;
	}

	handleInput(data: string): void {
		if (this.running) {
			if (matchesKey(data, Key.escape)) {
				this.controller.abort();
				this.done();
			}
			return;
		}
		this.done();
	}

	invalidate(): void {}
}

/** Run an async task behind a cancellable loader. Resolves undefined when cancelled. */
export async function runWithLoader<T>(ctx: ExtensionContext, message: string, task: (signal: AbortSignal, setMessage: (m: string) => void) => Promise<T>): Promise<{ value?: T; error?: unknown; cancelled?: boolean }> {
	if (ctx.mode !== "tui") {
		try {
			return { value: await task(new AbortController().signal, () => {}) };
		} catch (error) {
			return { error };
		}
	}
	return ctx.ui.custom<{ value?: T; error?: unknown; cancelled?: boolean }>((tui, theme, _kb, done) => {
		const loader = new CancellableLoader(
			tui,
			(s) => theme.fg("accent", s),
			(s) => theme.fg("muted", s),
			`${message} (esc to cancel)`,
		);
		let finished = false;
		loader.onAbort = () => {
			if (finished) return;
			finished = true;
			done({ cancelled: true });
		};
		task(loader.signal, (m) => loader.setMessage(`${m} (esc to cancel)`))
			.then((value) => {
				if (finished) return;
				finished = true;
				done({ value });
			})
			.catch((error: unknown) => {
				if (finished) return;
				finished = true;
				done(loader.aborted ? { cancelled: true } : { error });
			});
		return loader;
	});
}

export function padRight(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? truncateToWidth(s, width) : s + " ".repeat(width - w);
}
