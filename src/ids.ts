import { randomBytes } from "node:crypto";

/**
 * Memory keys are UUIDv7 values. They are presented as unpadded base64url
 * (22 characters instead of the 36-character canonical form), which is the
 * cheapest faithful rendering of all 128 bits for an LLM tokenizer.
 */

let lastMs = 0;
let lastSeq = 0;

/** Generate the 16 bytes of a UUIDv7 (monotonic within one process). */
export function uuidv7Bytes(now: number = Date.now()): Uint8Array {
	const bytes = randomBytes(16);
	let ms = Math.max(0, Math.floor(now));
	let seq: number;
	if (ms <= lastMs) {
		ms = lastMs;
		seq = (lastSeq + 1) & 0x0fff;
		if (seq === 0) ms = lastMs + 1; // 12-bit counter exhausted: borrow the next millisecond
	} else {
		seq = ((bytes[6] & 0x0f) << 8) | bytes[7];
		seq &= 0x07ff; // leave headroom for increments within this millisecond
	}
	lastMs = ms;
	lastSeq = seq;
	// 48-bit big-endian unix milliseconds
	bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
	bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
	bytes[2] = (ms >>> 24) & 0xff;
	bytes[3] = (ms >>> 16) & 0xff;
	bytes[4] = (ms >>> 8) & 0xff;
	bytes[5] = ms & 0xff;
	bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
	bytes[7] = seq & 0xff;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return new Uint8Array(bytes);
}

export function encodeId(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function newId(now?: number): string {
	return encodeId(uuidv7Bytes(now));
}

const COMPACT_RE = /^[A-Za-z0-9_-]{22}$/;
const CANONICAL_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Parse a compact or canonical UUID into the compact key. Returns undefined when invalid. */
export function parseId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim();
	if (COMPACT_RE.test(v)) {
		const buf = Buffer.from(v, "base64url");
		if (buf.length !== 16) return undefined;
		// Reject non-canonical encodings (trailing bits set in the last char).
		return buf.toString("base64url") === v ? v : undefined;
	}
	if (CANONICAL_RE.test(v)) {
		return Buffer.from(v.replace(/-/g, ""), "hex").toString("base64url");
	}
	return undefined;
}

export function toCanonicalUuid(id: string): string {
	const hex = Buffer.from(id, "base64url").toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Creation time embedded in a UUIDv7 key (undefined for other versions). */
export function idTimestamp(id: string): number | undefined {
	const b = Buffer.from(id, "base64url");
	if (b.length !== 16 || b[6] >> 4 !== 7) return undefined;
	return b.readUIntBE(0, 6);
}
