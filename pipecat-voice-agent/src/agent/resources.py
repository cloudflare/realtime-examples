"""Server-owned context made available to Pipecat function handlers."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentResources:
    env: Any
    call_id: str
    owner_id: str
