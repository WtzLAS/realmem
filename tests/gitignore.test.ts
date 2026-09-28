import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSharedIgnored, describeIgnoreProblem } from "../src/gitignore.ts";

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "realmem-gitignore-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(join(root, f, ".."), { recursive: true });
		writeFileSync(join(root, f), text);
	}
	return root;
}

/** Apply a suggested fix the way /realmem fix-gitignore does, then re-check. */
function applyAndRecheck(root: string): ReturnType<typeof checkSharedIgnored> {
	const p = checkSharedIgnored(root);
	assert.ok(p?.fix, "a verified fix is suggested");
	const target = join(root, p.fix.file);
	let before = "";
	try {
		before = readFileSync(target, "utf8");
	} catch {
		// new file
	}
	writeFileSync(target, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${p.fix.lines.join("\n")}\n`);
	return checkSharedIgnored(root);
}

/** Files git would add from .pi (to check the fix keeps other .pi content ignored). */
function untracked(root: string): string[] {
	mkdirSync(join(root, ".pi", "realmem"), { recursive: true });
	writeFileSync(join(root, ".pi", "realmem", "a.md"), "x");
	writeFileSync(join(root, ".pi", "settings.json"), "{}");
	return execFileSync("git", ["ls-files", "--others", "--exclude-standard", ".pi"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).sort();
}

test("gitignore: not ignored → no warning", () => {
	const root = repo({ ".gitignore": "node_modules/\n.pi/tasks/\n" });
	try {
		assert.equal(checkSharedIgnored(root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gitignore: whole .pi ignored → re-include .pi, keep the rest of it ignored", () => {
	const root = repo({ ".gitignore": "node_modules/\n.pi/\n" });
	try {
		const p = checkSharedIgnored(root);
		assert.ok(p);
		assert.equal(p.source, ".gitignore");
		assert.equal(p.line, 2);
		assert.equal(p.pattern, ".pi/");
		assert.deepEqual(p.fix?.lines, ["!/.pi/", "/.pi/*", "!/.pi/realmem/", "!/.pi/realmem/**"], "a plain negation cannot work under an ignored directory");
		assert.ok(p.fix?.note);
		const text = describeIgnoreProblem(p);
		assert.match(text, /\.gitignore:2: `\.pi\/`/);
		assert.match(text, /append these lines to \.gitignore/);
		assert.match(text, /git check-ignore -v --no-index/);
		assert.equal(applyAndRecheck(root), undefined, "fixed");
		assert.deepEqual(untracked(root), [".pi/realmem/a.md"], "other .pi content stays ignored");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("gitignore: contents ignored (.pi/*, *.md) → short negation", () => {
	for (const rule of [".pi/*", "*.md", ".pi/**"]) {
		const root = repo({ ".gitignore": `${rule}\n` });
		try {
			const p = checkSharedIgnored(root);
			assert.ok(p, rule);
			assert.deepEqual(p.fix?.lines, ["!/.pi/realmem/", "!/.pi/realmem/**"], rule);
			assert.equal(applyAndRecheck(root), undefined, rule);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("gitignore: nested .pi/.gitignore is fixed where it is; info/exclude by the root .gitignore", () => {
	const nested = repo({ ".pi/.gitignore": "*\n" });
	try {
		const p = checkSharedIgnored(nested);
		assert.equal(p?.source, ".pi/.gitignore");
		assert.equal(p?.fix?.file, ".pi/.gitignore");
		assert.deepEqual(p?.fix?.lines, ["!/realmem/", "!/realmem/**"]);
		assert.equal(applyAndRecheck(nested), undefined);
	} finally {
		rmSync(nested, { recursive: true, force: true });
	}
	const excluded = repo({});
	try {
		writeFileSync(join(excluded, ".git", "info", "exclude"), ".pi/\n");
		const p = checkSharedIgnored(excluded);
		assert.equal(p?.source, ".git/info/exclude");
		assert.equal(p?.fix?.file, ".gitignore", "a committed .gitignore beats info/exclude");
		assert.equal(applyAndRecheck(excluded), undefined);
	} finally {
		rmSync(excluded, { recursive: true, force: true });
	}
});

test("gitignore: an existing negation that already re-includes the store is not a problem", () => {
	const root = repo({ ".gitignore": ".pi/*\n!.pi/realmem/\n" });
	try {
		assert.equal(checkSharedIgnored(root), undefined, "check-ignore -v reports the matching negation with exit 0");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
