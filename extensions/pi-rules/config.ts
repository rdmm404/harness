import { access } from "node:fs/promises";
import { createJiti } from "jiti";
import { isScriptMatcher, type Matcher, type PiRulesConfig, type Rule } from "./api.ts";

const CONFIG_KEYS = new Set(["rules"]);
const RULE_KEYS = new Set(["match", "name", "action", "reason"]);

export async function loadConfig(path: string): Promise<{ config: PiRulesConfig; error?: string }> {
	try {
		await access(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { rules: [] } };
		return { config: { rules: [] }, error: formatError(error) };
	}

	try {
		const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: true });
		const value = await jiti.import<unknown>(path, { default: true });
		return { config: validateConfig(value) };
	} catch (error) {
		return { config: { rules: [] }, error: formatError(error) };
	}
}

function validateConfig(value: unknown): PiRulesConfig {
	if (!isRecord(value)) throw new Error("config: expected a default-exported object");
	assertKnownKeys(value, CONFIG_KEYS, "config");
	if (!Array.isArray(value.rules)) throw new Error("config.rules: expected an array");
	return { rules: value.rules.map(validateRule) };
}

function validateRule(value: unknown, index: number): Rule {
	const path = `config.rules[${index}]`;
	if (!isRecord(value)) throw new Error(`${path}: expected an object`);
	assertKnownKeys(value, RULE_KEYS, path);
	if (value.action !== "deny" && value.action !== "ask") throw new Error(`${path}.action: expected \"deny\" or \"ask\"`);
	validateMatcher(value.match, `${path}.match`);
	validateOptionalText(value.name, `${path}.name`);
	if (value.action === "deny") validateRequiredText(value.reason, `${path}.reason`);
	else validateOptionalText(value.reason, `${path}.reason`);
	return value as unknown as Rule;
}

function validateMatcher(value: unknown, path: string): asserts value is Matcher {
	if (typeof value === "function") return;
	if (isScriptMatcher(value as Matcher)) return;
	throw new Error(`${path}: expected a command matcher function or script() matcher`);
}

function validateRequiredText(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path}: expected non-whitespace text`);
}

function validateOptionalText(value: unknown, path: string): void {
	if (value === undefined) return;
	validateRequiredText(value, path);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown property`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
