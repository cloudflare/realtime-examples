import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from agent.config import AgentConfig
from agent.engine import VoiceEngine


def engine_with(handed):
    ctx = SimpleNamespace(waitUntil=handed.append)
    engine = VoiceEngine(ctx, None, AgentConfig(), Mock(), lambda: True, call_id="b", owner_id="a")
    engine.active = True
    return engine


async def test_a_cancelled_task_resolves_wait_until_quietly():
    handed = []
    engine = engine_with(handed)
    task = engine.background(asyncio.sleep(10), "test-sleep")
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    # The test double for create_proxy keeps the wrapped object as `task`.
    settled = handed[0].task
    assert settled.done() and settled.result() is None
    assert task not in engine.tasks
    engine.on_stop.assert_not_called()


async def test_a_failed_task_still_ends_the_call():
    handed = []
    engine = engine_with(handed)

    async def broken():
        raise RuntimeError("provider failed")

    task = engine.background(broken(), "test-broken")
    await asyncio.gather(task, return_exceptions=True)
    assert handed[0].task.result() is None
    engine.on_stop.assert_called_once_with("test-broken")
    assert engine.stats["errors"][-1]["stage"] == "test-broken"
