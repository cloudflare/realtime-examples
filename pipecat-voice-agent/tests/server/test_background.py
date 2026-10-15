import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from agent.config import AgentConfig
from agent.engine import VoiceEngine


async def test_wait_until_resolves_for_cancelled_and_failed_tasks():
    handed = []
    ctx = SimpleNamespace(waitUntil=handed.append)
    engine = VoiceEngine(ctx, None, AgentConfig(), Mock(), lambda: True, call_id="b", owner_id="a")
    engine.active = True

    async def broken():
        raise RuntimeError("provider failed")

    sleeping = engine.background(asyncio.sleep(10), "test-sleep")
    failing = engine.background(broken(), "test-broken")
    await asyncio.sleep(0)
    sleeping.cancel()
    await asyncio.gather(sleeping, failing, return_exceptions=True)
    # The test double for create_proxy keeps the wrapped future as `task`.
    assert [proxy.task.result() for proxy in handed] == [None, None]
    # Cancellation is a normal exit; only the failure ends the call.
    engine.on_stop.assert_called_once_with("test-broken")
