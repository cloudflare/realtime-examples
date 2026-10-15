# Customize the agent

Use **Settings** before a call to change its personality. Project defaults, the system prompt, and limits live in [the server configuration](../src/agent/config.py). Keep [local preview defaults](../web/src/lib/contracts.ts) representative when changing the personality.

## Add a tool

Start with [the tool registry](../src/agent/tools.py): add a Pydantic argument model and a service function for a lookup. For a custom workflow, use a Pipecat `FunctionSchema` handler and the existing `tool_call()` wrapper. See [Pipecat's function-calling guide](https://docs.pipecat.ai/pipecat/learn/function-calling) for handler options.

Add its presentation to [the conversation registry](../web/src/voice/conversation.ts) and a [preview scenario](../web/src/preview/scenarios.ts). Extend [the event contract](../web/src/lib/contracts.ts) if the UI needs additional result metadata.

Give it short [filler phrases](../src/agent/fillers.py) to speak while it runs, or mark it silent if it answers almost instantly. Fillers are audio only and stay out of the conversation. Pipecat waits for a playing filler to finish before sending a tool result to the model, so a long phrase delays the answer.

A lookup that runs longer than half a second also gets quiet keyboard typing, which starts after its filler and stops when the reply begins. Silent tools never get it. The keystrokes are a [public-domain recording](../NOTICE.md#sounds) looped by [`thinking.py`](../src/transport/thinking.py); set its volume to 0 to turn the sound off.

Tool handlers need to account for:

- **Cancellation:** let `asyncio.CancelledError` propagate and close network resources. Cancelling a request does not undo a remote write; define idempotency before adding tools that change data.
- **Deadlines:** leave time between a service timeout and the handler timeout to return an ordinary error result. Use `@tool_options(timeout_secs=...)` when a tool needs a different deadline.
- **Ownership:** bindings and the authenticated owner are available through `params.app_resources`. A shared access code does not authorize access to another person's data.
- **Context growth:** return useful fields and excerpts rather than full API responses. Tool results stay in the conversation and add to subsequent model requests.

For a required sequence of operations, implement the sequence inside one handler. Do not rely on the model to execute every step before its tool budget or the user's turn ends.

## External services

Replacing the Cloudflare Docs MCP URL is insufficient to connect an arbitrary MCP server: it may require authentication or session negotiation. Check those requirements before reusing [the docs client](../src/services/docs.py).

Web Search has separate [payment setup](deployment.md#configure). A provider key stored under the Gateway's `default` alias takes precedence over credits. Cancelling a turn does not guarantee an issued search is unbilled. Use local fixtures for routine checks and deliberate, bounded live evaluations when changing providers.

## Models, speech, and conversation memory

Use [the model adapter contract](../src/services/models.py) when changing LLMs. Response formats, reasoning controls, and tool behavior vary by model. A successful plain-text request does not establish that function calling and history work. Reasoning can also consume a completion's budget before any spoken answer is produced.

Check [Python package compatibility](../vendor/README.md) before adding a speech service, local VAD, or a turn model. Native imports alone do not establish Workers compatibility.

The visible conversation can include generated words the listener never heard. Interrupted replies retain an estimated spoken prefix in the assistant role, followed by a short interruption note. That preserves who said it, but the cutoff can drift around pauses, numbers, or unusual words: it is based on audio sent, not confirmed browser playback. See [speech history](../src/agent/speech_history.py) for the estimate and tuning constants. Full-reply synthesis stays intact. Export before reloading or starting another call to keep the visible conversation.

When adding provider retries, preserve cancellation and the request's existing deadline. Replaying audio already sent or a turn whose tools have executed can duplicate speech or external actions.

Flux vocabulary hints bias recognition; they do not rewrite completed transcripts. Supply individual canonical names or acronyms when adjusting the keyterms in the server configuration.

For [prompt caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/), preserve stable instructions and tool definitions at the beginning of the request, and append changing context. Session affinity improves locality but does not prove a cache hit; use returned usage counters to measure it.

Long-lived agents need a policy for compaction, persistent memory, and data retention. Increasing the call-duration limit alone does not provide those capabilities, and a larger model context window does not eliminate the input cost or latency of growing history.
