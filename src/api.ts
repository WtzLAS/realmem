import { normalizeEndpoint, resolveSecret, type Settings } from "./config.ts";

export class ApiError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	readonly requestId: string | undefined;

	constructor(message: string, status?: number, body?: string, requestId?: string) {
		super(message);
		this.status = status;
		this.body = body;
		this.requestId = requestId;
	}
}

export interface HttpTrace {
	url: string;
	status: number;
	ms: number;
	requestId?: string;
	attempts: number;
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const t = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([t, signal]) : t;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});

function errorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
		if (parsed?.error) return [parsed.error.type, parsed.error.code, parsed.error.message].filter(Boolean).join(": ");
	} catch {
		// not JSON
	}
	return body.slice(0, 300);
}

/** POST JSON with retries on overload (503/529/429) and transient network errors. */
export async function postJson<T>(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { timeoutMs: number; signal?: AbortSignal; retries?: number },
): Promise<{ data: T; trace: HttpTrace }> {
	const retries = opts.retries ?? 3;
	const started = Date.now();
	let lastErr: unknown;
	for (let attempt = 1; attempt <= retries + 1; attempt++) {
		if (opts.signal?.aborted) throw new ApiError("aborted");
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
		if (apiKey) headers.authorization = `Bearer ${apiKey}`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: combineSignals(opts.timeoutMs, opts.signal),
			});
		} catch (err) {
			lastErr = err;
			if (opts.signal?.aborted) throw new ApiError("aborted");
			const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
			if (isTimeout || attempt > retries) {
				throw new ApiError(`${isTimeout ? "timed out" : "request failed"}: ${url} (${err instanceof Error ? err.message : String(err)})`);
			}
			await sleep(300 * attempt, opts.signal);
			continue;
		}
		const requestId = res.headers.get("x-request-id") ?? res.headers.get("x-typesafe-request-id") ?? undefined;
		const text = await res.text();
		if (res.ok) {
			let data: T;
			try {
				data = JSON.parse(text) as T;
			} catch {
				throw new ApiError(`invalid JSON from ${url}`, res.status, text.slice(0, 500), requestId);
			}
			return { data, trace: { url, status: res.status, ms: Date.now() - started, requestId, attempts: attempt } };
		}
		if ((res.status === 503 || res.status === 529 || res.status === 429) && attempt <= retries) {
			const ra = Number(res.headers.get("retry-after"));
			await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(10_000, ra * 1000) : 500 * attempt, opts.signal);
			lastErr = new ApiError(`HTTP ${res.status}`, res.status, text, requestId);
			continue;
		}
		throw new ApiError(`HTTP ${res.status} from ${url}: ${errorMessage(text)}`, res.status, text.slice(0, 2000), requestId);
	}
	throw lastErr instanceof Error ? lastErr : new ApiError(String(lastErr));
}

export async function getJson<T>(url: string, apiKey: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const res = await fetch(url, { headers, signal: combineSignals(timeoutMs, signal) });
	const text = await res.text();
	if (!res.ok) throw new ApiError(`HTTP ${res.status} from ${url}: ${errorMessage(text)}`, res.status, text.slice(0, 2000));
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ApiError(`invalid JSON from ${url}`, res.status, text.slice(0, 500));
	}
}

/**
 * Model ids from a `/v1/models` response: OpenAI `{data: [{id}]}`, also `{models: [...]}`
 * or a plain array, of objects (`id`, `name` or `model`) or strings. Sorted, deduplicated.
 */
export function parseModelIds(v: unknown): string[] {
	const list = Array.isArray(v)
		? v
		: v && typeof v === "object"
			? ((v as { data?: unknown }).data ?? (v as { models?: unknown }).models)
			: undefined;
	if (!Array.isArray(list)) return [];
	const ids = list
		.map((m) => (typeof m === "string" ? m : m && typeof m === "object" ? ((m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name ?? (m as Record<string, unknown>).model) : undefined))
		.filter((x): x is string => typeof x === "string" && x.trim() !== "")
		.map((x) => x.trim());
	return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * The model to send: the configured one, else the server's only model (asked once
 * per client). An empty setting with several listed models is an error.
 */
async function resolveModel(
	api: string,
	configured: string,
	cache: { model?: string },
	list: (signal?: AbortSignal) => Promise<string[]>,
	signal?: AbortSignal,
): Promise<string> {
	const set = configured.trim();
	if (set) return set;
	if (cache.model) return cache.model;
	const ids = await list(signal);
	if (ids.length === 1) {
		cache.model = ids[0];
		return ids[0];
	}
	throw new ApiError(
		ids.length === 0
			? `no ${api} model set and the server lists none (/realmem settings)`
			: `no ${api} model set and the server lists ${ids.length} (${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ", …" : ""}): pick one in /realmem settings`,
	);
}

// ---------------------------------------------------------------------------
// Embeddings (OpenAI-compatible, with the `instruction` extension)
// ---------------------------------------------------------------------------

interface EmbeddingResponse {
	data: Array<{ index: number; embedding: number[] | string }>;
	usage?: { prompt_tokens?: number; total_tokens?: number };
	model?: string;
}

export interface EmbedResult {
	vectors: Float32Array[];
	tokens: number;
	traces: HttpTrace[];
}

function decodeEmbedding(e: number[] | string): Float32Array {
	if (typeof e === "string") {
		const buf = Buffer.from(e, "base64");
		const out = new Float32Array(buf.byteLength / 4);
		for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
		return out;
	}
	return Float32Array.from(e);
}

function l2normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n);
	if (n > 0 && Math.abs(n - 1) > 1e-4) for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

export class EmbeddingClient {
	private readonly settings: Settings;
	/** Model picked automatically (the server's only one) when none is configured. */
	private readonly auto: { model?: string } = {};

	constructor(settings: Settings) {
		this.settings = settings;
	}

	get configured(): boolean {
		return !!normalizeEndpoint(this.settings.embedding.endpoint);
	}

	private get base(): string {
		return normalizeEndpoint(this.settings.embedding.endpoint);
	}

	/**
	 * Embed texts. Documents are embedded without an instruction; queries use the
	 * configured retrieval instruction (Qwen3-Embedding is instruction-aware).
	 */
	async embed(texts: string[], kind: "document" | "query", signal?: AbortSignal): Promise<EmbedResult> {
		const cfg = this.settings.embedding;
		if (!this.configured) throw new ApiError("embedding endpoint is not configured (/realmem settings)");
		const key = resolveSecret(cfg.apiKey);
		const model = await this.model(signal);
		const vectors: Float32Array[] = [];
		const traces: HttpTrace[] = [];
		let tokens = 0;
		for (let i = 0; i < texts.length; i += cfg.batchSize) {
			const batch = texts.slice(i, i + cfg.batchSize).map((t) => (t.trim() ? t : "(empty)"));
			const body: Record<string, unknown> = {
				model,
				input: batch,
				dimensions: cfg.dimensions,
				encoding_format: "base64",
			};
			if (kind === "query" && cfg.queryInstruction.trim()) body.instruction = cfg.queryInstruction.trim();
			const { data, trace } = await postJson<EmbeddingResponse>(`${this.base}/v1/embeddings`, key, body, { timeoutMs: cfg.timeoutMs, signal });
			traces.push(trace);
			if (!Array.isArray(data.data) || data.data.length !== batch.length) {
				throw new ApiError(`embedding response has ${data.data?.length ?? 0} vectors for ${batch.length} inputs`);
			}
			const sorted = [...data.data].sort((a, b) => a.index - b.index);
			for (const d of sorted) vectors.push(l2normalize(decodeEmbedding(d.embedding)));
			tokens += data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0;
		}
		return { vectors, tokens, traces };
	}

	async health(signal?: AbortSignal): Promise<unknown> {
		return getJson(`${this.base}/v1/models`, resolveSecret(this.settings.embedding.apiKey), 10_000, signal);
	}

	/** Model ids the embeddings server lists at /v1/models. */
	async listModels(signal?: AbortSignal): Promise<string[]> {
		if (!this.configured) throw new ApiError("embedding endpoint is not configured (/realmem settings)");
		return parseModelIds(await this.health(signal));
	}

	/** The configured model, else the server's only one. */
	model(signal?: AbortSignal): Promise<string> {
		return resolveModel("embedding", this.settings.embedding.model, this.auto, (sg) => this.listModels(sg), signal);
	}
}

// ---------------------------------------------------------------------------
// SemIf / System One API
// ---------------------------------------------------------------------------

export type Description = string | null | Record<string, unknown> | unknown[];

export type SemIfQuestion =
	| { type: "noul"; instructions: Description; criteria?: { true?: Description; false?: Description } }
	| { type: "choice"; instructions: Description; criteria: Record<string, Description> }
	| { type: "score"; instructions: Description; criteria: Description[] };

export type SemIfAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface SemIfResponse {
	model: string;
	answers: Record<string, SemIfAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
	semif?: unknown;
}

export class SemIfClient {
	private readonly settings: Settings;
	/** Model picked automatically (the server's only one) when none is configured. */
	private readonly auto: { model?: string } = {};

	constructor(settings: Settings) {
		this.settings = settings;
	}

	get configured(): boolean {
		return !!normalizeEndpoint(this.settings.semif.endpoint);
	}

	async evaluate(
		state: Description,
		questions: Record<string, SemIfQuestion>,
		signal?: AbortSignal,
	): Promise<{ response: SemIfResponse; trace: HttpTrace; request: unknown }> {
		const cfg = this.settings.semif;
		if (!this.configured) throw new ApiError("SemIf endpoint is not configured (/realmem settings)");
		const request = { state, model: await this.model(signal), questions };
		const { data, trace } = await postJson<SemIfResponse>(`${normalizeEndpoint(cfg.endpoint)}/v1/systemone`, resolveSecret(cfg.apiKey), request, {
			timeoutMs: cfg.timeoutMs,
			signal,
		});
		if (!data || typeof data.answers !== "object") throw new ApiError("SemIf response has no answers");
		for (const [name, q] of Object.entries(questions)) {
			const a = data.answers[name];
			if (!a || a.type !== q.type) throw new ApiError(`SemIf response is missing answer "${name}"`);
		}
		return { response: data, trace, request };
	}

	async health(signal?: AbortSignal): Promise<unknown> {
		return getJson(`${normalizeEndpoint(this.settings.semif.endpoint)}/v1/models`, resolveSecret(this.settings.semif.apiKey), 10_000, signal);
	}

	/** Model ids the SemIf server lists at /v1/models. */
	async listModels(signal?: AbortSignal): Promise<string[]> {
		if (!this.configured) throw new ApiError("SemIf endpoint is not configured (/realmem settings)");
		return parseModelIds(await this.health(signal));
	}

	/** The configured model, else the server's only one. */
	model(signal?: AbortSignal): Promise<string> {
		return resolveModel("SemIf", this.settings.semif.model, this.auto, (sg) => this.listModels(sg), signal);
	}
}
