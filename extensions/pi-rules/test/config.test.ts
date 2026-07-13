import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.ts";

test("a missing config silently produces zero rules", async () => {
	const loaded = await loadConfig(join(tmpdir(), `missing-pi-rules-${Date.now()}.ts`));
	assert.deepEqual(loaded, { config: { rules: [] } });
});

test("loads a TypeScript default export", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rules-config-"));
	const path = join(dir, "config.ts");
	try {
		await writeFile(path, `export default { rules: [{ match: () => true, action: "deny", reason: "No." }] };`);
		const loaded = await loadConfig(path);
		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.rules.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("rejects unknown properties and whitespace reasons", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rules-config-"));
	try {
		const unknown = join(dir, "unknown.ts");
		await writeFile(unknown, `export default { rules: [], typo: true };`);
		assert.match((await loadConfig(unknown)).error ?? "", /config\.typo: unknown property/);
		const blank = join(dir, "blank.ts");
		await writeFile(blank, `export default { rules: [{ match: () => true, action: "deny", reason: "  " }] };`);
		assert.match((await loadConfig(blank)).error ?? "", /reason: expected non-whitespace text/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
