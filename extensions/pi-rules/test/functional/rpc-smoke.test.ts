import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";

const extensionRoot = path.resolve(import.meta.dirname, "../..");
const providerFixture = path.join(extensionRoot, "test/fixtures/deterministic-provider.ts");

type JsonObject = Record<string, any>;
type Pending = { resolve: (event: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type EventWaiter = Pending & { predicate: (event: JsonObject) => boolean; startIndex: number };
type ConfirmAnswer = boolean | "cancel";

class RpcClient {
	readonly events: JsonObject[] = [];
	readonly confirms: JsonObject[] = [];
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, Pending>();
	private readonly waiters = new Set<EventWaiter>();
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private stderr = "";
	private confirmAnswers: ConfirmAnswer[] = [];

	constructor(agentDir: string, withProvider = false) {
		const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", path.join(extensionRoot, "index.ts")];
		if (withProvider) {
			args.push("-e", providerFixture, "--provider", "pi-rules-test", "--model", "deterministic");
		}
		this.child = spawn("pi", args, {
			cwd: extensionRoot,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
		this.child.stdout.on("end", () => this.consume(this.decoder.end()));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
		this.child.on("exit", (code, signal) => {
			const error = new Error(`pi exited (${code ?? signal}): ${this.stderr}\n${this.tail()}`);
			for (const pending of this.pending.values()) pending.reject(error);
			for (const waiter of this.waiters) waiter.reject(error);
			this.pending.clear();
			this.waiters.clear();
		});
	}

	async ready(): Promise<void> {
		await this.request({ type: "get_state" });
	}

	async prompt(message: string): Promise<JsonObject> {
		return this.request({ type: "prompt", message });
	}

	async run(commands: string[], confirmAnswers: ConfirmAnswer[] = []): Promise<JsonObject[]> {
		const startIndex = this.events.length;
		this.confirmAnswers = [...confirmAnswers];
		await this.prompt(`PI_RULES_TEST:${JSON.stringify({ commands })}`);
		await this.waitFor((event) => event.type === "agent_settled", startIndex);
		assert.equal(this.confirmAnswers.length, 0, "not all expected confirmation answers were consumed");
		return this.events.slice(startIndex);
	}

	waitFor(predicate: (event: JsonObject) => boolean, startIndex = 0, timeoutMs = 15_000): Promise<JsonObject> {
		const existing = this.events.slice(startIndex).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, startIndex, resolve, reject, timer: setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for RPC event\n${this.tail()}`));
			}, timeoutMs) };
			this.waiters.add(waiter);
		});
	}

	async close(): Promise<void> {
		if (this.child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill("SIGTERM");
		await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}

	private request(payload: JsonObject, timeoutMs = 15_000): Promise<JsonObject> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${payload.type}\n${this.tail()}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
		});
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line !== "") this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let event: JsonObject;
		try { event = JSON.parse(line) as JsonObject; }
		catch { return; }
		this.events.push(event);

		if (event.type === "extension_ui_request" && event.method === "confirm") {
			this.confirms.push(event);
			const answer = this.confirmAnswers.shift() ?? false;
			const response = answer === "cancel"
				? { type: "extension_ui_response", id: event.id, cancelled: true }
				: { type: "extension_ui_response", id: event.id, confirmed: answer };
			this.child.stdin.write(`${JSON.stringify(response)}\n`);
		}

		if (event.type === "extension_error") {
			const error = new Error(`Extension error: ${JSON.stringify(event)}`);
			for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
			this.pending.clear();
		}

		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				this.pending.delete(event.id);
				clearTimeout(pending.timer);
				if (event.success === true) pending.resolve(event);
				else pending.reject(new Error(String(event.error ?? "RPC request failed")));
			}
		}

		for (const waiter of this.waiters) {
			if (this.events.length - 1 < waiter.startIndex || !waiter.predicate(event)) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(event);
		}
	}

	private tail(): string {
		return `${this.events.slice(-60).map((event) => JSON.stringify(event)).join("\n")}\nstderr: ${this.stderr}`;
	}
}

function commandExists(command: string): boolean {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

async function exists(file: string): Promise<boolean> {
	try { await access(file); return true; }
	catch { return false; }
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function toolEnds(events: JsonObject[]): JsonObject[] {
	return events.filter((event) => event.type === "tool_execution_end" && event.toolName === "bash");
}

const hasPi = commandExists("pi");

void test("Pi Rules deterministic RPC functional suite", { skip: hasPi ? false : "pi CLI not found", timeout: 90_000 }, async (t) => {
	await t.test("/pi-rules:init creates once and never overwrites", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-rules-rpc-init-"));
		const client = new RpcClient(agentDir);
		try {
			await client.ready();
			await client.prompt("/pi-rules:init");
			const configPath = path.join(agentDir, "pi-rules.config.ts");
			assert.match(await readFile(configPath, "utf8"), /defineConfig/);
			await writeFile(configPath, "sentinel\n");
			await client.prompt("/pi-rules:init");
			assert.equal(await readFile(configPath, "utf8"), "sentinel\n");
		} finally {
			await client.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	await t.test("invalid configuration produces a prominent RPC warning", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-rules-rpc-invalid-"));
		await writeFile(path.join(agentDir, "pi-rules.config.ts"), "export default { rules: [{ action: 'deny' }] };\n");
		const client = new RpcClient(agentDir);
		try {
			await client.ready();
			const warning = await client.waitFor((event) =>
				event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error");
			assert.match(String(warning.message), /disabled/i);
		} finally {
			await client.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	await t.test("deny, ask, exceptions, nesting, and sibling calls are enforced", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-rules-rpc-enforce-"));
		const agentDir = path.join(root, "agent");
		await mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await symlink(extensionRoot, path.join(agentDir, "extensions/pi-rules"), "dir");
		await writeFile(path.join(agentDir, "pi-rules.config.ts"), `
import { command, defineConfig, wrapper } from "./extensions/pi-rules/api";
export default defineConfig({ rules: [
  { match: command("fd * /"), action: "deny", reason: "No broad searches." },
  { match: command("touch *"), action: "ask", reason: "Creates a file." },
  { match: wrapper("sudo"), action: "ask", reason: "Elevated command." },
  { match: cmd => { if (cmd.effective.executable === "explode") throw new Error("fixture matcher exploded"); return false; }, action: "ask" },
] });
`);
		const client = new RpcClient(agentDir, true);
		try {
			await client.ready();

			const compoundMarker = path.join(root, "compound-marker");
			const confirmsBeforeDeny = client.confirms.length;
			const denied = await client.run([`touch ${shellQuote(compoundMarker)} && echo "$(fd . /)"`]);
			assert.equal(await exists(compoundMarker), false);
			assert.match(JSON.stringify(toolEnds(denied)), /No broad searches/, JSON.stringify(denied));
			assert.equal(client.confirms.length, confirmsBeforeDeny, "deny should suppress ask");

			const precedence = await client.run(["sudo fd . /"]);
			assert.match(JSON.stringify(toolEnds(precedence)), /No broad searches/);
			assert.equal(client.confirms.length, confirmsBeforeDeny, "deny should take precedence over wrapper ask");

			const approvedMarker = path.join(root, "approved-marker");
			await client.run([`touch ${shellQuote(approvedMarker)}`], [true]);
			assert.equal(await exists(approvedMarker), true);

			const rejectedMarker = path.join(root, "rejected-marker");
			const rejected = await client.run([`touch ${shellQuote(rejectedMarker)}`], [false]);
			assert.equal(await exists(rejectedMarker), false);
			assert.match(JSON.stringify(toolEnds(rejected)), /blocked by Pi Rules confirmation/i);

			const cancelledMarker = path.join(root, "cancelled-marker");
			const cancelled = await client.run([`touch ${shellQuote(cancelledMarker)}`], ["cancel"]);
			assert.equal(await exists(cancelledMarker), false);
			assert.match(JSON.stringify(toolEnds(cancelled)), /blocked by Pi Rules confirmation/i);

			const wrapperRejected = await client.run(["sudo echo should-not-run"], [false]);
			assert.match(JSON.stringify(wrapperRejected.filter((event) => event.type === "extension_ui_request")), /Elevated command/);
			assert.match(JSON.stringify(toolEnds(wrapperRejected)), /blocked by Pi Rules confirmation/i);

			const thrown = await client.run(["explode"]);
			assert.match(JSON.stringify(toolEnds(thrown)), /fixture matcher exploded/);

			const allowedSibling = path.join(root, "allowed-sibling");
			const blockedSibling = path.join(root, "blocked-sibling");
			const siblings = await client.run([
				`printf ok > ${shellQuote(allowedSibling)}`,
				`touch ${shellQuote(blockedSibling)} && fd . /`,
			]);
			assert.equal(toolEnds(siblings).length, 2);
			assert.equal(await exists(allowedSibling), true);
			assert.equal(await exists(blockedSibling), false);
		} finally {
			await client.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
