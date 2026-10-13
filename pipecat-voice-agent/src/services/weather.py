"""Current weather from Open-Meteo's geocoding and forecast APIs."""

import asyncio
from typing import Annotated, Literal
from urllib.parse import urlencode

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from workers import fetch

from services.http import LookupUnavailable

WEATHER_SOURCES = [
    {"title": "Open-Meteo (summarized data)", "url": "https://open-meteo.com/"},
    {"title": "Weather data: CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"},
]


class WeatherArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    location: str = Field(
        min_length=2,
        max_length=120,
        description="City name, preferably with a region or country, such as San Francisco, California.",
    )
    temperature_unit: Literal["celsius", "fahrenheit"] = "celsius"


class ForecastArguments(WeatherArguments):
    start_day: int = Field(
        default=1,
        ge=0,
        le=15,
        description="Days from today in the forecast location: 0 for today, 1 for tomorrow.",
    )
    days: int = Field(
        default=1, ge=1, le=7, description="Number of daily forecasts to return, up to seven."
    )

    @model_validator(mode="after")
    def supported_range(self):
        if self.start_day + self.days > 16:
            raise ValueError("The forecast must end within the next 16 days")
        return self


class Place(BaseModel):
    name: str
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    admin1: str = ""
    country: str = ""


class Current(BaseModel):
    time: str
    interval: int
    temperature_2m: float = Field(allow_inf_nan=False)
    apparent_temperature: float = Field(allow_inf_nan=False)
    relative_humidity_2m: float = Field(ge=0, le=100)
    weather_code: int
    wind_speed_10m: float = Field(ge=0, allow_inf_nan=False)
    precipitation: float = Field(ge=0, allow_inf_nan=False)


class Forecast(BaseModel):
    timezone: str
    current: Current
    current_units: dict[str, str]


class _Daily(BaseModel):
    time: list[str]
    weather_code: list[int | None]
    temperature_2m_min: list[FiniteFloat | None]
    temperature_2m_max: list[FiniteFloat | None]
    precipitation_probability_max: list[Annotated[FiniteFloat, Field(ge=0, le=100)] | None]
    precipitation_sum: list[Annotated[FiniteFloat, Field(ge=0)] | None]

    @model_validator(mode="after")
    def aligned_days(self):
        if any(len(values) != len(self.time) for values in self.model_dump().values()):
            raise ValueError("Forecast fields have different date ranges")
        return self


class _DailyForecast(BaseModel):
    timezone: str
    daily: _Daily
    daily_units: dict[str, str]


class WeatherUnavailable(LookupUnavailable):
    def __init__(self, message, code="weather_unavailable"):
        super().__init__(code, message)


async def _get_json(url):
    response = await fetch(
        url,
        redirect="manual",
        headers={
            "Accept": "application/json",
            "User-Agent": "realtime-pipecat-voice-agent",
        },
    )
    if response.status != 200:
        stage = "geocoding" if "geocoding-api" in url else "forecast"
        raise WeatherUnavailable(
            "The weather service is temporarily unavailable.",
            f"{stage}_http_{int(response.status)}",
        )
    data = await response.json()
    if not isinstance(data, dict) or data.get("error"):
        raise WeatherUnavailable("The weather service could not complete this lookup.")
    return data


def conditions(code):
    # WMO categories: https://open-meteo.com/en/docs#weathervariables
    if code in (0, 1, 2, 3):
        return ("clear sky", "mainly clear", "partly cloudy", "overcast")[code]
    for codes, description in (
        ((45, 48), "fog"),
        ((51, 53, 55), "drizzle"),
        ((56, 57), "freezing drizzle"),
        ((61, 63, 65), "rain"),
        ((66, 67), "freezing rain"),
        ((71, 73, 75, 77), "snow"),
        ((80, 81, 82), "rain showers"),
        ((85, 86), "snow showers"),
        ((95, 97), "thunderstorms"),
        ((96, 99), "thunderstorms with hail"),
    ):
        if code in codes:
            return description
    return "weather description unavailable"


async def _find_place(location):
    search = await _get_json(
        "https://geocoding-api.open-meteo.com/v1/search?"
        + urlencode(
            {
                "name": location,
                "count": 1,
                "language": "en",
                "format": "json",
            }
        )
    )
    if not search.get("results"):
        raise WeatherUnavailable(
            "No matching city was found. Ask for a city and country or region.",
            "location_not_found",
        )
    return Place.model_validate(search["results"][0])


def _location(place):
    return ", ".join(dict.fromkeys(x for x in (place.name, place.admin1, place.country) if x))


def _parameters(place, arguments):
    imperial = arguments.temperature_unit == "fahrenheit"
    return {
        "latitude": place.latitude,
        "longitude": place.longitude,
        "temperature_unit": arguments.temperature_unit,
        "wind_speed_unit": "mph" if imperial else "kmh",
        "precipitation_unit": "inch" if imperial else "mm",
        "timezone": "auto",
    }


async def current_weather(arguments: WeatherArguments):
    # Fixed hosts and URL-encoded search terms keep model arguments out of URL
    # routing. The lookup finishes inside Pipecat's 10-second tool deadline.
    async with asyncio.timeout(8):
        place = await _find_place(arguments.location)
        payload = await _get_json(
            "https://api.open-meteo.com/v1/forecast?"
            + urlencode(
                {
                    **_parameters(place, arguments),
                    "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation",
                    "forecast_days": 1,
                }
            )
        )
        forecast = Forecast.model_validate(payload)
        now, units = forecast.current, forecast.current_units
        return {
            "location": _location(place),
            "valid_at": now.time,
            "timezone": forecast.timezone,
            "conditions": conditions(now.weather_code),
            "temperature": {"value": now.temperature_2m, "unit": units["temperature_2m"]},
            "feels_like": {
                "value": now.apparent_temperature,
                "unit": units["apparent_temperature"],
            },
            "humidity_percent": now.relative_humidity_2m,
            "wind": {"value": now.wind_speed_10m, "unit": units["wind_speed_10m"]},
            "precipitation": {
                "value": now.precipitation,
                "unit": units["precipitation"],
                "interval_seconds": now.interval,
            },
            "sources": WEATHER_SOURCES,
            "data_type": "model-based current conditions",
        }


async def weather_forecast(arguments: ForecastArguments):
    async with asyncio.timeout(8):
        place = await _find_place(arguments.location)
        end_day = arguments.start_day + arguments.days
        payload = await _get_json(
            "https://api.open-meteo.com/v1/forecast?"
            + urlencode(
                {
                    **_parameters(place, arguments),
                    "daily": "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,precipitation_sum",
                    "forecast_days": end_day,
                }
            )
        )
        forecast = _DailyForecast.model_validate(payload)
        daily, units = forecast.daily, forecast.daily_units
        if len(daily.time) < end_day:
            raise WeatherUnavailable(
                "The service did not return the requested forecast dates.", "forecast_unavailable"
            )
        days = []
        for index in range(arguments.start_day, end_day):
            days.append(
                {
                    "date": daily.time[index],
                    "conditions": conditions(daily.weather_code[index])
                    if daily.weather_code[index] is not None
                    else None,
                    "temperature_min": {
                        "value": daily.temperature_2m_min[index],
                        "unit": units["temperature_2m_min"],
                    },
                    "temperature_max": {
                        "value": daily.temperature_2m_max[index],
                        "unit": units["temperature_2m_max"],
                    },
                    "precipitation_probability": {
                        "value": daily.precipitation_probability_max[index],
                        "unit": units["precipitation_probability_max"],
                    },
                    "precipitation": {
                        "value": daily.precipitation_sum[index],
                        "unit": units["precipitation_sum"],
                    },
                }
            )
        return {
            "location": _location(place),
            "timezone": forecast.timezone,
            "days": days,
            "sources": WEATHER_SOURCES,
            "data_type": "forecast",
        }
