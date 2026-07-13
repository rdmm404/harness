import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isScriptMatcher, type ParsedCommand, type PiRulesConfig, type Rule } from "./api.ts";
import { loadConfig } from "./config.ts";
import { parseBash } from "./parser.ts";

const CONFIG_FILE = "pi-rules.config.ts";
const COMMAND_EXCERPT = 300;
const SCRIPT_EXCERPT = 1_200;
const MAX_PROMPT_MATCHES = 10;
const MAX_PROMPT_CHARS = 3_000;
const MAX_BLOCK_CHARS = 8_000;

interface MatchRecord {
	rule: Rule;
	command?: ParsedCommand;
	script: boolean;
}

export default async function piRules(pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE);
	const loaded = await loadConfig(configPath);
	const config = loaded.config;
	let warningShown = false;

	pi.on("session_start", (_event, ctx) => {
		if (!loaded.error || warningShown) return;
		warningShown = true;
		const message = `Pi Rules disabled: ${loaded.error}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else process.stderr.write(`${message}\n`);
	});

	pi.registerCommand("pi-rules:init", {
		description: "Create an empty global Pi Rules configuration",
		handler: async (_args, ctx) => {
			const starter = `import { command, defineConfig } from "./extensions/pi-rules/api";\n\nexport default defineConfig({\n\trules: [\n\t\t// {\n\t\t// \tmatch: command("fd * /"),\n\t\t// \taction: "deny",\n\t\t// \treason: "Search a narrower path instead.",\n\t\t// },\n\t],\n});\n`;
			try {
				await writeFile(configPath, starter, { encoding: "utf8", flag: "wx" });
				ctx.ui.notify(`Created ${configPath}. Edit it, then run /reload.`, "info");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					ctx.ui.notify(`Pi Rules config already exists: ${configPath}`, "warning");
					return;
				}
				ctx.ui.notify(`Could not create ${configPath}: ${formatError(error)}`, "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event) || config.rules.length === 0 || loaded.error) return;
		const source = event.input.command;
		let parsed;
		try {
			parsed = parseBash(source);
		} catch (error) {
			return { block: true, reason: `Pi Rules could not analyze this Bash call: ${formatError(error)}` };
		}

		let matches: MatchRecord[];
		try {
			matches = evaluate(config, parsed);
		} catch (error) {
			return { block: true, reason: `Pi Rules matcher failed: ${formatError(error)}` };
		}

		const denied = matches.filter((match) => match.rule.action === "deny");
		if (denied.length > 0) return { block: true, reason: formatDenials(denied, source) };

		const asked = matches.filter((match) => match.rule.action === "ask");
		if (asked.length === 0) return;
		if (!ctx.hasUI) return { block: true, reason: "Pi Rules requires confirmation for this Bash call, but no interactive UI is available." };

		const approved = await ctx.ui.confirm("Pi Rules: allow Bash command?", formatPrompt(asked, source));
		if (!approved) return { block: true, reason: "Bash call blocked by Pi Rules confirmation." };
	});
}

function evaluate(config: PiRulesConfig, parsed: ReturnType<typeof parseBash>): MatchRecord[] {
	const matches: MatchRecord[] = [];
	for (const [ruleIndex, rule] of config.rules.entries()) {
		if (isScriptMatcher(rule.match)) {
			const result = rule.match.test(parsed);
			assertMatcherResult(result, ruleIndex);
			if (result) matches.push({ rule, script: true });
			continue;
		}
		for (const command of parsed.commands) {
			const result = rule.match(command);
			assertMatcherResult(result, ruleIndex);
			if (result) matches.push({ rule, command, script: false });
		}
	}
	return deduplicate(matches);
}

function assertMatcherResult(result: unknown, ruleIndex: number): asserts result is boolean {
	if (typeof result !== "boolean") throw new Error(`config.rules[${ruleIndex}].match returned ${typeof result}; expected boolean`);
}

function deduplicate(matches: MatchRecord[]): MatchRecord[] {
	const seen = new Map<Rule, Set<string>>();
	return matches.filter((match) => {
		const target = match.command ? `${match.command.range.start}:${match.command.range.end}` : "script";
		const targets = seen.get(match.rule) ?? new Set<string>();
		if (targets.has(target)) return false;
		targets.add(target);
		seen.set(match.rule, targets);
		return true;
	});
}

function formatPrompt(matches: MatchRecord[], source: string): string {
	const grouped = groupMatches(matches, source);
	const visible = grouped.slice(0, MAX_PROMPT_MATCHES);
	const lines = ["The following rule matches require confirmation:"];
	for (const group of visible) {
		lines.push("", `• ${group.excerpt}`);
		for (const reason of group.reasons) lines.push(`  - ${reason}`);
	}
	if (grouped.length > visible.length) lines.push("", `… ${grouped.length - visible.length} additional matched command(s) omitted.`);
	lines.push("", "Approval applies to the complete, unmodified Bash tool call.");
	return truncateCharacters(lines.join("\n"), MAX_PROMPT_CHARS);
}

function formatDenials(matches: MatchRecord[], source: string): string {
	const byReason = new Map<string, MatchRecord[]>();
	for (const match of matches) {
		const reason = match.rule.action === "deny" ? match.rule.reason : "Blocked";
		const bucket = byReason.get(reason) ?? [];
		bucket.push(match);
		byReason.set(reason, bucket);
	}
	const entries = [...byReason.entries()];
	const lines = ["Bash call denied by Pi Rules:"];
	let omittedMatches = 0;
	let omittedReasons = 0;
	for (let index = 0; index < entries.length; index++) {
		const [reason, records] = entries[index]!;
		const section = ["", `• ${truncateCharacters(reason, 1_000)}`];
		for (const record of records.slice(0, 10)) section.push(`  - ${excerptFor(record, source)}`);
		if ([...[...lines, ...section].join("\n")].length > MAX_BLOCK_CHARS - 160) {
			omittedReasons = entries.length - index;
			omittedMatches += entries.slice(index).reduce((total, [, remaining]) => total + remaining.length, 0);
			break;
		}
		lines.push(...section);
		omittedMatches += Math.max(0, records.length - 10);
	}
	if (omittedMatches > 0 || omittedReasons > 0) {
		const reasonNotice = omittedReasons > 0 ? ` and ${omittedReasons} reason(s)` : "";
		lines.push("", `… ${omittedMatches} additional match(es)${reasonNotice} omitted.`);
	}
	return truncateCharacters(lines.join("\n"), MAX_BLOCK_CHARS);
}

function groupMatches(matches: MatchRecord[], source: string): Array<{ excerpt: string; reasons: string[] }> {
	const groups = new Map<string, { excerpt: string; reasons: Set<string> }>();
	for (const match of matches) {
		const key = match.command ? `${match.command.range.start}:${match.command.range.end}` : "script";
		const group = groups.get(key) ?? { excerpt: excerptFor(match, source), reasons: new Set<string>() };
		if (match.rule.action === "ask" && match.rule.reason) group.reasons.add(match.rule.reason);
		else if (match.rule.name) group.reasons.add(match.rule.name);
		groups.set(key, group);
	}
	return [...groups.values()].map((group) => ({ excerpt: group.excerpt, reasons: [...group.reasons] }));
}

function excerptFor(match: MatchRecord, source: string): string {
	return truncateCharacters(match.command?.source ?? source, match.script ? SCRIPT_EXCERPT : COMMAND_EXCERPT);
}

function truncateCharacters(value: string, limit: number): string {
	const characters = [...value];
	if (characters.length <= limit) return value;
	return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
