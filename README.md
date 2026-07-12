# pi-error-advisor

Makes provider errors visible to the LLM in [Pi](https://pi.dev) — without writing anything to the session.

Pi's default behavior keeps errors UI-only: assistant error messages carry the error in the `errorMessage` field with empty content (which provider serializers drop entirely), and overflow recovery removes the error message from context before retrying. The model therefore never learns that a request failed, why compaction ran, or that retries were exhausted — it either regenerates blind or gets a dead session.

## What It Does

pi-error-advisor synthesizes a short, clearly-labeled note into the outgoing request context whenever the previous turn failed:

1. **Retry exhaustion** — after Pi's automatic retries give up on a transient provider error (rate limit, overloaded, network), the model is told the failure was infrastructure: *retry the same approach, don't change plans*, and let the user know the provider was unavailable.

2. **Non-retryable provider errors** — 400/401/422-class failures surface the error text so the model can inform the user (e.g. expired auth → suggest `/login`) or recognize that something in the conversation history is being rejected.

3. **Overflow recovery** — when the conversation exceeds the context window and Pi compacts it, the model is told to keep responses concise. If compaction *didn't complete* (failure, auth problem, nothing to compact), the model is told to produce the shortest useful response and suggest `/compact` or a larger-context model.

4. **Silence where it belongs** — user aborts (Ctrl+C during compaction or retry backoff), manual and threshold compaction, and anything after a successful assistant turn produce no notes at all.

## Why Request-Time, Not Persisted

A previous iteration of this idea injected persisted advisory messages into the session. Upstream feedback (rightly) flagged that as detrimental: transient infrastructure noise becomes permanent conversation history, flows into compaction summaries and forks, and steers the model with fabricated context.

This extension takes the opposite approach — **everything happens in the `context` hook at request time**:

- Sessions, exports, compaction summaries, forks, and resumes are byte-identical with or without the extension.
- Notes are self-limiting: they stop as soon as a successful assistant turn lands.
- Notes are appended at the end of the message list, keeping the prompt-cache prefix stable.
- Uninstalling the extension leaves zero trace in any session.

## Installation

```
# Via GitHub URL
pi install https://github.com/yeshao/pi-error-advisor

# Or run ad hoc
pi --extension path/to/pi-error-advisor/src/index.ts
```

## How It Works

### Trailing-error scan (retry exhaustion, non-retryable errors)

On every request, the `context` hook scans backwards for the last assistant message with `stopReason: "error"` that has no completed assistant message after it. The error is classified with pi-ai's own `isContextOverflow` / `isRetryableAssistantError`, and one matching note is appended:

```
[error-advisor] The previous request failed with a transient provider error after
automatic retries were exhausted: "overloaded_error". This was an infrastructure
problem, not a problem with your approach — do not change your plan because of it. …
```

The scan stops at successful or aborted assistant messages and at compaction/branch summaries, so stale errors never resurface.

### Overflow compaction tracking

The overflow-recovery path removes the error message from context before retrying, so the scan can't see it. Instead the extension pairs `session_before_compact(reason: "overflow")` with `session_compact`:

- Both fired → compaction succeeded → one-shot "conversation was compacted, keep responses concise" note on the retry request.
- Only the first fired → by the time the next request is built, the compaction must have failed → one-shot "compaction did not complete" note plus a UI warning.
- The event's abort signal clears the pending flag, so user-cancelled compactions stay silent.

(`agent_end` can't be used for failure detection — it fires *before* post-run compaction.)

## Project Structure

```
pi-error-advisor/
├── package.json          # Pi extension manifest
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   └── index.ts          # Extension entry
├── tests/
│   └── error-advisor.test.ts
└── types/
    └── pi-coding-agent.ts  # Type stubs for standalone typecheck/tests
```

## Development

```
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test
```

Tests exercise the real pi-ai error classification (`@earendil-works/pi-ai` is a dev dependency); only `@earendil-works/pi-coding-agent` is stubbed.

## Dependencies

Runtime: pi-ai's `isContextOverflow` / `isRetryableAssistantError` (provided by Pi as a peer dependency). No other runtime dependencies.

## License

MIT
