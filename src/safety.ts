/**
 * Secret and prompt-injection scanning.
 *
 * Memories are replayed into future prompts (and project-shared ones are pushed
 * to every collaborator through git), so anything stored must be free of
 * credentials and must not carry instructions that try to hijack an agent.
 */

export interface SecretFinding {
	kind: string;
	index: number;
	length: number;
	preview: string;
}

export interface InjectionFinding {
	kind: string;
	match: string;
}

interface SecretRule {
	kind: string;
	re: RegExp;
	/** Capture group holding the secret (default: whole match). */
	group?: number;
	/** Extra check to reduce false positives. */
	check?: (value: string) => boolean;
}

function shannonEntropy(s: string): number {
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of freq.values()) {
		const p = n / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{?[A-Z_][A-Z0-9_]*\}?|your[-_ ]?\w*|changeme|example\w*|placeholder|redacted|dummy|test|secret|password|todo|none|null|undefined|true|false)$/i;

function looksSecret(value: string): boolean {
	const v = value.replace(/^['"]|['"]$/g, "");
	if (v.length < 8) return false;
	if (PLACEHOLDER.test(v)) return false;
	if (/^\$\(|^\$\{|^%[A-Z_]+%$|^process\.env|^os\.environ|^env\(/i.test(v)) return false;
	if (/^[a-z]+(?:[-_][a-z]+)*$/.test(v)) return false; // plain words / identifiers
	if (/^(?:https?:\/\/|\/|\.\/|~\/)/.test(v) && !/[:@].*@/.test(v)) return false; // paths / urls without credentials
	return shannonEntropy(v) >= 3.0;
}

const SECRET_RULES: SecretRule[] = [
	{ kind: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g },
	{ kind: "AWS access key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
	{ kind: "AWS secret key", re: /aws.{0,20}?(?:secret|private).{0,20}?['"=:\s]([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
	{ kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
	{ kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
	{ kind: "Discord webhook", re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g },
	{ kind: "OpenAI key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "Google OAuth token", re: /\bya29\.[0-9A-Za-z_-]{20,}\b/g },
	{ kind: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
	{ kind: "Twilio key", re: /\bSK[0-9a-fA-F]{32}\b/g },
	{ kind: "SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
	{ kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ kind: "PyPI token", re: /\bpypi-AgE[A-Za-z0-9_-]{50,}\b/g },
	{ kind: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
	{ kind: "DigitalOcean token", re: /\bdo[pro]_v1_[a-f0-9]{64}\b/g },
	{ kind: "Shopify token", re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
	{ kind: "Azure storage key", re: /AccountKey=([A-Za-z0-9+/=]{60,})/g, group: 1 },
	{ kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{
		kind: "credential in URL",
		re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s/@'"]{3,})@[^\s'"]+/gi,
		group: 1,
		check: (v) => !PLACEHOLDER.test(v) && !/^\$\{?[A-Z_]/.test(v),
	},
	{
		kind: "authorization header",
		re: /\bauthorization\s*[:=]\s*['"]?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
		group: 1,
		check: looksSecret,
	},
	{
		kind: "bearer token",
		re: /\bbearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gi,
		group: 1,
		check: looksSecret,
	},
	{
		kind: "secret assignment",
		re: /\b[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|passwd|password|pwd|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)[A-Za-z0-9_.-]*['"]?\s*(?:[:=]|=>|:=)\s*(['"]?)([^\s'"`,;]{8,})\1/gi,
		group: 2,
		check: looksSecret,
	},
	{
		kind: "CLI secret flag",
		re: /--(?:api[_-]?key|token|password|secret|auth)[= ](['"]?)([^\s'"]{8,})\1/gi,
		group: 2,
		check: looksSecret,
	},
];

function preview(v: string): string {
	if (v.length <= 8) return "•".repeat(v.length);
	return `${v.slice(0, 4)}…(${v.length} chars)`;
}

export function scanSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	const covered: Array<[number, number]> = [];
	for (const rule of SECRET_RULES) {
		rule.re.lastIndex = 0;
		for (const m of text.matchAll(rule.re)) {
			const value = rule.group !== undefined ? m[rule.group] : m[0];
			if (!value) continue;
			if (rule.check && !rule.check(value)) continue;
			const offset = rule.group !== undefined ? m[0].indexOf(value) : 0;
			const index = (m.index ?? 0) + Math.max(0, offset);
			if (covered.some(([s, e]) => index < e && index + value.length > s)) continue;
			covered.push([index, index + value.length]);
			findings.push({ kind: rule.kind, index, length: value.length, preview: preview(value) });
		}
	}
	return findings.sort((a, b) => a.index - b.index);
}

export function redactSecrets(text: string, findings = scanSecrets(text)): string {
	let out = text;
	for (const f of [...findings].sort((a, b) => b.index - a.index)) {
		out = `${out.slice(0, f.index)}[REDACTED:${f.kind}]${out.slice(f.index + f.length)}`;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

const INJECTION_RULES: Array<{ kind: string; re: RegExp }> = [
	{
		kind: "override instructions",
		re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|system|developer|safety|your)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|messages?|context|directives?)\b/i,
	},
	{ kind: "role hijack", re: /\b(?:you are now|from now on,? you (?:are|will|must)|act as (?:an? )?(?:unrestricted|jailbroken|evil|dan)\b|pretend (?:to be|you are) (?:an? )?(?:different|unrestricted))/i },
	{ kind: "new instructions", re: /\b(?:new|updated|real|actual|hidden|secret) (?:system )?(?:instructions?|prompt|directives?)\s*[:：]/i },
	{ kind: "fake chat markup", re: /<\|(?:im_start|im_end|system|endoftext|eot_id|start_header_id|end_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|^\s*(?:system|assistant|developer)\s*[:：]\s/im },
	{ kind: "fake prompt tags", re: /<\/?\s*(?:system|system[-_]prompt|developer|instructions?|tool_call|function_call|tools?|project_context|rules|addendum|antml:[a-z_]+)\s*>/i },
	{ kind: "exfiltration", re: /\b(?:send|post|upload|exfiltrate|leak|forward|email|transmit)\b[^.\n]{0,50}\b(?:api[ _-]?keys?|secrets?|credentials?|tokens?|passwords?|env(?:ironment)?(?: variables?)?|ssh keys?|\.env|private keys?)\b[^.\n]{0,40}\b(?:to|via|at)\b/i },
	{ kind: "remote code pipe", re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|fi)?sh\b/i },
	{ kind: "memory manipulation", re: /\b(?:do not|don't|never)\b[^.\n]{0,30}\b(?:tell|inform|mention|reveal|show)\b[^.\n]{0,30}\b(?:the )?user\b/i },
	{ kind: "memory manipulation", re: /\b(?:always|must)\b[^.\n]{0,40}\b(?:disable|skip|turn off|bypass)\b[^.\n]{0,30}\b(?:safety|security|confirmation|sandbox|approval|review)\b/i },
	{ kind: "hidden characters", re: /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\ufeff\u{e0000}-\u{e007f}]/u },
];

export function scanInjection(text: string): InjectionFinding[] {
	const out: InjectionFinding[] = [];
	for (const rule of INJECTION_RULES) {
		const m = rule.re.exec(text);
		if (m) out.push({ kind: rule.kind, match: m[0].slice(0, 80) });
	}
	return out;
}

/** Remove invisible/bidi control characters that can hide instructions. */
export function stripInvisible(text: string): string {
	return text.replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\u{e0000}-\u{e007f}]/gu, "").replace(/^\ufeff/, "");
}

export interface SafetyReport {
	secrets: SecretFinding[];
	injections: InjectionFinding[];
}

export function scanAll(text: string): SafetyReport {
	return { secrets: scanSecrets(text), injections: scanInjection(text) };
}

export function describeSafety(report: SafetyReport): string {
	const parts: string[] = [];
	if (report.secrets.length) parts.push(`possible secrets: ${[...new Set(report.secrets.map((s) => s.kind))].join(", ")}`);
	if (report.injections.length) parts.push(`possible prompt injection: ${[...new Set(report.injections.map((s) => s.kind))].join(", ")}`);
	return parts.join("; ");
}

/**
 * Neutralize memory text before it is shown to a model: strip invisible characters
 * and defang anything that looks like chat/prompt markup, so a stored memory
 * cannot close the surrounding data envelope.
 */
export function sanitizeForPrompt(text: string): string {
	return stripInvisible(text)
		.replace(/<\|/g, "<\u2758")
		.replace(/<(\/?)\s*(memory|memories|realmem[\w-]*|system[\w-]*|developer|instructions?|tool_call|function_call|project_context|rules|addendum|antml:[a-z_]+)\b/gi, "‹$1$2");
}
