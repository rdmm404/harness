import { parse, type Command, type Node, type Redirect, type Script, type Word, type WordPart } from "unbash";
import type {
	AnalysisCertainty,
	CommandAncestry,
	ParsedArgument,
	ParsedAssignment,
	ParsedCommand,
	ParsedRedirection,
	ParsedScript,
	ParsedWrapper,
} from "./api.ts";

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_EMBEDDED_DEPTH = 16;

const DYNAMIC_PARTS = new Set([
	"SimpleExpansion",
	"ParameterExpansion",
	"CommandExpansion",
	"ArithmeticExpansion",
	"ProcessSubstitution",
	"BraceExpansion",
]);

export function parseBash(source: string): ParsedScript {
	const bytes = Buffer.byteLength(source, "utf8");
	const truncated = bytes > MAX_INPUT_BYTES;
	const input = truncated ? truncateUtf8(source, MAX_INPUT_BYTES) : source;
	const ast = parse(input);
	const diagnostics = (ast.errors ?? []).map((error) => ({ message: error.message, position: error.pos }));
	const commands: ParsedCommand[] = [];
	const seen = new Set<string>();

	walkAst(ast, input, commands, seen, [], 0, 0);
	commands.sort((left, right) => left.range.start - right.range.start || right.range.end - left.range.end);

	const certainty: AnalysisCertainty = truncated || diagnostics.length > 0 || commands.some((item) => item.certainty === "partial")
		? "partial"
		: commands.some((item) => item.certainty === "dynamic") ? "dynamic" : "static";

	return { raw: source, ast, commands, certainty, diagnostics, truncated };
}

function truncateUtf8(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	let end = Math.min(maxBytes, buffer.length);
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function walkAst(
	root: unknown,
	source: string,
	commands: ParsedCommand[],
	seen: Set<string>,
	ancestry: CommandAncestry[],
	depth: number,
	baseOffset: number,
): void {
	const visited = new WeakSet<object>();
	const stack: Array<{ value: unknown; ancestry: CommandAncestry[]; depth: number }> = [{ value: root, ancestry, depth }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (!current.value || typeof current.value !== "object") continue;
		const object = current.value as Record<string, unknown>;
		if (visited.has(object)) continue;
		visited.add(object);

		const type = typeof object.type === "string" ? object.type : undefined;
		const pos = typeof object.pos === "number" ? object.pos : undefined;
		const end = typeof object.end === "number" ? object.end : undefined;
		let nextAncestry = current.ancestry;
		if (type && type !== "Script" && type !== "Command") {
			if (pos !== undefined && end !== undefined) {
				nextAncestry = [...current.ancestry, { type, range: { start: baseOffset + pos, end: baseOffset + end } }];
			} else if (type === "CommandExpansion" || type === "ProcessSubstitution") {
				const nestedScript = object.script as { pos?: unknown; end?: unknown } | undefined;
				if (typeof nestedScript?.pos === "number" && typeof nestedScript.end === "number") {
					const text = typeof object.text === "string" ? object.text : "";
					const openerLength = text.startsWith("`") ? 1 : 2;
					nextAncestry = [...current.ancestry, {
						type,
						range: { start: baseOffset + Math.max(0, nestedScript.pos - openerLength), end: baseOffset + nestedScript.end + 1 },
					}];
				}
			}
		}

		if (type === "Command") {
			const key = `${baseOffset + (pos ?? 0)}:${baseOffset + (end ?? 0)}`;
			if (!seen.has(key)) {
				seen.add(key);
				const parsed = convertCommand(object as unknown as Command, source, baseOffset, current.ancestry, current.depth);
				commands.push(parsed);
				parseEmbeddedEvaluator(parsed, source, commands, seen, current.depth + 1);
			}
		}

		const children = Object.entries(object);
		// unbash computes Word.parts lazily through a Proxy, so it does not appear in
		// Object.entries until explicitly requested.
		if (!type && "text" in object) {
			const parts = (object as unknown as Word).parts;
			if (parts) children.push(["parts", parts]);
		}
		for (const [key, child] of children) {
			if (["pos", "end", "type", "errors", "inner", "innerStart"].includes(key)) continue;
			if (Array.isArray(child)) {
				for (let i = child.length - 1; i >= 0; i--) stack.push({ value: child[i], ancestry: nextAncestry, depth: current.depth });
			} else if (child && typeof child === "object") {
				stack.push({ value: child, ancestry: nextAncestry, depth: current.depth });
			}
		}
	}
}

function convertCommand(node: Command, source: string, base: number, ancestry: CommandAncestry[], _depth: number): ParsedCommand {
	const literalArgs = node.suffix.map((word) => convertWord(word, source, base));
	const assignments = node.prefix.map((assignment): ParsedAssignment => ({
		source: assignment.text,
		name: assignment.name,
		value: assignment.value ? convertWord(assignment.value, source, base) : undefined,
		dynamic: assignment.value ? isDynamicWord(assignment.value) : Boolean(assignment.array?.some(isDynamicWord)),
		range: { start: base + assignment.pos, end: base + assignment.end },
	}));
	const redirections = node.redirects.map((redirect) => convertRedirect(redirect, source, base));
	const executable = node.name && !isDynamicWord(node.name) ? node.name.value : node.name?.text;
	const dynamicExecutable = Boolean(node.name && isDynamicWord(node.name));
	const unwrapped = unwrap(executable, literalArgs);
	const literalTokens = [...assignments.map((item) => item.source), ...(executable ? [normalizeToken(executable, dynamicExecutable ? node.name?.text : undefined)] : []), ...literalArgs.map(normalizeArgument)];
	const effectiveTokens = unwrapped.executable ? [normalizeToken(unwrapped.executable), ...unwrapped.args.map(normalizeArgument)] : [];
	const sourceStart = Math.max(0, node.pos);
	const sourceEnd = Math.min(source.length, node.end);
	const dynamic = dynamicExecutable || literalArgs.some((arg) => arg.dynamic) || assignments.some((item) => item.dynamic);
	const incomplete = Boolean(node.name && isIncompleteWord(node.name))
		|| node.suffix.some(isIncompleteWord)
		|| node.prefix.some((item) => Boolean(item.value && isIncompleteWord(item.value)))
		|| node.redirects.some((item) => Boolean(item.target && isIncompleteWord(item.target)));

	const structuralContainers = ancestry.filter((item) => !["Statement", "Pipeline", "AndOr", "CompoundList"].includes(item.type));

	return {
		source: source.slice(sourceStart, sourceEnd),
		range: { start: base + node.pos, end: base + node.end },
		depth: structuralContainers.length,
		ancestry,
		literalExecutable: executable,
		literalArgs,
		literal: literalTokens.join(" "),
		assignments,
		redirections,
		wrappers: unwrapped.wrappers,
		effective: { executable: unwrapped.executable, args: unwrapped.args, text: effectiveTokens.join(" ") },
		certainty: unwrapped.partial || incomplete ? "partial" : dynamic ? "dynamic" : "static",
	};
}

function convertWord(word: Word, source: string, base: number): ParsedArgument {
	const dynamic = isDynamicWord(word);
	return {
		source: source.slice(word.pos, word.end) || word.text,
		value: dynamic ? undefined : word.value,
		dynamic,
		range: { start: base + word.pos, end: base + word.end },
	};
}

function convertRedirect(redirect: Redirect, source: string, base: number): ParsedRedirection {
	return {
		source: source.slice(redirect.pos, redirect.end),
		operator: redirect.operator,
		fileDescriptor: redirect.fileDescriptor,
		target: redirect.target ? convertWord(redirect.target, source, base) : undefined,
		range: { start: base + redirect.pos, end: base + redirect.end },
	};
}

function isDynamicWord(word: Word): boolean {
	return (word.parts ?? []).some(isDynamicPart);
}

function isIncompleteWord(word: Word): boolean {
	return (word.parts ?? []).some(isIncompletePart);
}

function isIncompletePart(part: WordPart | Record<string, unknown>): boolean {
	const type = typeof part.type === "string" ? part.type : "";
	const text = typeof part.text === "string" ? part.text : "";
	if (type === "SingleQuoted") return !text.endsWith("'");
	if (type === "DoubleQuoted" || type === "LocaleString") {
		if (!text.endsWith('"')) return true;
		return ((part as { parts?: Array<WordPart | Record<string, unknown>> }).parts ?? []).some(isIncompletePart);
	}
	if (type === "AnsiCQuoted") return !text.endsWith("'");
	if (type === "CommandExpansion") return text.startsWith("`") ? !text.endsWith("`") : !text.endsWith(")");
	if (type === "ProcessSubstitution" || type === "ExtendedGlob") return !text.endsWith(")");
	if (type === "ArithmeticExpansion") return !text.endsWith("))");
	if (type === "ParameterExpansion") return text.startsWith("${") && !text.endsWith("}");
	return false;
}

function isDynamicPart(part: WordPart | Record<string, unknown>): boolean {
	const type = typeof part.type === "string" ? part.type : "";
	if (DYNAMIC_PARTS.has(type)) return true;
	if (type === "DoubleQuoted" || type === "LocaleString") {
		return ((part as { parts?: Array<WordPart | Record<string, unknown>> }).parts ?? []).some(isDynamicPart);
	}
	return false;
}

function normalizeArgument(argument: ParsedArgument): string {
	return argument.dynamic ? argument.source : normalizeToken(argument.value ?? "");
}

function normalizeToken(value: string, dynamicSource?: string): string {
	if (dynamicSource) return dynamicSource;
	if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

interface Unwrapped {
	executable?: string;
	args: ParsedArgument[];
	wrappers: ParsedWrapper[];
	partial: boolean;
}

function unwrap(initialExecutable: string | undefined, initialArgs: ParsedArgument[]): Unwrapped {
	let executable = initialExecutable;
	let args = [...initialArgs];
	const wrappers: ParsedWrapper[] = [];
	let partial = false;
	for (let guard = 0; executable && guard < 16; guard++) {
		const consumed = consumeWrapper(executable, args);
		if (!consumed) break;
		if (consumed.partial || !consumed.executable) {
			partial = true;
			break;
		}
		wrappers.push({ executable, args: args.slice(0, consumed.consumed), source: [executable, ...args.slice(0, consumed.consumed).map(normalizeArgument)].join(" ") });
		executable = consumed.executable;
		args = consumed.args;
	}
	return { executable, args, wrappers, partial };
}

function staticValue(arg: ParsedArgument | undefined): string | undefined {
	return arg && !arg.dynamic ? arg.value : undefined;
}

function consumeWrapper(executable: string, args: ParsedArgument[]): { executable?: string; args: ParsedArgument[]; consumed: number; partial?: boolean } | undefined {
	if (!["command", "exec", "env", "sudo", "doas", "nice", "nohup", "timeout"].includes(executable)) return undefined;
	let i = 0;
	const need = (count = 1) => {
		if (i + count > args.length) return false;
		i += count;
		return true;
	};
	while (i < args.length) {
		const value = staticValue(args[i]);
		if (value === undefined) return { args, consumed: i, partial: true };
		if (value === "--") { i++; break; }
		if (executable === "env") {
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { i++; continue; }
			if (["-u", "--unset", "-C", "--chdir"].includes(value)) { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (value.startsWith("--unset=") || value.startsWith("--chdir=")) { i++; continue; }
			if (value === "-S" || value === "--split-string" || value.startsWith("--split-string=")) return { args, consumed: i, partial: true };
			if (value.startsWith("-")) { i++; continue; }
		} else if (executable === "sudo") {
			if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-T", "--command-timeout"].includes(value)) { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (/^--(?:user|group|host|prompt|close-from|chroot|command-timeout)=/.test(value)) { i++; continue; }
			if (value.startsWith("-")) { i++; continue; }
		} else if (executable === "doas") {
			if (value === "-u") { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (value.startsWith("-")) { i++; continue; }
		} else if (executable === "nice") {
			if (value === "-n" || value === "--adjustment") { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (/^(?:-n|--adjustment=)-?\d+$/.test(value) || /^-\d+$/.test(value)) { i++; continue; }
			if (value.startsWith("-") && value !== "--") { i++; continue; }
		} else if (executable === "nohup") {
			if (value.startsWith("-") && value !== "--") { i++; continue; }
		} else if (executable === "timeout") {
			if (["-k", "--kill-after", "-s", "--signal"].includes(value)) { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (value.startsWith("--kill-after=") || value.startsWith("--signal=") || ["--foreground", "--preserve-status", "--verbose"].includes(value)) { i++; continue; }
			if (value.startsWith("-")) { i++; continue; }
			// duration
			i++;
			break;
		} else if (executable === "command") {
			// `command -v/-V` inspects a name rather than executing it.
			if (value === "-v" || value === "-V" || /^-[^-]*[vV]/.test(value)) return undefined;
			if (value.startsWith("-") && value !== "--") { i++; continue; }
		} else if (executable === "exec") {
			if (value === "-a") { if (!need(2)) return { args, consumed: i, partial: true }; continue; }
			if (value.startsWith("--argv0=")) { i++; continue; }
			if (value.startsWith("-") && value !== "--") { i++; continue; }
		}
		break;
	}
	const next = args[i];
	const nextValue = staticValue(next);
	if (!next || nextValue === undefined) return { args, consumed: i, partial: true };
	return { executable: nextValue, args: args.slice(i + 1), consumed: i + 1 };
}

function parseEmbeddedEvaluator(command: ParsedCommand, _source: string, commands: ParsedCommand[], seen: Set<string>, depth: number): void {
	if (depth > MAX_EMBEDDED_DEPTH) {
		command.certainty = "partial";
		return;
	}
	const executable = command.effective.executable;
	if (!executable || !["bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"].includes(executable)) return;
	const args = command.effective.args;
	let scriptIndex = -1;
	for (let i = 0; i < args.length; i++) {
		const value = staticValue(args[i]);
		if (value === "-c" || value === "--command") { scriptIndex = i + 1; break; }
		if (value?.startsWith("-") && value.includes("c") && !value.startsWith("--")) { scriptIndex = i + 1; break; }
	}
	if (scriptIndex < 0 || scriptIndex >= args.length) return;
	const scriptArg = args[scriptIndex]!;
	if (scriptArg.dynamic || scriptArg.value === undefined) {
		command.certainty = "partial";
		return;
	}
	const nested = parse(scriptArg.value);
	const nestedAncestry: CommandAncestry[] = [...command.ancestry, { type: "ShellEvaluator", range: command.range }];
	// Nested decoded text cannot always map exactly through shell escapes. Anchor it to the argument start.
	walkAst(nested, scriptArg.value, commands, seen, nestedAncestry, depth, scriptArg.range.start);
	if ((nested.errors ?? []).length > 0) command.certainty = "partial";
}
