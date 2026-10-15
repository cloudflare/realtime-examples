"""Keep an approximate spoken prefix when an untimed TTS reply is interrupted."""

import re
from dataclasses import dataclass

from pipecat.processors.aggregators.llm_context import LLMContext

DEFAULT_WORDS_PER_SECOND = 2.5
OUTPUT_DELAY_SECONDS = 0.25


@dataclass
class _Reply:
    context: LLMContext
    generation: int
    context_size: int
    text: str = ""
    sent_seconds: float = 0.0
    failed: bool = False


class SpeechHistory:
    """One active reply and a speaking-rate estimate for this call's fixed voice.

    Completed replies still use Pipecat's assistant aggregator. Interrupted
    prefixes retain the assistant role, with an application note marking the
    estimate. Adding context does not synthesize the prefix again.
    """

    def __init__(self):
        self._reply: _Reply | None = None
        self._words_per_second = DEFAULT_WORDS_PER_SECOND

    def start(self, context: LLMContext, generation: int) -> None:
        # Tool-result inference is part of the same reply.
        if self._reply is None or self._reply.generation != generation:
            self._reply = _Reply(context, generation, len(context.get_messages()))

    def set_text(self, generation: int, text: str) -> None:
        if (reply := self._reply) is not None and reply.generation == generation:
            reply.text = text

    def sent(self, generation: int, seconds: float) -> None:
        if (reply := self._reply) is not None and reply.generation == generation:
            reply.sent_seconds += seconds

    def failed(self, generation: int) -> None:
        if (reply := self._reply) is not None and reply.generation == generation:
            reply.failed = True

    def complete(self, generation: int) -> None:
        reply = self._take(generation)
        if reply is None:
            return
        # Very short clips give noisy rates. Bound adaptation so one unusual
        # reply cannot make subsequent prefixes grow implausibly fast.
        words = len(reply.text.split())
        if not reply.failed and words >= 8 and reply.sent_seconds >= 2:
            measured = min(4.0, max(1.0, words / reply.sent_seconds))
            self._words_per_second = 0.75 * self._words_per_second + 0.25 * measured

    def interrupt(self, generation: int) -> None:
        reply = self._take(generation)
        if reply is None:
            return
        seconds = max(0.0, reply.sent_seconds - OUTPUT_DELAY_SECONDS)
        word_ends = [match.end() for match in re.finditer(r"\S+", reply.text)]
        words = min(int(seconds * self._words_per_second), max(0, len(word_ends) - 1))
        prefix = reply.text[: word_ends[words - 1]] if words else ""
        reason = (
            "Speech synthesis failed before the previous assistant response finished."
            if reply.failed
            else "The user interrupted the previous assistant response."
        )
        progress = (
            "The preceding assistant message is an estimated spoken prefix; "
            "the cutoff is approximate."
            if prefix
            else "No spoken prefix could be estimated."
        )
        message = {
            "role": "user",
            "content": f"<runtime_context>\n{reason}\n{progress}\n</runtime_context>",
        }
        messages = reply.context.get_messages()
        # A final user transcript can arrive while downstream processors are
        # cancelling. Keep this note before that next spoken request, without
        # disturbing tool-call/result pairs or the initial runtime date update.
        position = next(
            (
                index
                for index in range(reply.context_size, len(messages))
                if messages[index].get("role") == "user"
                and not str(messages[index].get("content", "")).startswith("<runtime_context>")
            ),
            len(messages),
        )
        retained = [{"role": "assistant", "content": prefix}] if prefix else []
        messages[position:position] = [*retained, message]

    def _take(self, generation: int) -> _Reply | None:
        reply = self._reply
        if reply is None or reply.generation != generation:
            return None
        self._reply = None
        return reply
