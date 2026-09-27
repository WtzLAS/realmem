import { createHash } from "node:crypto";

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The text that is embedded and hashed for a memory: caption + content. */
export function memoryText(caption: string, content: string): string {
	return `${caption.trim()}\n\n${content.trim()}`;
}

export function textHash(caption: string, content: string): string {
	return sha256(memoryText(caption, content));
}

/** Collapse whitespace and control characters into a single line. */
export function oneLine(text: string, max = 200): string {
	const s = text
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// ---------------------------------------------------------------------------
// Full-text tokenization with CJK fallback.
//
// FTS5's unicode61 tokenizer splits on whitespace/punctuation only, so a run of
// Chinese or Japanese text becomes one giant token. We pre-tokenize both the
// indexed text and the query in JS:
//  - Intl.Segmenter (ICU dictionary word breaking) gives words for every script;
//  - every CJK run additionally contributes overlapping character bigrams (and
//    unigrams in the index), so matching does not depend on segmentation
//    agreeing between the document and the query.
// Tokens are joined with spaces and indexed by unicode61, which then only has to
// split on the spaces (and punctuation inside Latin tokens).
// ---------------------------------------------------------------------------

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u30fc]+/gu;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

let segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter | undefined {
	if (segmenter) return segmenter;
	try {
		segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	} catch {
		segmenter = undefined;
	}
	return segmenter;
}

function normalize(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

function words(text: string): string[] {
	const seg = getSegmenter();
	if (!seg) return text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
	const out: string[] = [];
	for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment);
	return out;
}

/** Split identifiers such as `usedCount` / `HTTPServer2` into extra sub-words. */
function subWords(word: string): string[] {
	if (HAS_CJK.test(word)) return [];
	const parts = word
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((p) => p.length > 1);
	return parts.length > 1 ? parts.map((p) => p.toLowerCase()) : [];
}

function cjkGrams(text: string, withUnigrams: boolean): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(CJK_RUN)) {
		const chars = [...m[0]];
		if (chars.length === 1 || withUnigrams) out.push(...chars);
		for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
	}
	return out;
}

/** Tokens stored in the FTS index for a document field. */
export function indexTokens(text: string): string {
	const raw = text.normalize("NFKC");
	const norm = raw.toLowerCase();
	const tokens: string[] = [];
	for (const w of words(raw)) {
		tokens.push(w.toLowerCase());
		tokens.push(...subWords(w));
	}
	tokens.push(...cjkGrams(norm, true));
	return tokens.join(" ");
}

const STOPWORDS = new Set(
	(
		"a an and are as at be but by can do does for from how i if in into is it its of on or should so that the their them then there these this " +
		"to was we what when where which who why will with you your about any all use using used"
	).split(" "),
);

/** Distinct query tokens (stopwords removed). */
export function queryTokens(text: string): string[] {
	const raw = text.normalize("NFKC");
	const norm = normalize(text);
	const set = new Set<string>();
	for (const w of words(raw)) {
		const lw = w.toLowerCase();
		if (HAS_CJK.test(lw)) {
			// CJK words are covered by bigrams; keep the whole word only when short.
			if ([...lw].length <= 4) set.add(lw);
			continue;
		}
		if (lw.length < 2 && !/\d/.test(lw)) continue;
		if (STOPWORDS.has(lw)) continue;
		set.add(lw);
		for (const s of subWords(w)) if (!STOPWORDS.has(s)) set.add(s);
	}
	for (const g of cjkGrams(norm, false)) set.add(g);
	return [...set].slice(0, 64);
}

/** Build an FTS5 MATCH expression (OR of quoted tokens), or undefined when empty. */
export function ftsQuery(texts: string[]): string | undefined {
	const set = new Set<string>();
	for (const t of texts) for (const tok of queryTokens(t)) set.add(tok);
	if (set.size === 0) return undefined;
	return [...set]
		.slice(0, 128)
		.map((t) => `"${t.replace(/"/g, '""')}"`)
		.join(" OR ");
}

export function hasCjk(text: string): boolean {
	return HAS_CJK.test(text);
}

/** Rough token estimate: CJK characters ~1 token each, other text ~4 characters per token. */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const m of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)) cjk += m[0].length;
	return Math.ceil(cjk + (text.length - cjk) / 3.5);
}
