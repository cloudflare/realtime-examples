"""Brief spoken fillers while lookups run. They are audio only, never history."""

import random

from pipecat.frames.frames import TTSSpeakFrame

from services.docs import DOCS_TOOL
from services.docs_page import READ_DOCS_TOOL
from services.status import STATUS_TOOL
from services.web_search import WEB_SEARCH_TOOL

# A tool result that arrives during a filler waits for it to finish before the
# next model request, so keep each phrase short.
PHRASES = {
    "get_current_weather": (
        "Let me check the weather.",
        "One sec, pulling up the weather.",
        "Checking the weather real quick.",
    ),
    "get_weather_forecast": (
        "Let me pull up the forecast.",
        "One sec, checking the forecast.",
        "Let me see what the forecast says.",
    ),
    DOCS_TOOL: (
        "Hmm, let me look that up.",
        "Let me check the docs.",
        "One sec, digging through the docs.",
    ),
    READ_DOCS_TOOL: (
        "Let me read through that page.",
        "One sec, reading that page.",
        "Let me take a closer look.",
    ),
    STATUS_TOOL: (
        "Let me check the status page.",
        "One sec, checking Cloudflare's status.",
        "Let me see if anything's going on.",
    ),
    WEB_SEARCH_TOOL: (
        "Let me search for that.",
        "Hmm, let me look that up.",
        "One sec, searching the web.",
    ),
}
GENERIC = (
    "Hmm, let me take a look at that.",
    "One sec, let me check.",
    "Let me look into that.",
)
# These answer before a filler could finish, so one would only delay the reply.
SILENT = frozenset({"get_current_time"})


class Fillers:
    """At most one filler per user turn, without repeating the previous one."""

    def __init__(self):
        self._random = random.Random()
        self._generation = None
        self._last = None

    def pick(self, generation: int, tools: list[str]) -> str | None:
        names = {name for name in tools if name not in SILENT}
        if not names or generation == self._generation:
            return None
        self._generation = generation
        phrases = PHRASES.get(names.pop(), GENERIC) if len(names) == 1 else GENERIC
        self._last = self._random.choice([phrase for phrase in phrases if phrase != self._last])
        return self._last


def speak_fillers(llm, tts, control):
    """Queue a filler when Pipecat starts a lookup batch."""
    fillers = Fillers()

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(_service, function_calls):
        # Pipecat runs this handler as a task, so the user may have started
        # another turn. The calls carry the generation that requested them.
        generation = function_calls[0].workers_generation
        text = fillers.pick(generation, [call.function_name for call in function_calls])
        if text and generation == control.generation:
            # Fillers stay out of the model context and the visible transcript.
            speech = TTSSpeakFrame(text, append_to_context=False)
            speech.workers_generation = generation
            await tts.queue_frame(speech)
