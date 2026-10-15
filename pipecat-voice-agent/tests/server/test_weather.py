import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from pydantic import ValidationError

from agent.tools import build_tools
from services import weather


def forecast():
    return {
        "timezone": "America/Los_Angeles",
        "current": {
            "time": "2026-10-06T12:00",
            "interval": 900,
            "temperature_2m": 19.5,
            "apparent_temperature": 18.4,
            "relative_humidity_2m": 70,
            "weather_code": 2,
            "wind_speed_10m": 12,
            "precipitation": 0,
        },
        "current_units": {
            "temperature_2m": "°C",
            "apparent_temperature": "°C",
            "wind_speed_10m": "km/h",
            "precipitation": "mm",
        },
    }


async def test_weather_resolves_location_and_preserves_provider_units(monkeypatch):
    lookup = AsyncMock(
        side_effect=[
            {
                "results": [
                    {
                        "name": "San Francisco",
                        "admin1": "California",
                        "country": "United States",
                        "latitude": 37.7749,
                        "longitude": -122.4194,
                    }
                ]
            },
            forecast(),
        ]
    )
    monkeypatch.setattr(weather, "_get_json", lookup)
    result = await weather.current_weather(
        weather.WeatherArguments(location="San Francisco, California")
    )
    assert result["location"] == "San Francisco, California, United States"
    assert result["temperature"] == {"value": 19.5, "unit": "°C"}
    assert result["conditions"] == "partly cloudy"
    assert result["sources"] == [
        {"title": "Open-Meteo (summarized data)", "url": "https://open-meteo.com/"},
        {"title": "Weather data: CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"},
    ]
    query = parse_qs(urlparse(lookup.call_args_list[1].args[0]).query)
    assert query["latitude"] == ["37.7749"]
    assert query["longitude"] == ["-122.4194"]
    assert query["temperature_unit"] == ["celsius"]


async def test_fahrenheit_and_url_arguments_are_encoded(monkeypatch):
    lookup = AsyncMock(
        side_effect=[{"results": [{"name": "Test", "latitude": 0, "longitude": 0}]}, forecast()]
    )
    monkeypatch.setattr(weather, "_get_json", lookup)
    await weather.current_weather(
        weather.WeatherArguments(location="Test & count=999", temperature_unit="fahrenheit")
    )
    search = urlparse(lookup.call_args_list[0].args[0])
    query = parse_qs(search.query)
    assert search.hostname == "geocoding-api.open-meteo.com"
    assert query["name"] == ["Test & count=999"] and query["count"] == ["1"]
    query = parse_qs(urlparse(lookup.call_args_list[1].args[0]).query)
    assert query["temperature_unit"] == ["fahrenheit"] and query["wind_speed_unit"] == ["mph"]


async def test_unknown_location_does_not_fabricate_conditions(monkeypatch):
    monkeypatch.setattr(weather, "_get_json", AsyncMock(return_value={}))
    with pytest.raises(weather.WeatherUnavailable, match="No matching city"):
        await weather.current_weather(weather.WeatherArguments(location="Unknown"))


@pytest.mark.parametrize("status", [301, 429])
async def test_http_failure_does_not_become_weather_data(monkeypatch, status):
    fetch = AsyncMock(return_value=SimpleNamespace(status=status))
    monkeypatch.setattr(weather, "fetch", fetch)
    with pytest.raises(weather.WeatherUnavailable):
        await weather._get_json("https://api.open-meteo.com/v1/forecast")
    assert fetch.call_args.kwargs["redirect"] == "manual"


async def test_tool_returns_error_to_model_without_ending_the_call(monkeypatch):
    monkeypatch.setattr(
        "agent.tools.current_weather",
        AsyncMock(side_effect=weather.WeatherUnavailable("No matching city was found.")),
    )
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append) if tool.name == "get_current_weather")
    await tool.handler(
        SimpleNamespace(
            arguments={"location": "Unknown"}, tool_call_id="weather-1", result_callback=callback
        )
    )
    assert "error" in callback.call_args.args[0]
    assert [event["type"] for event in events] == ["tool_started", "tool_failed"]


async def test_weather_lookup_is_cancellable(monkeypatch):
    started = asyncio.Event()

    async def pending(_):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr("agent.tools.current_weather", pending)
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append) if tool.name == "get_current_weather")
    task = asyncio.create_task(
        tool.handler(
            SimpleNamespace(
                arguments={"location": "Berlin"}, tool_call_id="weather-1", result_callback=callback
            )
        )
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [event["type"] for event in events] == ["tool_started", "tool_cancelled"]
    callback.assert_not_awaited()


def test_arguments_require_an_actual_location_and_supported_unit():
    for arguments in ({"location": " "}, {"location": "Berlin", "temperature_unit": "kelvin"}):
        with pytest.raises(ValidationError):
            weather.WeatherArguments.model_validate(arguments)


def daily_forecast():
    return {
        "timezone": "Asia/Tokyo",
        "daily": {
            "time": ["2026-10-08", "2026-10-09"],
            "weather_code": [1, 61],
            "temperature_2m_min": [18, 17],
            "temperature_2m_max": [23, 22],
            "precipitation_probability_max": [5, None],
            "precipitation_sum": [0, 4],
        },
        "daily_units": {
            "temperature_2m_min": "°C",
            "temperature_2m_max": "°C",
            "precipitation_probability_max": "%",
            "precipitation_sum": "mm",
        },
    }


async def test_forecast_uses_the_destinations_daily_dates_and_keeps_missing_values(monkeypatch):
    lookup = AsyncMock(
        side_effect=[
            {"results": [{"name": "Tokyo", "latitude": 35.68, "longitude": 139.69}]},
            daily_forecast(),
        ]
    )
    monkeypatch.setattr(weather, "_get_json", lookup)
    result = await weather.weather_forecast(
        weather.ForecastArguments(location="Tokyo", start_day=1)
    )
    assert result["timezone"] == "Asia/Tokyo"
    assert len(result["days"]) == 1 and result["days"][0]["date"] == "2026-10-09"
    assert result["days"][0]["precipitation_probability"] == {"value": None, "unit": "%"}
    assert result["days"][0]["conditions"] == "rain"
    query = parse_qs(urlparse(lookup.call_args.args[0]).query)
    assert query["timezone"] == ["auto"] and query["forecast_days"] == ["2"]


async def test_forecast_rejects_incomplete_provider_columns(monkeypatch):
    payload = daily_forecast()
    payload["daily"]["temperature_2m_max"] = [23]
    monkeypatch.setattr(
        weather,
        "_get_json",
        AsyncMock(
            side_effect=[
                {"results": [{"name": "Tokyo", "latitude": 35.68, "longitude": 139.69}]},
                payload,
            ]
        ),
    )
    with pytest.raises(ValidationError):
        await weather.weather_forecast(weather.ForecastArguments(location="Tokyo"))


def test_forecast_range_cannot_exceed_the_provider_horizon():
    with pytest.raises(ValidationError):
        weather.ForecastArguments(location="Tokyo", start_day=15, days=2)
