/**
 * Per-session state for path notes: which memories were already shown on this
 * branch, which paths the agent touched recently, and the text appended to tool results.
 */
import type { CustomEntryDraft } from "@earendil-works/pi-coding-agent";

export const SHOWN_ENTRY = "realmem-shown";

interface ShownData {
	ids: string[];
}

export interface BranchEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	firstKeptEntryId?: string | null;
}

export class PathNoteState {
	private shown = new Set<string>();
	private unflushed: string[] = [];
	private recent: string[] = [];
	lastSync = 0;

	/**
	 * Rebuild from the entries of the current branch (session start, tree navigation,
	 * compaction). A compaction summarises everything before its first kept entry, so
	 * notes recorded there are no longer in context and may be shown again: only ids
	 * recorded from the first kept entry onwards stay marked.
	 */
	reset(branch: ReadonlyArray<BranchEntry>, opts: { keepUnflushed?: boolean } = {}): void {
		const pending = opts.keepUnflushed ? this.unflushed : [];
		this.shown.clear();
		this.unflushed = [];
		const index = new Map<string, number>();
		branch.forEach((e, i) => {
			if (e.id) index.set(e.id, i);
		});
		// Only the last compaction on the branch matters.
		let keptFrom = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type !== "compaction") continue;
			keptFrom = e.firstKeptEntryId && index.has(e.firstKeptEntryId) ? (index.get(e.firstKeptEntryId) as number) : i;
			break;
		}
		for (let i = keptFrom; i < branch.length; i++) {
			const e = branch[i];
			if (e.type !== "custom" || e.customType !== SHOWN_ENTRY) continue;
			const ids = (e.data as ShownData | undefined)?.ids;
			if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.shown.add(id);
		}
		// Shown in the current turn and not yet persisted: those tool results are still in context.
		for (const id of pending) {
			this.shown.add(id);
			this.unflushed.push(id);
		}
	}

	get shownIds(): Set<string> {
		return this.shown;
	}

	markShown(ids: string[]): void {
		for (const id of ids) {
			if (this.shown.has(id)) continue;
			this.shown.add(id);
			this.unflushed.push(id);
		}
	}

	/** Entry recording newly shown ids on the branch, or undefined when nothing changed. */
	flush(): CustomEntryDraft | undefined {
		if (this.unflushed.length === 0) return undefined;
		const draft: CustomEntryDraft = { type: "custom", customType: SHOWN_ENTRY, data: { ids: this.unflushed } satisfies ShownData };
		this.unflushed = [];
		return draft;
	}

	touch(paths: string[]): void {
		for (const p of paths) {
			if (!p) continue;
			const i = this.recent.indexOf(p);
			if (i >= 0) this.recent.splice(i, 1);
			this.recent.unshift(p);
		}
		if (this.recent.length > 48) this.recent.length = 48;
	}

	/** Recently touched absolute paths, most recent first. */
	recentPaths(n = 24): string[] {
		return this.recent.slice(0, n);
	}
}
