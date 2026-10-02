#!/usr/bin/env python3
"""
sun-moon.py — Sun, moon, and civil twilight data for NanoClaw weather reports.

Everything is computed locally with ephem (libastro). These are deterministic
astronomy, not observations, so there is no almanac API to go down: the USNO
service this used to call was unreachable for days at a time.

Coordinates run fully offline. A place name or ZIP is geocoded through
Open-Meteo first — the only step that touches the network.

Usage:
  python3 sun-moon.py "35.046583,-106.483972"                  # offline
  python3 sun-moon.py "35.046583,-106.483972" --tz America/Denver
  python3 sun-moon.py "Denver"                                 # geocoded
  python3 sun-moon.py "87123"
  python3 sun-moon.py "87123" --date 2026-12-25
  python3 sun-moon.py                                          # prompts
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import ephem

# Upper limb of the disk at the horizon, including standard refraction. The
# refraction model is switched off (pressure = 0) so the horizon value alone
# defines the event, which is the conventional rise/set definition.
HORIZON_RISE_SET = "-0:34"
HORIZON_CIVIL = "-6"

# The four quarter events, each paired with the name of the segment that
# follows it. Naming from the real events rather than a fraction of the
# lunation matters: the quarters are not evenly spaced in time.
QUARTERS = [
    (ephem.previous_new_moon, "New Moon", "Waxing Crescent"),
    (ephem.previous_first_quarter_moon, "First Quarter", "Waxing Gibbous"),
    (ephem.previous_full_moon, "Full Moon", "Waning Gibbous"),
    (ephem.previous_last_quarter_moon, "Last Quarter", "Waning Crescent"),
]

# Call it by the event name within half a day either side of the exact moment.
EXACT_PHASE_WINDOW_DAYS = 0.5


def parse_coords(query: str) -> dict | None:
    """Parse a 'lat,lon' string. Returns None if it isn't one."""
    parts = [p.strip() for p in query.split(",")]
    if len(parts) != 2:
        return None
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"Coordinates out of range: {query}")
    return {"lat": lat, "lon": lon, "timezone": None, "name": f"{lat:.4f}, {lon:.4f}"}


def geocode(query: str) -> dict:
    """Geocode a city name or US ZIP code via Open-Meteo (free, no key)."""
    import requests  # imported lazily so coordinate lookups need no network stack

    url = "https://geocoding-api.open-meteo.com/v1/search"
    resp = requests.get(
        url, params={"name": query, "count": 1, "language": "en", "format": "json"}, timeout=10
    )
    resp.raise_for_status()
    results = resp.json().get("results")
    if not results:
        raise ValueError(
            f"Location not found for '{query}'. Pass 'lat,lon' instead to skip geocoding."
        )
    loc = results[0]
    return {
        "lat": loc["latitude"],
        "lon": loc["longitude"],
        "timezone": loc.get("timezone"),
        "name": f"{loc.get('name', query)}, {loc.get('admin1', '')} {loc.get('country_code', '')}".strip(),
    }


def get_location(query: str) -> dict:
    return parse_coords(query) or geocode(query)


def resolve_tz(explicit: str | None, from_location: str | None) -> tuple:
    """Pick a timezone: --tz, then the geocoded zone, then the container's TZ."""
    for name in (explicit, from_location, os.environ.get("TZ")):
        if not name:
            continue
        try:
            return ZoneInfo(name), name
        except Exception:
            if name is explicit:
                raise ValueError(f"Unknown timezone: {name}")
    local = datetime.now().astimezone().tzinfo
    return local, str(local)


def observer(lat: float, lon: float, when_utc: datetime, horizon: str) -> ephem.Observer:
    obs = ephem.Observer()
    obs.lat, obs.lon = str(lat), str(lon)
    obs.pressure = 0  # horizon constants above already account for refraction
    obs.horizon = horizon
    obs.date = ephem.Date(when_utc)
    return obs


def find_event(
    lat: float,
    lon: float,
    body,
    kind: str,
    start_utc: datetime,
    end_utc: datetime,
    horizon: str,
    use_center: bool,
) -> datetime | None:
    """First rise/set after start_utc, or None if it falls outside the day."""
    obs = observer(lat, lon, start_utc, horizon)
    seek = obs.next_rising if kind == "rise" else obs.next_setting
    try:
        when = seek(body, use_center=use_center).datetime()
    except (ephem.AlwaysUpError, ephem.NeverUpError):
        return None
    return when if when < end_utc else None


def to_local(when_utc: datetime | None, tz) -> str:
    if when_utc is None:
        return "—"
    local = when_utc.replace(tzinfo=timezone.utc).astimezone(tz)
    return (local + timedelta(seconds=30)).strftime("%H:%M")


def moon_phase_name(when_utc: datetime) -> str:
    """Name the phase from the most recent quarter event."""
    d = ephem.Date(when_utc)
    when, exact, segment = max(
        ((finder(d), exact, segment) for finder, exact, segment in QUARTERS),
        key=lambda q: q[0],
    )
    return exact if (d - when) < EXACT_PHASE_WINDOW_DAYS else segment


def next_phase(finder, when_utc: datetime, tz, today: date) -> tuple:
    moment = finder(ephem.Date(when_utc)).datetime().replace(tzinfo=timezone.utc).astimezone(tz)
    return moment, (moment.date() - today).days


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sun, moon, and civil twilight times, computed locally."
    )
    parser.add_argument("location", nargs="?", help="'lat,lon', a city name, or a US ZIP code")
    parser.add_argument("--tz", help="IANA timezone, e.g. America/Denver (overrides the default)")
    parser.add_argument("--date", help="Target date as YYYY-MM-DD (default: today)")
    args = parser.parse_args()

    query = args.location or input("Enter 'lat,lon', a city name, or a US ZIP code: ").strip()
    if not query:
        print("No location given.", file=sys.stderr)
        return 1

    try:
        target = date.fromisoformat(args.date) if args.date else date.today()
    except ValueError:
        print(f"Bad --date '{args.date}' — expected YYYY-MM-DD.", file=sys.stderr)
        return 1

    try:
        loc = get_location(query)
        tz, tz_name = resolve_tz(args.tz, loc["timezone"])
    except Exception as exc:
        print(f"{exc}", file=sys.stderr)
        return 1

    lat, lon = loc["lat"], loc["lon"]
    start_local = datetime.combine(target, time(0, 0), tzinfo=tz)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = (start_local + timedelta(days=1)).astimezone(timezone.utc).replace(tzinfo=None)
    noon_utc = (start_local + timedelta(hours=12)).astimezone(timezone.utc).replace(tzinfo=None)

    def sun_event(kind, horizon, use_center):
        return find_event(
            lat, lon, ephem.Sun(), kind, start_utc, end_utc, horizon, use_center
        )

    def moon_event(kind):
        return find_event(
            lat, lon, ephem.Moon(), kind, start_utc, end_utc, HORIZON_RISE_SET, False
        )

    moon = ephem.Moon()
    moon.compute(observer(lat, lon, noon_utc, HORIZON_RISE_SET))

    print(f"\n📍 {loc['name']}  —  {target.isoformat()}")
    print(f"   Coordinates: {lat:.4f}, {lon:.4f}   Timezone: {tz_name}")

    print("\n🌅 Sun & Civil Twilight")
    print(f"   Morning civil twilight: {to_local(sun_event('rise', HORIZON_CIVIL, True), tz)}")
    print(f"   Sunrise:                {to_local(sun_event('rise', HORIZON_RISE_SET, False), tz)}")
    print(f"   Sunset:                 {to_local(sun_event('set', HORIZON_RISE_SET, False), tz)}")
    print(f"   Evening civil twilight: {to_local(sun_event('set', HORIZON_CIVIL, True), tz)}")

    print("\n🌕 Moon")
    print(f"   Moonrise:      {to_local(moon_event('rise'), tz)}")
    print(f"   Moonset:       {to_local(moon_event('set'), tz)}")
    print(f"   Illumination:  {moon.phase:.0f}%")
    print(f"   Current phase: {moon_phase_name(noon_utc)}")

    print("\n🔄 Upcoming Moon Phases")
    for label, finder in (("New Moon", ephem.next_new_moon), ("Full Moon", ephem.next_full_moon)):
        moment, days = next_phase(finder, noon_utc, tz, target)
        print(
            f"   Next {label}:  {moment.date()} at"
            f" {(moment + timedelta(seconds=30)).strftime('%H:%M')} local"
            f"  ({days} days away)"
        )

    print("\n✅ Computed locally with ephem — no almanac API, no key.")
    print("   A dash means the event does not occur on this date (normal for the moon).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
