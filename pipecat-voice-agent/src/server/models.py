from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from agent.config import AgentConfig


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CreateCall(RequestModel):
    agent: AgentConfig = Field(default_factory=AgentConfig)


class Description(RequestModel):
    type: Literal["offer", "answer"]
    sdp: str = Field(min_length=1, max_length=60000)


class Publish(RequestModel):
    sessionDescription: Description
    mid: str = Field(pattern=r"^[0-9A-Za-z_-]{1,32}$")


class Renegotiate(RequestModel):
    sessionDescription: Description
