"""Owned SFU resources, bounded requests and resumable cleanup."""

import asyncio
import json
import re
from urllib.parse import quote

from workers import fetch

from server.http import ApiError


class Realtime:
    def __init__(self, env, resources, save, measure):
        self.env, self.resources, self.save, self.measure = env, resources, save, measure
        self.last_reply = {}

    async def request(self, path, body=None, method="POST"):
        self.last_reply = {}
        try:
            async with asyncio.timeout(15):
                response = await fetch(
                    f"https://rtc.live.cloudflare.com/v1/apps/{quote(str(self.env.REALTIME_APP_ID), safe='')}{path}",
                    method=method,
                    headers={
                        "Authorization": f"Bearer {self.env.REALTIME_AUTH_TOKEN}",
                        "Content-Type": "application/json",
                    },
                    body=json.dumps(body) if body is not None else None,
                )
                status = response.status
                self.last_reply = {"http_status": int(status)}
                data = await response.json()
                if not isinstance(data, dict):
                    raise ApiError("sfu_request_failed", 502)
                self.last_reply.update(self.close_result_summary(data))
                # Preserve batch items even when the batch has an error. They
                # can describe resources created or closed before that error.
                if (not 200 <= status < 300 or data.get("errorCode")) and not isinstance(
                    data.get("tracks"), list
                ):
                    raise ApiError("sfu_request_failed", 502)
                return data
        except ApiError:
            raise
        except Exception:
            raise ApiError("sfu_unavailable", 502) from None

    async def track_request(self, path, body, method="POST"):
        data = await self.request(path, body, method)
        # Record every returned mid before inspecting item failures. HTTP 200
        # can still contain partial success and those tracks remain ours.
        for track in data.get("tracks", []):
            if track.get("mid") is not None:
                mid = str(track["mid"])
                if mid not in self.resources["mids"]:
                    self.resources["mids"].append(mid)
        await self.save()
        if (
            data.get("errorCode")
            or not data.get("tracks")
            or any(t.get("errorCode") for t in data["tracks"])
        ):
            raise ApiError("sfu_track_failed", 502)
        return data

    async def publish(self, call_id, description, mid):
        with self.measure("sfu_session", "Create media session"):
            result = await self.request("/sessions/new")
        session_id = result.get("sessionId")
        if not isinstance(session_id, str):
            raise ApiError("sfu_session_failed", 502)
        self.resources.update(session_id=session_id, mids=[mid], track_name=f"user-{call_id}")
        await self.save()
        with self.measure("sfu_publish", "Publish microphone"):
            return await self.track_request(
                f"/sessions/{session_id}/tracks/new",
                {
                    "sessionDescription": description,
                    "tracks": [
                        {"location": "local", "mid": mid, "trackName": self.resources["track_name"]}
                    ],
                },
            )

    async def attach(self, call_id, endpoints):
        output_name = f"agent-{call_id}"
        requested = [
            {
                "location": "local",
                "trackName": output_name,
                "endpoint": endpoints["output"],
                "inputCodec": "pcm",
            },
            {
                "location": "remote",
                "sessionId": self.resources["session_id"],
                "trackName": self.resources["track_name"],
                "endpoint": endpoints["input"],
                "outputCodec": "pcm",
            },
        ]
        with self.measure("sfu_adapters", "Connect assistant audio streams"):
            data = await self.request("/adapters/websocket/new", {"tracks": requested})
        tracks = data.get("tracks", [])
        # A batch can allocate either adapter before the other one fails.
        for item in tracks:
            if item.get("adapterId"):
                self.resources["adapters"].append(item["adapterId"])
        await self.save()
        by_name = {item.get("trackName"): item for item in tracks}
        if (
            data.get("errorCode")
            or len(tracks) != len(requested)
            or any(item.get("errorCode") or not item.get("adapterId") for item in tracks)
            or set(by_name) != {item["trackName"] for item in requested}
        ):
            raise ApiError("sfu_adapter_failed", 502)
        output = by_name[output_name]
        if not output.get("sessionId"):
            raise ApiError("sfu_agent_track_failed", 502)
        self.resources["agent_track"] = {key: output[key] for key in ("sessionId", "trackName")}
        await self.save()

    async def subscribe(self):
        with self.measure("sfu_subscribe", "Subscribe to assistant"):
            return await self.track_request(
                f"/sessions/{self.resources['session_id']}/tracks/new",
                {
                    "tracks": [{"location": "remote", **self.resources["agent_track"]}],
                },
            )

    async def renegotiate(self, description):
        with self.measure("sfu_renegotiate", "Finish media negotiation"):
            return await self.request(
                f"/sessions/{self.resources['session_id']}/renegotiate",
                {
                    "sessionDescription": description,
                },
                "PUT",
            )

    async def cleanup(self):
        """Retain unresolved resources so an alarm can retry after a restart."""
        adapters = list(self.resources.get("adapters", []))
        self.resources["cleanup_replies"] = {}
        if adapters:
            try:
                data = await self.request(
                    "/adapters/websocket/close",
                    {
                        "tracks": [{"adapterId": value} for value in adapters],
                    },
                )
                # GA close is idempotent: an already closed adapter is an
                # ordinary successful item. bytesProcessed is optional.
                closed = {
                    item.get("adapterId")
                    for item in data.get("tracks", [])
                    if not item.get("errorCode")
                }
                self.resources["adapters"] = [value for value in adapters if value not in closed]
            except ApiError:
                pass
            self.resources["cleanup_replies"]["adapters"] = self.last_reply
            await self.save()
        mids = list(self.resources.get("mids", []))
        if self.resources.get("session_id") and mids:
            try:
                data = await self.request(
                    f"/sessions/{self.resources['session_id']}/tracks/close",
                    {
                        "force": True,
                        "tracks": [{"mid": mid} for mid in mids],
                    },
                    "PUT",
                )
                closed = {
                    str(item.get("mid"))
                    for item in data.get("tracks", [])
                    if not item.get("errorCode") or item.get("errorCode") == "close_track_error"
                }
                self.resources["mids"] = [mid for mid in mids if mid not in closed]
            except ApiError:
                pass
            if (
                self.last_reply.get("http_status") == 410
                and self.last_reply.get("error_code") == "session_error"
            ):
                # The session is closed or gone, so its mids cannot be closed
                # again. Adapter cleanup has its own results and lifetime.
                self.resources["mids"] = []
            self.resources["cleanup_replies"]["tracks"] = self.last_reply
            await self.save()
        return not self.resources.get("adapters") and not self.resources.get("mids")

    @staticmethod
    def close_result_summary(data):
        """Keep codes and matched mids for troubleshooting, never SDP or endpoints."""

        def code(value):
            return (
                value
                if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_]{1,80}", value)
                else None
            )

        return {
            "error_code": code(data.get("errorCode")),
            "items": [
                {
                    "mid": code(str(item["mid"])) if item.get("mid") is not None else None,
                    "adapter_id": code(item.get("adapterId")),
                    "error_code": code(item.get("errorCode")),
                }
                for item in data.get("tracks", [])[:4]
                if isinstance(item, dict)
            ],
        }
