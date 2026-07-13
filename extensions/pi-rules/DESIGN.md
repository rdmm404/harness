# Pi Rules Extension — Design

## Status

Implemented v1 design. Decisions below describe the current extension unless marked unresolved.

## Purpose

A global Pi extension that discourages unwanted agent Bash behavior. It is intentionally not a complete permission system or security boundary.

Example: deny commands that scan the entire filesystem and explain why the behavior is unwanted.

## Scope

- Global configuration only; no project-local configuration.
- Intercept agent calls to Pi's `bash` tool through `tool_call`.
- Do not intercept user-entered `!` or `!!` commands.
- Supported actions:
  - `deny`: always block.
  - `ask`: request confirmation for this tool call.
- No `allow` action or persistent allow list.
- Approval of an `ask` rule applies only to the current Bash tool call.
- Matchers are synchronous in v1.

## TypeScript configuration

Configuration will be a TypeScript module, inspired by Vite configuration, rather than JSON. It must synchronously default-export one configuration object through `defineConfig({ ... })`. `defineConfig()` accepts objects only—no array shorthand, async factory, or environment callback in v1. The module may still use normal top-level TypeScript computations and imports. An illustrative API:

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
      name: "no-root-scans",
      match: command("fd * /"),
      action: "deny",
      reason: "Use a narrower search path instead.",
    },
    {
      match: wrapper("sudo"),
      action: "ask",
      reason: "This command requests elevated privileges.",
    },
    {
      match: cmd => cmd.effective.executable === "npm" &&
        cmd.effective.args.some(arg => arg.value === "publish"),
      action: "ask",
    },
    {
      match: script(({ ast, commands }) => {
        // Inspect relationships between commands.
        return false;
      }),
      action: "deny",
      reason: "This command sequence is disallowed.",
    },
  ],
});
```

The extension is named **Pi Rules** (`pi-rules`). Its global TypeScript config lives at `~/.pi/agent/pi-rules.config.ts`, separate from the extension implementation. V1 is a directly installed global extension, and config helpers use the reliable relative import `./extensions/pi-rules/api`; it does not assume a bare package import can resolve from the global config.

## Rule types

Common fields should not be repeated across action variants. `deny` requires a reason; `ask` may provide one. Runtime validation requires deny reasons to contain non-whitespace text. Optional ask reasons and optional rule names must also contain non-whitespace text when present. Reasons are static strings in v1, not callbacks. Blocked results pair each static reason with its matched command or script. Rule names are optional.

```ts
type RuleBase = {
  match: Matcher;
  name?: string;
};

type Rule = RuleBase & (
  | { action: "deny"; reason: string }
  | { action: "ask"; reason?: string }
);
```

`defineConfig()` should preserve literal types and provide useful TypeScript diagnostics. Runtime validation is strict: unknown top-level or rule properties invalidate and disable the config, with diagnostics containing precise property paths. This catches typos even when static typing is bypassed.

## Matcher model

### Per-command matchers

The default matcher is a plain function receiving exactly one parsed command:

```ts
type CommandMatcher = (command: ParsedCommand) => boolean;
```

The engine parses the script once, traverses it once, and efficiently applies command matchers to every discovered command. Config authors do not repeatedly iterate over the complete command collection.

Convenience helpers return ordinary `CommandMatcher` functions:

- `command(pattern)`: anchored glob over the effective command.
- `literal(pattern)`: anchored glob over the literal command invocation.
- `wrapper(name)`: match a recognized wrapper anywhere in the wrapper chain.
- `anyOf(...matchers)`
- `allOf(...matchers)`
- `not(matcher)`

`command()` accepts only a string. Custom matching needs no helper:

```ts
match: cmd => cmd.effective.executable === "fd"
```

### Script matchers

Some behavior depends on relationships between commands:

```bash
cd / && fd .
```

A per-command matcher cannot infer that `fd .` may run from `/`. Whole-script matching is an explicit escape hatch:

```ts
match: script(parsedScript => /* custom relationship analysis */)
```

`script()` returns a branded script matcher so the engine can distinguish it from a plain command function without inspecting function arity.

A script matcher receives the raw input, AST, and flattened commands. V1 exposes syntax and control-flow relationships but does not simulate shell state such as working-directory or environment changes.

When a script-level `ask` rule matches, the prompt shows the entire raw Bash input and the optional rule reason.

## Literal and effective commands

Each parsed command exposes both:

- **Literal invocation:** the command as structurally written, such as `sudo env FOO=1 fd . /`.
- **Effective invocation:** the underlying command after conservatively peeling recognized transparent wrappers, such as `fd . /`.

“Effective” is deliberately used instead of “resolved”: the extension does not imply PATH lookup, alias/function expansion, symlink resolution, variable expansion, or execution of substitutions.

V1 recognizes this conservative transparent-wrapper set: `command`, `exec`, `env`, `sudo`, `doas`, `nice`, `nohup`, and `timeout`. Each wrapper's relevant options must be parsed before identifying its nested executable; Pi Rules must not simply discard the first token. More complex launchers such as `xargs`, `find -exec`, `parallel`, and package runners are not automatically unwrapped.

Examples:

```text
fd . /                   -> effective: fd . /
sudo fd . /              -> effective: fd . /
env DEBUG=1 fd . /       -> effective: fd . /
sudo env DEBUG=1 fd . /  -> effective: fd . /
```

Consequently, `command("fd * /")` can match all four, while `wrapper("sudo")` can match the wrapper explicitly. `literal("sudo *")` matches the complete outer invocation.

String helpers use a deliberately small, case-sensitive glob language: `*` matches zero or more characters, `?` matches exactly one character, and `\` escapes the next glob metacharacter. V1 has no special `**`, character classes, braces, extglobs, or glob-level negation; matcher composition provides boolean logic.

String helper patterns are anchored rather than substring searches. This avoids matching text passed as an argument, for example `echo "fd . /"`. Globs are deliberately textual: `*` may span normalized quoting, whitespace, and multiple argument boundaries. For example, `command("fd * /")` matches `fd . /`, `fd --hidden foo /`, and `fd 'foo bar' /`. Argument-aware policies should use a custom command matcher. `command()` does not automatically reduce executable paths to basenames: `command("fd * /")` does not match `/usr/bin/fd . /`. Users can inspect the executable basename with a custom matcher or a future dedicated helper.

## Parsing compound commands

Pi Rules will be a package-style extension with runtime dependencies. It must use a mature Bash parser rather than a hand-written command splitter.

V1 is dialect-agnostic at the product/API level: it does not detect or expose the user's configured shell and has no `shell` configuration option. Internally it parses with a Bash grammar. This is expected to cover ordinary portable commands used from zsh and other shells, but Pi Rules does not claim support for dialect-specific syntax. Unsupported syntax follows the normal partial-analysis policy. Dialect-specific parsers may be added later without changing the rule model.

The extension should parse Bash input into an AST and traverse as deeply as is practical and performant, including:

- `&&`, `||`, `;`, and newline-separated commands
- pipelines
- grouped commands and subshells
- command substitutions (`$(...)` and backticks)
- recursively parseable shell evaluator inputs such as static `bash -c '...'` and `sh -c '...'`

For a static evaluator such as `bash -c 'sudo fd . /'`, rules evaluate both the outer `bash` invocation and the recursively parsed inner `sudo fd . /` command. Nested commands retain ancestry/source relationships to their evaluator.

Indirect or dynamic execution such as `xargs`, `find -exec`, `eval`, dynamic `bash -c "$COMMAND"`, and `"$RUNNER" ...` must not be presented as statically certain when it is not.

Parsing should retain source ranges so matches can identify and deduplicate the exact command nodes that triggered rules.

V1 uses fixed operational limits rather than exposing tuning options:

- Maximum Bash tool-call input: 256 KiB (262,144 bytes, measured as UTF-8).
- Maximum recursive parsing depth for static embedded shell evaluators: 16.
- No separate discovered-command count limit.
- Traversal should be iterative where practical.
- Reaching a limit preserves results parsed so far and marks the affected input as partial; it does not itself block the tool call.

## Parsed data

Exact types remain unresolved, but parsed commands should expose at least:

- exact source text and source range
- literal executable and arguments
- recognized wrappers, outermost first
- effective executable, arguments, and normalized text
- nesting/control-flow location
- whether analysis is static, dynamic, or partial

Arguments should retain their source representation and expose a static value only when known. They should not be modeled as always-static strings. Fully static arguments normalize by decoded value, so `fd . /`, `fd "." "/"`, and `fd '.' '/'` produce the same normalized command. Normalization then applies deterministic quoting only where needed. Dynamic arguments retain a source-based normalized representation and remain distinguishable from literal strings through parsed argument metadata. Leading environment assignments are excluded from the effective command but retained in the literal invocation and as structured assignment data; for example, `DEBUG=1 fd . /` has literal `DEBUG=1 fd . /` and effective `fd . /`. Normalized literal/effective command strings exclude shell redirections, so output routing does not change command glob matches. Redirections remain available as structured `ParsedCommand` data for custom matchers.

## Uncertainty

This is a behavior guard, not a security boundary. If parsing is incomplete or execution is dynamic:

- apply rules to everything understood statically;
- otherwise allow by default;
- expose parsed uncertainty so custom rules/helpers can explicitly ask or deny it.

Potential helpers include `dynamicCommand()` and `incompleteAnalysis()`, but these are not yet committed to the initial helper set.

## Evaluation and precedence

For each Bash tool call:

1. Parse the input once.
2. Evaluate all rules across their appropriate scopes.
3. Collect and deduplicate matches by command source range and rule.
4. If one or more `deny` rules match, block without prompting.
5. Report all matched deny reasons to the model rather than stopping at the first match. Preserve every distinct reason where possible, show at most 10 associated command excerpts per reason, truncate each excerpt to 300 characters, and cap the complete blocked result at 8,000 characters. Report omitted match/reason counts when truncation is necessary.
6. If there are no deny matches but one or more `ask` matches, prompt once for the entire Bash tool call.
7. The prompt lists only commands that matched `ask` rules, combining multiple matching rule reasons beneath a deduplicated command.
8. Confirmation UI uses character-based display limits: 300 characters per matched command, 1,200 characters for a script-level match, at most 10 displayed matches, and at most 3,000 characters for the complete prompt. It truncates at Unicode code-point boundaries, appends an ellipsis, and reports omitted match counts. These limits affect display only.
9. Confirmation has no timeout. Escape, cancellation, or No blocks the complete tool call.

Individual shell segments cannot be approved independently because execution is atomic at the Bash tool-call boundary and partial approval would require rewriting shell semantics.

Sibling Bash tool calls from one assistant turn remain independent. A denial blocks only its own tool call, not unmatched or approved siblings. Pi's sequential preflight naturally serializes confirmation prompts; Pi Rules does not aggregate separate tool calls into one dialog. Unblocked siblings may execute concurrently according to Pi's normal behavior.

## Runtime modes

- In TUI/RPC modes, `ask` uses Pi's confirmation UI.
- In print/JSON modes, or whenever no interactive UI is available, `ask` blocks with a clear reason that confirmation could not be obtained.
- `deny` always blocks and provides its configured reason.

## Model interaction and configuration reference

Pi Rules is enforcement-only. It does not inject rule descriptions, deny reasons, or guidance into the system prompt. When a `deny` rule matches, its reason is returned in the blocked Bash tool result so the model can adjust after the attempted call.

The finished extension must include a standalone Markdown configuration reference written so coding models can reliably configure Pi Rules. It is accompanying documentation, not automatically injected context. It should cover:

- global config location, imports, initialization, and `/reload` workflow;
- complete config and rule type signatures;
- every helper signature and exact matching semantics;
- when to use `command()`, `literal()`, `wrapper()`, boolean combinators, a plain command predicate, or `script()`;
- `ParsedCommand`, `ParsedScript`, argument, wrapper, redirection, assignment, source-range, ancestry, and uncertainty fields available to custom functions;
- literal versus effective command normalization;
- glob syntax, anchoring, quoting, assignments, executable paths, and redirection behavior;
- compound/nested command handling and the limits of static analysis;
- deny/ask precedence and non-interactive behavior;
- copyable examples for common policies and advanced custom matchers;
- troubleshooting invalid configs, matcher errors, parser uncertainty, and stale configs;
- explicit non-security-boundary caveats and v1 non-goals.

The reference must be kept aligned with exported TypeScript types and helper behavior.

## Explicit non-goals for v1

- Security sandbox or complete permission boundary
- Project-local rules
- Persistent approvals or an allow list
- An `allow` action
- Interception of user `!`/`!!` commands
- Async matchers
- Full shell execution/state simulation
- Resolving arbitrary dynamic command construction

## Implementation choices

- Config modules load through `jiti` with filesystem and module caches disabled, so Pi's `/reload` sees edits.
- Bash parsing uses `unbash`, a synchronous, zero-dependency TypeScript AST parser with source positions and tolerant parsing.
- Stable public types and helpers live in `api.ts`; the typed, read-only `unbash` script AST remains available as `ParsedScript.ast` for advanced script matchers.
- The small anchored glob and deterministic static-value quoting are implemented locally.
- Each recognized wrapper has conservative option handling; ambiguous forms stop unwrapping and mark the command partial.
- Confirmation and denial formatting use the character and count limits specified above.
## Configuration lifecycle

The global config path is `~/.pi/agent/pi-rules.config.ts`.

- If the config is missing, Pi Rules loads silently with no rules.
- `/pi-rules:init` creates a starter config on demand.
- Initialization atomically creates only the config file with exclusive-create semantics and never overwrites an existing config. It does not create parent or unrelated directories; `~/.pi/agent` already exists when the global extension runs.
- The starter imports public helpers from `./extensions/pi-rules/api` and exports `defineConfig({ rules: [] })`, with one commented example rule.
- Initialization tells the user where to edit the file. It does not reload automatically because the generated rule set is empty.
- Existing config changes take effect only through Pi's built-in `/reload` command.
- V1 has no file watcher, automatic refresh, or dedicated refresh command. `/pi-rules:init` is its only extension command.
- Config loading must avoid stale TypeScript module-cache entries across `/reload`.
- If the config exists but cannot be loaded or validated, Pi Rules disables itself. In TUI/RPC mode it shows a prominent warning; in JSON/print mode it writes a concise error to stderr. The same error is not repeated on every Bash call.
- It does not block all Bash commands when configuration fails: this extension is not a security boundary, and a broken behavioral configuration should not make Pi unusable.
- If a matcher throws while evaluating a Bash tool call, Pi Rules blocks that specific call and reports the matcher error. It does not silently allow the call or disable the entire extension.
