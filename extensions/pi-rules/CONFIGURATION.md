# Configuring Pi Rules

Pi Rules applies synchronous policies to **agent-issued `bash` tool calls**. It does not affect commands entered with Pi's `!` or `!!` shortcuts and is not a security sandbox.

## Setup

Create the global config from Pi:

```text
/pi-rules:init
```

This exclusively creates `~/.pi/agent/pi-rules.config.ts`; it never overwrites an existing file. Edit that file and run Pi's built-in `/reload` command. Config changes are not watched automatically.

```ts
import {
  allOf,
  anyOf,
  command,
  defineConfig,
  literal,
  not,
  script,
  wrapper,
} from "./extensions/pi-rules/api";

export default defineConfig({
  rules: [
    {
      name: "avoid-root-searches",
      match: command("fd * /"),
      action: "deny",
      reason: "Search a narrower directory instead.",
    },
    {
      match: wrapper("sudo"),
      action: "ask",
      reason: "This requests elevated privileges.",
    },
  ],
});
```

The config must synchronously default-export one object. Top-level factories, array shorthand, async matchers, unknown properties, and blank names/reasons are invalid. A broken config disables Pi Rules and produces one warning; it does not disable Bash itself.

## Rule types

```ts
type CommandMatcher = (command: ParsedCommand) => boolean;

type Rule = {
  match: CommandMatcher | ScriptMatcher;
  name?: string;
} & (
  | { action: "deny"; reason: string }
  | { action: "ask"; reason?: string }
);

interface PiRulesConfig {
  rules: readonly Rule[];
}

function defineConfig<const T extends PiRulesConfig>(config: T): T;
```

All matching rules are evaluated. Any `deny` takes precedence over every `ask` and blocks the complete Bash tool call. Otherwise, all ask matches are combined into one confirmation. Approval lasts for that one call. An ask blocks when no interactive UI is available. A matcher exception blocks only the call being evaluated.

## Built-in matchers

### `command(pattern: string): CommandMatcher`

Use for the usual case: matching the underlying command after known wrappers are removed.

```ts
match: command("fd * /")
```

This matches normalized effective commands such as `fd . /`, `sudo fd . /`, and `env DEBUG=1 timeout 5s fd . /`.

### `literal(pattern: string): CommandMatcher`

Use when how the command was written matters, including leading assignments and outer wrappers.

```ts
match: literal("sudo *")
match: literal("DEBUG=* npm test")
```

Literal and effective strings both exclude redirections. Inspect `command.redirections` when routing matters.

### `wrapper(name: string): CommandMatcher`

Use to detect a recognized transparent wrapper anywhere in its chain.

```ts
match: wrapper("sudo")
```

Recognized wrappers are `command`, `exec`, `env`, `sudo`, `doas`, `nice`, `nohup`, and `timeout`. Options are parsed conservatively. Ambiguous forms remain partial rather than guessing the nested executable.

### Boolean combinators

```ts
function anyOf(...matchers: readonly CommandMatcher[]): CommandMatcher;
function allOf(...matchers: readonly CommandMatcher[]): CommandMatcher;
function not(matcher: CommandMatcher): CommandMatcher;
```

```ts
match: allOf(
  anyOf(command("npm publish*"), command("pnpm publish*")),
  not(wrapper("sudo")),
)
```

### Plain predicates

Use a function for argument-aware logic, executable basenames, redirections, ancestry, or uncertainty.

```ts
match: cmd =>
  cmd.effective.executable === "npm" &&
  cmd.effective.args.some(arg => arg.value === "publish")
```

Static arguments have `value`; dynamic arguments do not. Do not infer a static value from `source`.

### `script(test: (value: ParsedScript) => boolean): ScriptMatcher`

Use only when a policy depends on the full script or relationships between commands.

```ts
match: script(({ commands }) => {
  const changesToRoot = commands.some(
    cmd => cmd.effective.executable === "cd" &&
      cmd.effective.args[0]?.value === "/",
  );
  const searches = commands.some(cmd => cmd.effective.executable === "fd");
  return changesToRoot && searches;
})
```

Pi Rules exposes syntax and ancestry; it does not simulate working directories, environment mutation, condition outcomes, aliases, or functions.

## Glob and normalization rules

`command()` and `literal()` use an anchored, case-sensitive textual glob:

- `*` matches zero or more characters, including whitespace and argument boundaries.
- `?` matches exactly one character.
- `\` escapes the next `*`, `?`, or `\` metacharacter; otherwise it is literal.
- There are no character classes, braces, extglobs, `**`, or glob negation.

Because matching is anchored, `command("fd *")` does not match `echo "fd ."`. Use a custom predicate for argument boundaries.

Static shell quoting is decoded and normalized deterministically. Thus `fd . /`, `fd "." "/"`, and `fd '.' '/'` have the same effective text. Values needing quoting are emitted with deterministic single-quote syntax. Dynamic words retain their source representation and are marked dynamic.

Pi Rules does **not** resolve `PATH` or reduce executable paths to basenames. `command("fd * /")` does not match `/usr/bin/fd . /`. If desired:

```ts
import { basename } from "node:path";

match: cmd =>
  cmd.effective.executable !== undefined &&
  basename(cmd.effective.executable) === "fd"
```

Assignments are structured and included in `literal`, but omitted from `effective`. Redirections are structured and omitted from both normalized strings.

## Parsed API

The definitions below summarize the exported interfaces. Consult `api.ts` for the authoritative declarations.

```ts
type AnalysisCertainty = "static" | "dynamic" | "partial";
interface SourceRange { start: number; end: number }

interface ParsedArgument {
  source: string;
  value?: string;       // present only when statically known
  dynamic: boolean;
  range: SourceRange;
}

interface ParsedAssignment {
  source: string;
  name?: string;
  value?: ParsedArgument;
  dynamic: boolean;
  range: SourceRange;
}

interface ParsedRedirection {
  source: string;
  operator: string;
  fileDescriptor?: number;
  target?: ParsedArgument;
  range: SourceRange;
}

interface ParsedWrapper {
  executable: string;
  args: ParsedArgument[];
  source: string;
}

interface EffectiveCommand {
  executable?: string;
  args: ParsedArgument[];
  text: string;
}

interface CommandAncestry {
  type: string;
  range: SourceRange;
}

interface ParsedCommand {
  source: string;
  range: SourceRange;
  depth: number;
  ancestry: CommandAncestry[];
  literalExecutable?: string;
  literalArgs: ParsedArgument[];
  literal: string;
  assignments: ParsedAssignment[];
  redirections: ParsedRedirection[];
  wrappers: ParsedWrapper[]; // outermost first
  effective: EffectiveCommand;
  certainty: AnalysisCertainty;
}

interface ParseDiagnostic {
  message: string;
  position: number;
}

interface ParsedScript {
  raw: string;            // complete unmodified tool input
  ast: BashAst;           // read-only unbash Script AST
  commands: ParsedCommand[];
  certainty: AnalysisCertainty;
  diagnostics: ParseDiagnostic[];
  truncated: boolean;
}
```

Ranges are zero-based offsets. For decoded static `bash -c` scripts containing escapes, nested ranges are anchored to the script argument but may be approximate; use `source` for display and matching.

## Compound commands and uncertainty

The Bash AST is traversed through lists, `&&`/`||`, pipelines, conditionals, loops, groups, subshells, functions, command substitutions, and process substitutions. Static `bash -c` and `sh -c` payloads are recursively parsed, including when the evaluator is behind recognized wrappers. Both the evaluator and nested commands are tested.

Dynamic execution is deliberately not guessed. Examples include `eval`, `xargs`, `find -exec`, package runners, `"$RUNNER"`, and `bash -c "$SCRIPT"`. Understood static commands still receive rules; otherwise uncertainty allows by default unless a custom matcher explicitly asks or denies it:

```ts
match: cmd => cmd.certainty !== "static"
```

Operational limits are fixed at 256 KiB of UTF-8 input and 16 levels of static evaluator recursion. Reaching a limit marks analysis partial and does not itself block.

The parser uses a Bash grammar. Portable commands from other shells commonly parse, but dialect-specific zsh/fish syntax is not guaranteed.

## More examples

Ask before destructive commands:

```ts
{
  match: cmd =>
    cmd.effective.executable === "rm" &&
    cmd.effective.args.some(arg => arg.value === "-rf" || arg.value === "-fr"),
  action: "ask",
  reason: "This recursively removes files.",
}
```

Deny writes to a device:

```ts
{
  match: cmd => cmd.redirections.some(redirection =>
    redirection.operator.includes(">") &&
    redirection.target?.value?.startsWith("/dev/") === true
  ),
  action: "deny",
  reason: "Do not redirect output to devices.",
}
```

Ask for commands inside command substitutions:

```ts
{
  match: cmd =>
    cmd.ancestry.some(parent => parent.type === "CommandExpansion") &&
    cmd.effective.executable === "curl",
  action: "ask",
  reason: "A command substitution performs a network request.",
}
```

## Troubleshooting

- **Rules do not update:** run `/reload`; there is no config watcher.
- **Config is disabled:** inspect the prominent notification or stderr. Imports, syntax, action values, unknown properties, names, and reasons are validated.
- **A command does not match:** inspect effective versus literal semantics, anchored glob behavior, executable paths, and static versus dynamic argument values.
- **A matcher failed:** the blocked tool result includes the thrown error. Keep matchers synchronous and side-effect-free.
- **Parsing is partial:** use narrower custom checks against understood fields; do not treat source text as proof of shell execution semantics.

Pi Rules is a behavioral guard, not a complete permission boundary. Parser gaps, dynamic construction, shell state, subprocesses, alternate tools, and user-issued shell shortcuts can all lie outside its analysis.
