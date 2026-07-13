import assert from "node:assert/strict";
import test from "node:test";
import { allOf, command, literal, not, wrapper } from "../api.ts";
import { parseBash } from "../parser.ts";

function only(source: string) {
	const parsed = parseBash(source);
	assert.equal(parsed.commands.length, 1);
	return parsed.commands[0]!;
}

test("normalizes assignments and redirections without including them in effective text", () => {
	const parsed = only("DEBUG=1 fd '.' / 2>/dev/null");
	assert.equal(parsed.literal, "DEBUG=1 fd . /");
	assert.equal(parsed.effective.text, "fd . /");
	assert.equal(parsed.assignments[0]?.name, "DEBUG");
	assert.equal(parsed.redirections[0]?.target?.value, "/dev/null");
	assert(command("fd * /")(parsed));
	assert(command("fd '\\*' /")(only("fd '*' /")));
	assert(literal("DEBUG=* fd *")(parsed));
});

test("conservatively unwraps a chain of known wrappers", () => {
	const parsed = only("sudo -u root env FOO=1 timeout --signal KILL 5s fd . /");
	assert.deepEqual(parsed.wrappers.map((item) => item.executable), ["sudo", "env", "timeout"]);
	assert.equal(parsed.effective.text, "fd . /");
	assert(wrapper("sudo")(parsed));
	assert(allOf(command("fd *"), wrapper("env"), not(wrapper("nohup")))(parsed));
});

test("keeps uncertain wrapper invocations partial", () => {
	const parsed = only("env -S 'sudo fd . /'");
	assert.equal(parsed.certainty, "partial");
	assert.equal(parsed.effective.executable, "env");
});

test("does not unwrap command name inspection and handles exec argv0", () => {
	assert.equal(only("command -v fd").effective.text, "command -v fd");
	assert.equal(only("exec -a custom fd .").effective.text, "fd .");
});

test("collects commands in compounds, substitutions, and process substitutions", () => {
	const parsed = parseBash("if test -d /tmp; then echo \"$(fd . /)\"; cat <(rm -f /tmp/x); fi");
	assert.deepEqual(parsed.commands.map((item) => item.effective.executable), ["test", "echo", "fd", "cat", "rm"]);
	const nested = parsed.commands.find((item) => item.effective.executable === "fd");
	assert(nested?.ancestry.some((item) => item.type === "CommandExpansion"));
	assert((nested?.depth ?? 0) > 0);
});

test("recursively parses static shell evaluator scripts only", () => {
	const staticScript = parseBash("bash -c 'sudo fd . /' ignored positional");
	assert(staticScript.commands.some((item) => item.effective.text === "fd . /"));
	const dynamicScript = parseBash('bash -c "$SCRIPT"');
	assert.equal(dynamicScript.commands.length, 1);
	assert.equal(dynamicScript.commands[0]?.certainty, "partial");
});

test("does not reduce executable paths to basenames", () => {
	const parsed = only("/usr/bin/fd . /");
	assert(!command("fd * /")(parsed));
	assert(command("/usr/bin/fd * /")(parsed));
});

test("marks malformed input as partial without throwing", () => {
	const parsed = parseBash("echo $(fd . /");
	assert.equal(parsed.certainty, "partial");
});
