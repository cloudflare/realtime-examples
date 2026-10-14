import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from conftest import Request

from agent.config import AgentConfig
from agent.engine import VoiceEngine
from server.auth_code import COOKIE, AccessCodeAuth
from server.call import VoiceCall
from server.http import ApiError

CALL = "b" * 32
BASE = f"/api/calls/{CALL}"
OFFER = {"mid": "0", "sessionDescription": {"type": "offer", "sdp": "offer"}}
ANSWER = {"sessionDescription": {"type": "answer", "sdp": "answer"}}
ENDPOINTS = {role: f"wss://voice.example/media/{CALL}/{role}" for role in ("input", "output")}


@pytest.fixture
def prepared(monkeypatch):
    """Replaces the real pipeline and speech services with a recorded prepare."""
    prepare = AsyncMock(return_value=ENDPOINTS)
    monkeypatch.setattr(VoiceEngine, "prepare", prepare)
    return prepare


@pytest.fixture
async def active_call(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    ctx.getWebSockets = lambda: []
    call.engine = VoiceEngine(
        ctx,
        env,
        AgentConfig(),
        call.request_finish,
        lambda: True,
        call_id=CALL,
        owner_id=call.state["owner"],
    )
    call.engine.active = True
    call.state["phase"] = "active"
    sfu = AsyncMock()
    sfu.cleanup.return_value = True
    call.sfu = lambda: sfu
    return call


async def test_event_poll_waits_for_changes_and_replays_from_the_cursor(active_call, owner_cookie):
    call = active_call
    async with asyncio.TaskGroup() as tasks:
        for after, text in [(0, "hello"), (1, "again")]:
            poll = tasks.create_task(
                call.fetch(Request(f"{BASE}/events?after={after}", cookie=owner_cookie))
            )
            await asyncio.sleep(0)
            assert not poll.done()
            call.engine.notify({"type": "user_transcript", "text": text})
            response = await asyncio.wait_for(poll, 1)
            assert response.status == 200
            assert [event["text"] for event in response.data["events"]] == [text]
    replay = await asyncio.wait_for(
        call.fetch(Request(BASE + "/events?after=0", cookie=owner_cookie)), 1
    )
    assert [event["text"] for event in replay.data["events"]] == ["hello", "again"]


async def test_event_poll_does_not_block_stop(active_call, owner_cookie):
    call = active_call
    async with asyncio.TaskGroup() as tasks:
        poll = tasks.create_task(call.fetch(Request(BASE + "/events", cookie=owner_cookie)))
        await asyncio.sleep(0)
        assert not poll.done()
        stopped = await asyncio.wait_for(
            call.fetch(Request(BASE + "/finish", {}, cookie=owner_cookie)), 1
        )
        assert stopped.data["cleanup_complete"]
        response = await asyncio.wait_for(poll, 1)
        assert response.data["phase"] in {"ending", "ended"}
        assert response.data["events"][-1]["type"] == "closing"


async def test_event_poll_timeout_returns_current_state(active_call, owner_cookie, monkeypatch):
    monkeypatch.setattr("server.call.EVENT_WAIT_SECONDS", 0.01)
    response = await asyncio.wait_for(
        active_call.fetch(Request(BASE + "/events", cookie=owner_cookie)), 1
    )
    assert response.status == 200
    assert response.data["phase"] == "active"
    assert response.data["events"] == []


async def test_every_call_operation_requires_its_owner(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    assert (await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))).status == 201
    intruder = f"{COOKIE}={AccessCodeAuth(env).signer().dumps('c' * 32)}"
    for action in ("status", "events", "publish", "attach", "subscribe", "renegotiate", "finish"):
        request = Request(
            BASE + "/" + action, None if action in ("status", "events") else {}, cookie=intruder
        )
        assert (await call.fetch(request)).status == 404
    assert not call.stopping


async def test_warming_needs_a_login_and_leaves_no_call_behind(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    assert (await call.fetch(Request(BASE + "/warm"))).status == 401
    warmed = await call.fetch(Request(BASE + "/warm", cookie=owner_cookie))
    assert warmed.status == 200
    assert ctx.storage.values == {}
    assert ctx.storage.alarm is None
    assert (await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))).status == 201


async def test_publish_retry_is_idempotent_and_conflicting_offer_is_rejected(
    ctx, env, owner_cookie, prepared
):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    sfu = AsyncMock()
    sfu.publish.return_value = ANSWER
    call.sfu = lambda: sfu
    body = json.loads(json.dumps(OFFER))
    first = await call.fetch(Request(BASE + "/publish", body, cookie=owner_cookie))
    second = await call.fetch(Request(BASE + "/publish", body, cookie=owner_cookie))
    assert first.data == second.data
    sfu.publish.assert_awaited_once()
    prepared.assert_awaited_once()
    body["sessionDescription"]["sdp"] = "different offer"
    assert (await call.fetch(Request(BASE + "/publish", body, cookie=owner_cookie))).status == 409


async def test_publish_prepares_the_agent_while_the_media_session_starts(
    ctx, env, owner_cookie, monkeypatch
):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    started = set()
    both = asyncio.Event()

    async def overlapping(name, value):
        started.add(name)
        if len(started) == 2:
            both.set()
        # Run one after the other, these would time out and fail the publish.
        await asyncio.wait_for(both.wait(), 1)
        return value

    async def prepare(self, origin, call_id):
        return await overlapping("agent", ENDPOINTS)

    async def publish(*_):
        return await overlapping("media", ANSWER)

    monkeypatch.setattr(VoiceEngine, "prepare", prepare)
    sfu = AsyncMock()
    sfu.publish.side_effect = publish
    call.sfu = lambda: sfu
    published = await call.fetch(Request(BASE + "/publish", OFFER, cookie=owner_cookie))
    assert published.status == 200
    assert published.data["sessionDescription"] == ANSWER["sessionDescription"]
    assert "agent_prepare" in [row["operation"] for row in published.data["timings"]]
    assert call.state["phase"] == "published"
    attached = await call.fetch(Request(BASE + "/attach", {}, cookie=owner_cookie))
    assert attached.data["attached"]
    sfu.attach.assert_awaited_once_with(CALL, ENDPOINTS)
    assert call.endpoints is None


async def test_failed_publish_waits_for_the_agent_then_cleans_up(
    ctx, env, owner_cookie, monkeypatch
):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    prepared = asyncio.Event()

    async def prepare(self, origin, call_id):
        await asyncio.sleep(0.01)
        prepared.set()
        return ENDPOINTS

    async def finish(self, reason):
        assert prepared.is_set()
        self.cleanup_complete = True

    monkeypatch.setattr(VoiceEngine, "prepare", prepare)
    monkeypatch.setattr(VoiceEngine, "finish", finish)
    sfu = AsyncMock()
    sfu.publish.side_effect = ApiError("sfu_unavailable", 502)
    sfu.cleanup.return_value = True
    call.sfu = lambda: sfu
    response = await call.fetch(Request(BASE + "/publish", OFFER, cookie=owner_cookie))
    assert response.status == 502
    assert call.state["phase"] == "ended"
    assert call.state["finish_reason"] == "setup_failed"
    sfu.cleanup.assert_awaited_once()


async def test_a_restart_after_publish_ends_the_call(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    call.state["phase"] = "published"
    await call.save()
    restarted = VoiceCall(ctx, env)
    sfu = AsyncMock()
    sfu.cleanup.return_value = True
    restarted.sfu = lambda: sfu
    response = await restarted.fetch(Request(BASE + "/attach", {}, cookie=owner_cookie))
    assert response.status == 409
    assert restarted.state["finish_reason"] == "session_restarted"
    sfu.attach.assert_not_awaited()


async def test_cleanup_retries_owned_resources_after_a_restart(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    call.state["resources"]["adapters"] = ["owned"]
    sfu = AsyncMock()
    sfu.cleanup.return_value = False
    call.sfu = lambda: sfu
    result = await call.fetch(Request(BASE + "/finish", {}, cookie=owner_cookie))
    assert result.data["phase"] == "ending"
    assert ctx.storage.alarm is not None
    assert json.loads(ctx.storage.values["call"])["resources"]["adapters"] == ["owned"]
    restarted = VoiceCall(ctx, env)
    sfu.cleanup.return_value = True
    restarted.sfu = lambda: sfu
    await restarted.alarm()
    assert restarted.state["phase"] == "ended"
    result = await restarted.fetch(Request(BASE + "/finish", {}, cookie=owner_cookie))
    assert result.data["cleanup_complete"]
    assert sfu.cleanup.await_count == 2


async def test_owner_stop_invalidates_setup_while_waiting_for_the_lock(ctx, env, owner_cookie):
    call = VoiceCall(ctx, env)
    await call.fetch(Request(BASE + "/create", {}, cookie=owner_cookie))
    sfu = AsyncMock()
    sfu.cleanup.return_value = True
    call.sfu = lambda: sfu
    await call.lock.acquire()
    stop = asyncio.create_task(call.fetch(Request(BASE + "/finish", {}, cookie=owner_cookie)))
    await asyncio.sleep(0)
    assert call.stopping
    call.lock.release()
    assert (await stop).data["cleanup_complete"]
