import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import piRules from "../index.ts";

test("the tool_call handler enforces deny and ask precedence", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-rules-extension-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "pi-rules.config.ts"), `
export default {
  rules: [
    { match: cmd => cmd.effective.executable === "fd", action: "deny", reason: "No broad searches." },
    { match: cmd => cmd.wrappers.some(item => item.executable === "sudo"), action: "ask", reason: "Elevated." },
  ],
};
`);
		const handlers = new Map<string, (...args: any[]) => unknown>();
		const commands = new Map<string, unknown>();
		const api = {
			on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
			registerCommand(name: string, command: unknown) { commands.set(name, command); },
		} as unknown as ExtensionAPI;
		await piRules(api);
		assert(commands.has("pi-rules:init"));
		const handler = handlers.get("tool_call");
		assert(handler);

		let confirmations = 0;
		const context = {
			hasUI: true,
			ui: { confirm: async () => { confirmations++; return true; } },
		} as unknown as ExtensionContext;
		const denied = await handler({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "sudo fd . /" } } as ToolCallEvent, context) as { block?: boolean; reason?: string };
		assert.equal(denied.block, true);
		assert.match(denied.reason ?? "", /No broad searches/);
		assert.equal(confirmations, 0, "deny must suppress ask confirmation");

		const asked = await handler({ type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "sudo echo ok" } } as ToolCallEvent, context);
		assert.equal(asked, undefined);
		assert.equal(confirmations, 1);

		const headless = await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "3", input: { command: "sudo echo ok" } } as ToolCallEvent,
			{ hasUI: false } as ExtensionContext,
		) as { block?: boolean; reason?: string };
		assert.equal(headless.block, true);
		assert.match(headless.reason ?? "", /no interactive UI/i);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
});
