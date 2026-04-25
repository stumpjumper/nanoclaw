#!/usr/bin/env python3
"""
sun-moon.py — Sun, moon, and civil twilight data for NanoClaw weather reports.
Uses free USNO and Open-Meteo APIs. No API key required.

Usage:
  python3 sun-moon.py "Albuquerque"
  python3 sun-moon.py "87123"
  python3 sun-moon.py  # prompts for input
"""

import sys
import requests
from datetime import datetime, date
from zoneinfo import ZoneInfo


def get_location(query: str) -> dict:
    """Geocode a city name or US ZIP code via Open-Meteo (free, no key)."""
    url = "https://geocoding-api.open-meteo.com/v1/search"
    resp = requests.get(url, params={"name": query, "count": 1, "language": "en", "format": "json"}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("results"):
        raise ValueError(f"Location not found for '{query}'.")
    loc = data["results"][0]
    return {
        "lat": loc["latitude"],
        "lon": loc["longitude"],
        "timezone": loc["timezone"],
        "name": f"{loc.get('name', query)}, {loc.get('admin1', '')} {loc.get('country_code', '')}".strip(),
    }


def get_utc_offset_hours(timezone: str, target_date: date) -> float:
    """Return UTC offset in decimal hours for the given timezone on the given date (handles DST)."""
    dt = datetime(target_date.year, target_date.month, target_date.day, 12, 0, 0)
    local_dt = dt.replace(tzinfo=ZoneInfo(timezone))
    offset = local_dt.utcoffset()
    return (offset.total_seconds() / 3600) if offset else 0.0


def get_usno_daily(lat: float, lon: float, tz_hours: float, date_str: str) -> dict:
    """Fetch sunrise, sunset, civil twilight, and moon data from USNO OneDay API."""
    url = "https://aa.usno.navy.mil/api/rstt/oneday"
    resp = requests.get(url, params={"date": date_str, "coords": f"{lat},{lon}", "tz": tz_hours}, timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_moon_phases(date_str: str, nump: int = 12) -> dict:
    """Fetch upcoming primary moon phases from USNO."""
    url = "https://aa.usno.navy.mil/api/moon/phases/date"
    resp = requests.get(url, params={"date": date_str, "nump": nump}, timeout=10)
    resp.raise_for_status()
    return resp.json()


def parse_phenomena(phen_list: list) -> dict:
    """Convert a USNO phenomenon list into {name: time} dict."""
    return {item.get("phen", ""): item.get("time") for item in phen_list}


def parse_daily_data(json_data: dict) -> dict:
    """Extract sun/moon fields from USNO OneDay response (handles both response formats)."""
    if "properties" in json_data and "data" in json_data["properties"]:
        data = json_data["properties"]["data"]
    else:
        data = json_data.get("data", json_data)

    sun = parse_phenomena(data.get("sundata", []))
    moon = parse_phenomena(data.get("moondata", []))

    return {
        "civil_twilight_morning": sun.get("Begin Civil Twilight"),
        "sunrise": sun.get("Rise"),
        "sunset": sun.get("Set"),
        "civil_twilight_evening": sun.get("End Civil Twilight"),
        "moonrise": moon.get("Rise"),
        "moonset": moon.get("Set"),
        "illumination": data.get("fracillum"),
        "current_phase": data.get("curphase") or data.get("closestphase", {}).get("phase", "N/A"),
    }


def find_next_phases(phases_json: dict, today: date) -> tuple:
    """Return (next_new_moon, next_full_moon) as (date, time, days_away) tuples."""
    next_new = None
    next_full = None
    for p in phases_json.get("phasedata", []):
        try:
            p_date = date(p["year"], p["month"], p["day"])
        except (KeyError, ValueError):
            continue
        if p_date >= today:
            phase = p.get("phase", "")
            entry = (p_date, p.get("time", "00:00"), (p_date - today).days)
            if phase == "New Moon" and not next_new:
                next_new = entry
            elif phase == "Full Moon" and not next_full:
                next_full = entry
        if next_new and next_full:
            break
    return next_new, next_full


def main():
    if len(sys.argv) > 1:
        query = sys.argv[1].strip()
    else:
        query = input("Enter city name or US ZIP code: ").strip()

    today = date.today()
    date_str = today.strftime("%Y-%m-%d")

    print(f"\nFetching data for '{query}' on {date_str}...\n")

    loc = get_location(query)
    print(f"📍 {loc['name']}")
    print(f"   Coordinates: {loc['lat']:.4f}, {loc['lon']:.4f}")

    tz_hours = get_utc_offset_hours(loc["timezone"], today)
    print(f"   UTC offset: {tz_hours:+.1f} hours ({loc['timezone']})\n")

    daily = parse_daily_data(get_usno_daily(loc["lat"], loc["lon"], tz_hours, date_str))

    print("🌅 Sun & Civil Twilight")
    print(f"   Morning civil twilight: {daily['civil_twilight_morning'] or 'N/A'}")
    print(f"   Sunrise:                {daily['sunrise'] or 'N/A'}")
    print(f"   Sunset:                 {daily['sunset'] or 'N/A'}")
    print(f"   Evening civil twilight: {daily['civil_twilight_evening'] or 'N/A'}")

    print("\n🌕 Moon")
    print(f"   Moonrise:      {daily['moonrise'] or 'N/A'}")
    print(f"   Moonset:       {daily['moonset'] or 'N/A'}")
    print(f"   Illumination:  {daily['illumination'] or 'N/A'}")
    print(f"   Current phase: {daily['current_phase']}")

    next_new, next_full = find_next_phases(get_moon_phases(date_str), today)

    print("\n🔄 Upcoming Moon Phases")
    if next_new:
        print(f"   Next New Moon:  {next_new[0]} at {next_new[1]} UTC  ({next_new[2]} days away)")
    if next_full:
        print(f"   Next Full Moon: {next_full[0]} at {next_full[1]} UTC  ({next_full[2]} days away)")

    print("\n✅ All data from USNO + Open-Meteo (free, no API key).")


if __name__ == "__main__":
    main()
