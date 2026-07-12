/**
 * pi-error-advisor
 *
 * Makes provider errors visible to the LLM at request time — without writing
 * anything to the session.
 *
 * Pi's default behavior keeps errors UI-only: assistant error messages carry
 * the error in the `errorMessage` field with empty content (which provider
 * serializers drop entirely), and overflow recovery removes the error message
 * from context before retrying. The model therefore never learns that a
 * request failed, why compaction ran, or that retries were exhausted.
 *
 * This extension synthesizes a short, clearly-labeled note into the outgoing
 * request context whenever the previous turn failed:
 *
 * - Transient provider errors (rate limit / overloaded / network) after retry
 *   exhaustion: tells the model the failure was infrastructure — retry the
 *   same approach, don't change plans.
 * - Non-retryable errors (400/401/422): surfaces the error text so the model
 *   can inform the user (e.g. expired auth) or adjust (e.g. rejected content).
 * - Overflow recovery: notes that the conversation was compacted (or that
 *   compaction did not complete) so the model keeps responses concise.
 *
 * Nothing is persisted. The note is added in the `context` hook, which only
 * affects the outgoing provider request: sessions, exports, compaction
 * summaries, forks, and resumes are byte-identical with or without this
 * extension. Notes are self-limiting — they stop as soon as a successful
 * assistant turn lands.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTE_PREFIX = "[error-advisor]";
const MAX_ERROR_TEXT = 300;
const ADVISOR_CUSTOM_TYPE = "error-advisor";

function makeNote(text: string): AgentMessage {
	return {
		role: "custom",
		customType: ADVISOR_CUSTOM_TYPE,
		content: [{ type: "text", text: `${NOTE_PREFIX} ${text}` }],
		display: false,
		timestamp: Date.now(),
	};
}

function truncate(text: string): string {
	return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * Find the trailing assistant error message: the last assistant message with
 * stopReason "error" that has no completed assistant message after it.
 *
 * Stops scanning at: a successful/aborted assistant message (advice would be
 * stale or unwanted — user aborts are not the model's business), or a
 * compaction/branch summary (errors before a summary are ancient history).
 */
function findTrailingError(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
			return undefined;
		}
		if (msg.role !== "assistant") {
			continue;
		}
		const assistant = msg as AssistantMessage;
		return assistant.stopReason === "error" ? assistant : undefined;
	}
	return undefined;
}

function classifyError(msg: AssistantMessage): string {
	const errorText = truncate(msg.errorMessage ?? "unknown error");
	if (isContextOverflow(msg, 0)) {
		return (
			"The previous request exceeded the model's context window and could not be completed. " +
			"Keep your responses concise. If this persists, suggest the user run /compact or switch to a larger-context model."
		);
	}
	if (isRetryableAssistantError(msg)) {
		return (
			`The previous request failed with a transient provider error after automatic retries were exhausted: "${errorText}". ` +
			"This was an infrastructure problem, not a problem with your approach — do not change your plan because of it. " +
			"Briefly let the user know the provider was unavailable and that retrying later should work."
		);
	}
	return (
		`The previous request failed with a non-retryable provider error: "${errorText}". ` +
		"If it indicates an authentication problem, tell the user to check their credentials (e.g. /login). " +
		"If it indicates a malformed request, part of the conversation history may contain content the provider rejects."
	);
}

export default function errorAdvisor(pi: ExtensionAPI) {
	// One-shot flags set by compaction events, consumed by the next context
	// transform. These cover the overflow-recovery path, where the error
	// message is removed from context before the retry — a stateless scan of
	// the context can't see it, but the compaction events can.
	//
	// Failure inference: session_compact fires only on success, and there is
	// no failure event. Event order matters — agent_end fires BEFORE the
	// post-run compaction, so it cannot be used to detect failure. Instead:
	// by the time the next `context` transform runs, an overflow compaction
	// has either succeeded (session_compact cleared the pending flag before
	// the retry request) or failed (the run died and this request belongs to
	// the next prompt). A user abort clears the flag via the event's signal,
	// so cancellations stay silent (user aborts are not the model's business).
	let overflowCompacted = false;
	let overflowCompactionPending = false;

	pi.on("session_before_compact", async (event) => {
		if (event.reason === "overflow") {
			overflowCompactionPending = true;
			event.signal.addEventListener("abort", () => {
				overflowCompactionPending = false;
			});
		}
		return undefined;
	});

	pi.on("session_compact", async (event) => {
		if (event.reason === "overflow") {
			overflowCompactionPending = false;
			overflowCompacted = true;
		}
	});

	pi.on("context", async (event, ctx) => {
		const notes: string[] = [];

		if (overflowCompacted) {
			overflowCompacted = false;
			notes.push(
				"The conversation exceeded the model's context window and was automatically compacted. " +
					"Keep your responses concise to avoid another overflow.",
			);
		}
		if (overflowCompactionPending) {
			overflowCompactionPending = false;
			ctx.ui.notify("Overflow compaction did not complete; the request may fail again", "warning");
			notes.push(
				"The conversation exceeded the model's context window and automatic compaction did not complete. " +
					"Produce the shortest useful response, and suggest the user run /compact or switch to a larger-context model.",
			);
		}

		// Trailing provider error scan. Covers non-retryable errors (400/401)
		// and retry exhaustion (the final failed attempt stays in context).
		// Self-limiting: once a successful assistant message lands, the scan
		// stops matching, so a note is only added while the failure is fresh.
		const trailingError = findTrailingError(event.messages);
		if (trailingError) {
			notes.push(classifyError(trailingError));
		}

		if (notes.length === 0) {
			return undefined;
		}
		// Append at the end: keeps the message prefix stable for prompt caching.
		return { messages: [...event.messages, ...notes.map(makeNote)] };
	});
}
