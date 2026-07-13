import type { Script as UnbashScript } from "unbash";

export type AnalysisCertainty = "static" | "dynamic" | "partial";
export type BashAst = UnbashScript;

export interface SourceRange {
	start: number;
	end: number;
}

export interface ParsedArgument {
	source: string;
	value?: string;
	dynamic: boolean;
	range: SourceRange;
}

export interface ParsedAssignment {
	source: string;
	name?: string;
	value?: ParsedArgument;
	dynamic: boolean;
	range: SourceRange;
}

export interface ParsedRedirection {
	source: string;
	operator: string;
	fileDescriptor?: number;
	target?: ParsedArgument;
	range: SourceRange;
}

export interface ParsedWrapper {
	executable: string;
	args: ParsedArgument[];
	source: string;
}

export interface EffectiveCommand {
	executable?: string;
	args: ParsedArgument[];
	text: string;
}

export interface CommandAncestry {
	type: string;
	range: SourceRange;
}

export interface ParsedCommand {
	/** Exact source represented by this command node. */
	source: string;
	range: SourceRange;
	depth: number;
	ancestry: CommandAncestry[];
	literalExecutable?: string;
	literalArgs: ParsedArgument[];
	literal: string;
	assignments: ParsedAssignment[];
	redirections: ParsedRedirection[];
	wrappers: ParsedWrapper[];
	effective: EffectiveCommand;
	certainty: AnalysisCertainty;
}

export interface ParseDiagnostic {
	message: string;
	position: number;
}

export interface ParsedScript {
	raw: string;
	/** Parser AST. Treat as read-only. */
	ast: BashAst;
	commands: ParsedCommand[];
	certainty: AnalysisCertainty;
	diagnostics: ParseDiagnostic[];
	truncated: boolean;
}

export type CommandMatcher = (command: ParsedCommand) => boolean;

export interface ScriptMatcher {
	readonly scope: "script";
	readonly test: (script: ParsedScript) => boolean;
}

export type Matcher = CommandMatcher | ScriptMatcher;

interface RuleCommon {
	match: Matcher;
	name?: string;
}

export type Rule = RuleCommon &
	(
		| { action: "deny"; reason: string }
		| { action: "ask"; reason?: string }
	);

export interface PiRulesConfig {
	rules: readonly Rule[];
}

export function defineConfig<const T extends PiRulesConfig>(config: T): T {
	return config;
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "\\") {
			const next = pattern[i + 1];
			if (next === "*" || next === "?" || next === "\\") source += escapeRegex(pattern[++i]!);
			else source += "\\\\";
		} else if (char === "*") source += "[\\s\\S]*";
		else if (char === "?") source += "[\\s\\S]";
		else source += escapeRegex(char);
	}
	return new RegExp(`${source}$`);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function command(pattern: string): CommandMatcher {
	const regex = globRegex(pattern);
	return (candidate) => regex.test(candidate.effective.text);
}

export function literal(pattern: string): CommandMatcher {
	const regex = globRegex(pattern);
	return (candidate) => regex.test(candidate.literal);
}

export function wrapper(name: string): CommandMatcher {
	return (candidate) => candidate.wrappers.some((item) => item.executable === name);
}

export function anyOf(...matchers: readonly CommandMatcher[]): CommandMatcher {
	return (candidate) => matchers.some((matcher) => matcher(candidate));
}

export function allOf(...matchers: readonly CommandMatcher[]): CommandMatcher {
	return (candidate) => matchers.every((matcher) => matcher(candidate));
}

export function not(matcher: CommandMatcher): CommandMatcher {
	return (candidate) => !matcher(candidate);
}

export function script(test: (script: ParsedScript) => boolean): ScriptMatcher {
	return Object.freeze({ scope: "script" as const, test });
}

export function isScriptMatcher(matcher: Matcher): matcher is ScriptMatcher {
	return typeof matcher === "object" && matcher !== null && matcher.scope === "script" && typeof matcher.test === "function";
}
