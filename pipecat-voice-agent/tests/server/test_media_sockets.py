"""Adapter sockets on the standard WebSocket API, as the engine owns them."""

import asyncio
import sys
import time
import uuid
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlparse

import pytest
from conftest import Request

from agent.config import AgentConfig
from agent.engine import VoiceEngine
from transport.codec import encode_packet

CALL = "b" * 32


class AdapterSocket:
    """The server half of a WebSocketPair, with listeners the test can fire."""

    def __init__(self):
        self.readyState = 1
        self.listeners = {}
        self.closed = []

    def accept(self):
        pass

    def addEventListener(self, name, proxy):
        self.listeners[name] = proxy

    def removeEventListener(self, name, proxy):
        if self.listeners.get(name) is proxy:
            del self.listeners[name]

    def close(self, code, _reason):
        self.readyState = 3
        self.closed.append(code)

    def emit(self, name, **values):
        # The test double for create_proxy keeps the callable as `task`.
        self.listeners[name].task(SimpleNamespace(**values))


@pytest.fixture
def engine(monkeypatch):
    ctx = SimpleNamespace(waitUntil=lambda _: None)
    engine = VoiceEngine(ctx, None, AgentConfig(), Mock(), lambda: True, call_id=CALL, owner_id="a")
    engine.active = True
    engine.expires = time.time() + 60
    engine.control = SimpleNamespace(generation=0)
    engine.stats = {"input_packets": 0, "input_pcm_bytes": 0}
    # Packets carry recognizable payloads; resampling is covered elsewhere.
    engine.converter = SimpleNamespace(incoming=lambda payload: payload)
    js = SimpleNamespace(crypto=SimpleNamespace(randomUUID=lambda: str(uuid.uuid4())))
    monkeypatch.setitem(sys.modules, "js", js)
    engine.token = engine.adapter_auth.issue()
    monkeypatch.setattr(
        "agent.engine.WebSocketPair", SimpleNamespace(new=lambda: (object(), AdapterSocket()))
    )
    return engine


async def connect(engine, role):
    request = Request(f"/media/{CALL}/{role}?token={engine.token}")
    request.headers["Upgrade"] = "websocket"
    response = await engine.accept_socket(request, urlparse(request.url), role)
    assert response.status == 101
    return engine.media[role]


def packet(index):
    return encode_packet(bytes([index]) * 8, index, index * 960)


async def test_packets_reach_the_recognizer_in_arrival_order(engine):
    received = []
    first = asyncio.Event()

    async def queue_audio(pcm):
        # The first packet stalls; the rest must wait behind it, not overtake it.
        if not received:
            await first.wait()
        received.append(pcm)

    engine.pipeline_input = SimpleNamespace(queue_audio=queue_audio)
    socket = await connect(engine, "input")
    consumer = asyncio.create_task(engine.receive_audio())
    try:
        for index in range(5):
            socket.emit("message", data=packet(index))
        await asyncio.sleep(0)
        first.set()
        async with asyncio.timeout(1):
            while len(received) < 5:
                await asyncio.sleep(0)
        assert received == [bytes([index]) * 8 for index in range(5)]
        assert engine.stats["input_packets"] == 5
    finally:
        consumer.cancel()


async def test_a_full_input_queue_ends_the_call(engine):
    engine.media_input = asyncio.Queue(maxsize=2)
    socket = await connect(engine, "input")
    for index in range(3):
        socket.emit("message", data=packet(index))
    engine.on_stop.assert_called_once_with("audio_input_backlog")


async def test_text_or_misdirected_audio_ends_the_call(engine):
    socket = await connect(engine, "input")
    socket.emit("message", data="not audio")
    engine.on_stop.assert_called_once_with("adapter_protocol")


async def test_reconnects_closes_and_cleanup_release_the_listeners(engine):
    first = await connect(engine, "input")
    first.readyState = 3
    first.emit("close", code=1006)
    assert first.closed == [1000]
    assert engine.input_disconnected_at is not None

    # The adapter retries with the same credential and replaces the socket.
    second = await connect(engine, "input")
    assert first.listeners == {}
    assert engine.input_disconnected_at is None
    assert engine.sockets("input") == [second]

    output = await connect(engine, "output")
    duplicate = Request(f"/media/{CALL}/output?token={engine.token}")
    duplicate.headers["Upgrade"] = "websocket"
    refused = await engine.accept_socket(duplicate, urlparse(duplicate.url), "output")
    assert refused.status == 409
    output.readyState = 3
    output.emit("close", code=1000)
    engine.on_stop.assert_called_once_with("output_disconnected")

    await engine._finish("test_complete")
    assert second.closed == [1000]
    assert second.listeners == {} and output.listeners == {}
    assert engine.sockets() == []
