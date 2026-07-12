import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import errorAdvisor from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const notify = vi.fn();
	const ctx = { ui: { notify } };
	const emit = async (event: { type: string } & Record<string, unknown>): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(event.type) ?? []) {
			result = await handler(event, ctx);
		}
		return result;
	};
	return { pi: pi as never, emit, notify };
}

function assistantMessage(overrides: Partial<AssistantMessage>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	} as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function noteTexts(result: unknown, originalLength: number): string[] {
	const messages = (result as { messages: AgentMessage[] } | undefined)?.messages ?? [];
	return messages.slice(originalLength).map((m) => {
		const content = (m as { content: Array<{ type: string; text?: string }> }).content;
		return content[0]?.text ?? "";
	});
}

describe("error-advisor extension", () => {
	it("advises after a transient provider error without changing the plan", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const messages = [
			userMessage("do the thing"),
			assistantMessage({ stopReason: "error", errorMessage: "overloaded_error: try again later" }),
			userMessage("continue"),
		];
		const result = await emit({ type: "context", messages });
		const notes = noteTexts(result, messages.length);

		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("transient provider error");
		expect(notes[0]).toContain("do not change your plan");
	});

	it("advises differently for non-retryable errors", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const messages = [
			userMessage("do the thing"),
			assistantMessage({ stopReason: "error", errorMessage: "invalid x-api-key: authentication_error" }),
			userMessage("continue"),
		];
		const notes = noteTexts(await emit({ type: "context", messages }), messages.length);

		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("non-retryable provider error");
	});

	it("adds no note once a successful assistant turn lands", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const messages = [
			userMessage("do the thing"),
			assistantMessage({ stopReason: "error", errorMessage: "overloaded_error" }),
			userMessage("continue"),
			assistantMessage({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
			userMessage("next task"),
		];
		expect(await emit({ type: "context", messages })).toBeUndefined();
	});

	it("stays silent after a user abort", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const messages = [userMessage("do it"), assistantMessage({ stopReason: "aborted" })];
		expect(await emit({ type: "context", messages })).toBeUndefined();
	});

	it("notes successful overflow compaction exactly once", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		await emit({ type: "session_before_compact", reason: "overflow", signal: new AbortController().signal });
		await emit({ type: "session_compact", reason: "overflow" });

		const messages = [userMessage("hi")];
		const notes = noteTexts(await emit({ type: "context", messages }), messages.length);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("automatically compacted");

		// One-shot: the next request carries no note.
		expect(await emit({ type: "context", messages })).toBeUndefined();
	});

	it("infers compaction failure when the next request arrives without session_compact", async () => {
		const { pi, emit, notify } = createFakePi();
		errorAdvisor(pi);

		await emit({ type: "session_before_compact", reason: "overflow", signal: new AbortController().signal });

		const messages = [userMessage("hi")];
		const notes = noteTexts(await emit({ type: "context", messages }), messages.length);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("did not complete");
		expect(notify).toHaveBeenCalledOnce();
	});

	it("stays silent when the user aborts overflow compaction", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const abortController = new AbortController();
		await emit({ type: "session_before_compact", reason: "overflow", signal: abortController.signal });
		abortController.abort();

		expect(await emit({ type: "context", messages: [userMessage("hi")] })).toBeUndefined();
	});

	it("ignores manual and threshold compaction", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		await emit({ type: "session_before_compact", reason: "manual", signal: new AbortController().signal });
		await emit({ type: "session_compact", reason: "manual" });
		await emit({ type: "session_before_compact", reason: "threshold", signal: new AbortController().signal });
		await emit({ type: "session_compact", reason: "threshold" });

		expect(await emit({ type: "context", messages: [userMessage("hi")] })).toBeUndefined();
	});

	it("does not mutate the original messages array and marks notes non-display", async () => {
		const { pi, emit } = createFakePi();
		errorAdvisor(pi);

		const messages = [userMessage("x"), assistantMessage({ stopReason: "error", errorMessage: "overloaded_error" })];
		const result = (await emit({ type: "context", messages })) as { messages: AgentMessage[] };

		expect(messages).toHaveLength(2);
		expect(result.messages).toHaveLength(3);
		const note = result.messages[2] as { role: string; customType?: string; display?: boolean };
		expect(note.role).toBe("custom");
		expect(note.customType).toBe("error-advisor");
		expect(note.display).toBe(false);
	});
});
