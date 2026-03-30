#!/usr/bin/env python3
"""
nws-hourly.py — Hourly weather forecast from NWS API for NanoClaw weather reports.
Free, no API key required. Covers from the current hour through midnight local time.

Usage:
  python3 nws-hourly.py "87123"
  python3 nws-hourly.py "Albuquerque"
  python3 nws-hourly.py  # prompts for input
"""

import sys
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

# NWS requires a descriptive User-Agent
NWS_HEADERS = {"User-Agent": "NanoClaw weather agent (nanoclaw/1.0)"}


def get_location(query: str) -> dict:
    """Geocode a US ZIP code or city name via Open-Meteo (free, no key)."""
    url = "https://geocoding-api.open-meteo.com/v1/search"
    resp = requests.get(
        url,
        params={"name": query, "count": 1, "language": "en", "format": "json"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("results"):
        raise ValueError(f"Location not found for '{query}'.")
    loc = data["results"][0]
    name = loc.get("name", query)
    state = loc.get("admin1", "")
    return {
        "lat": loc["latitude"],
        "lon": loc["longitude"],
        "timezone": loc["timezone"],
        "name": f"{name}, {state}".strip(", "),
    }


def get_nws_grid(lat: float, lon: float) -> dict:
    """Resolve lat/lon to NWS grid metadata."""
    url = f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}"
    resp = requests.get(url, headers=NWS_HEADERS, timeout=10)
    resp.raise_for_status()
    props = resp.json()["properties"]
    return {
        "forecast_hourly_url": props["forecastHourly"],
        "timezone": props["timeZone"],
        "city": props.get("relativeLocation", {}).get("properties", {}).get("city", ""),
        "state": props.get("relativeLocation", {}).get("properties", {}).get("state", ""),
    }


def get_hourly_periods(url: str) -> list:
    """Fetch hourly forecast periods from NWS."""
    resp = requests.get(url, headers=NWS_HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json()["properties"]["periods"]


def format_period(period: dict, tz: ZoneInfo) -> str:
    """Format one hourly period as a single readable line."""
    start = datetime.fromisoformat(period["startTime"]).astimezone(tz)
    hour_str = start.strftime("%-I%p").lower()  # e.g. "3pm", "11am"

    temp = period["temperature"]
    short = period["shortForecast"]

    wind_dir = period.get("windDirection", "")
    wind_speed = period.get("windSpeed", "")  # NWS returns "10 mph" or "5 to 10 mph"

    precip_obj = period.get("probabilityOfPrecipitation") or {}
    precip = precip_obj.get("value") or 0

    return (
        f"  {hour_str:>4}  {temp:>3}°F  {short:<26}  "
        f"Wind: {wind_dir} {wind_speed:<14}  Rain: {int(precip):>3}%"
    )


def main():
    if len(sys.argv) > 1:
        query = sys.argv[1].strip()
    else:
        query = input("Enter city name or US ZIP code: ").strip()

    # Step 1: Geocode
    loc = get_location(query)

    # Step 2: Resolve to NWS grid
    try:
        grid = get_nws_grid(loc["lat"], loc["lon"])
    except requests.HTTPError as e:
        # NWS only covers the US — surface a clear error
        raise RuntimeError(
            f"NWS grid lookup failed for {loc['name']} "
            f"({loc['lat']:.4f}, {loc['lon']:.4f}): {e}"
        ) from e

    # Use NWS's own timezone for the forecast area (most accurate)
    tz = ZoneInfo(grid["timezone"])
    now = datetime.now(tz)
    current_hour_start = now.replace(minute=0, second=0, microsecond=0)
    midnight = now.replace(hour=23, minute=59, second=59, microsecond=0)

    # Prefer NWS city/state if available (matches the actual forecast zone)
    display_name = (
        f"{grid['city']}, {grid['state']}"
        if grid["city"] and grid["state"]
        else loc["name"]
    )

    # Step 3: Fetch and filter hourly periods
    periods = get_hourly_periods(grid["forecast_hourly_url"])

    print(f"\nHOURLY FORECAST — {display_name} — {now.strftime('%a %b %-d')}\n")

    count = 0
    for period in periods:
        start = datetime.fromisoformat(period["startTime"]).astimezone(tz)
        if start < current_hour_start:
            continue
        if start > midnight:
            break
        print(format_period(period, tz))
        count += 1

    if count == 0:
        print("  No hourly data available for the remainder of today.")

    print(f"\n  Source: National Weather Service (api.weather.gov)")


if __name__ == "__main__":
    main()
