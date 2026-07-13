// Minimal type stubs for @earendil-works/pi-coding-agent used by pi-error-advisor.
// Only the members actually referenced are declared. At runtime under Pi, the
// real package provides these; the stub exists so `tsc --noEmit` and vitest can
// run standalone without the full coding-agent as a dev dependency.
//
// Critical: this stub must mirror the real package, never be extended to make
// the implementation compile. `pi-error-advisor` code must be written against the
// real API surface (verified via the installed coding-agent package's d.ts) and
// the stub narrowed to match — never the other way around.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Mirrors coding-agent's BashExecutionMessage. */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

/** Mirrors coding-agent's CustomMessage. */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

/** Mirrors coding-agent's BranchSummaryMessage. */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

/** Mirrors coding-agent's CompactionSummaryMessage. */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Replicate coding-agent's declaration merging so AgentMessage includes the
// custom roles — identical to what the real package declares.
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

export interface ExtensionUIContext {
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ModelInfo {
	provider: string;
	id: string;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	cwd: string;
	/** Current model (may be undefined). Mirrors real ExtensionContext.model. */
	model?: ModelInfo;
}

export interface CommandEndEvent {
	type: "command_end";
	name: string;
	args: string;
	error?: string;
}

export interface ExtensionAPI {
	on(
		event: "context",
		handler: (
			event: ContextEvent,
			ctx: ExtensionContext,
		) => Promise<ContextEventResult | undefined>,
	): void;
	on(
		event: "session_before_compact",
		handler: (
			event: SessionBeforeCompactEvent,
			ctx: ExtensionContext,
		) => Promise<unknown>,
	): void;
	on(
		event: "session_compact",
		handler: (
			event: SessionCompactEvent,
			ctx: ExtensionContext,
		) => Promise<unknown>,
	): void;
	on(
		event: "command_end",
		handler: (
			event: CommandEndEvent,
			ctx: ExtensionContext,
		) => Promise<unknown>,
	): void;
}
