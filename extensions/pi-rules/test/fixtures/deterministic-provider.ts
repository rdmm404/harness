import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Scenario = { commands: string[] };
let sequence = 0;

function outputFor(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function requestedScenario(context: Context): Scenario | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const text = typeof message.content === "string"
			? message.content
			: message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
		const prefix = "PI_RULES_TEST:";
		if (!text.startsWith(prefix)) continue;
		return JSON.parse(text.slice(prefix.length)) as Scenario;
	}
	return undefined;
}

function hasResultsAfterRequest(context: Context): boolean {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const role = context.messages[index]?.role;
		if (role === "toolResult") return true;
		if (role === "user") return false;
	}
	return false;
}

function streamDeterministic(
	model: Model<Api>,
	context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = outputFor(model);

	queueMicrotask(() => {
		stream.push({ type: "start", partial: output });
		const scenario = requestedScenario(context);
		if (!scenario || hasResultsAfterRequest(context)) {
			const contentIndex = output.content.length;
			output.content.push({ type: "text", text: "scenario complete" });
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: "scenario complete", partial: output });
			stream.push({ type: "text_end", contentIndex, content: "scenario complete", partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
			return;
		}

		output.stopReason = "toolUse";
		for (const command of scenario.commands) {
			const contentIndex = output.content.length;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `pi-rules-test-${++sequence}`,
				name: "bash",
				arguments: { command },
			};
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
		}
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
	});

	return stream;
}

export default function deterministicProvider(pi: ExtensionAPI): void {
	pi.registerProvider("pi-rules-test", {
		name: "Pi Rules deterministic test provider",
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "test-only",
		api: "pi-rules-test",
		models: [{
			id: "deterministic",
			name: "Deterministic",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 1_024,
		}],
		streamSimple: streamDeterministic,
	});
}
