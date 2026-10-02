# Sun & Moon Data

Use `/app/skills/sun-moon/sun-moon.py` to get accurate civil twilight, sunrise, sunset, moonrise, moonset, moon phase, and upcoming full/new moon dates.

## Usage

```bash
python3 /app/skills/sun-moon/sun-moon.py "35.046583,-106.483972"   # preferred
python3 /app/skills/sun-moon/sun-moon.py "87123"
python3 /app/skills/sun-moon/sun-moon.py "Denver" --date 2026-12-25
```

Accepts `lat,lon`, a US ZIP code, or a city name. **Coordinates are preferred** — they are exact and need no network call. A ZIP or city name is geocoded first, which is the only step that can fail.

Options:
- `--tz America/Denver` — IANA timezone. Defaults to the geocoded zone, then the container's `TZ`.
- `--date YYYY-MM-DD` — any date, past or future. Defaults to today.

For travel, pass the new location as the argument. Nothing is cached or stored, so each run stands alone — there is no location to reset afterwards.

## Output

Returns, in local time:
- Morning civil twilight begin / Evening civil twilight end
- Sunrise / Sunset
- Moonrise / Moonset
- Moon illumination % and current phase name
- Next New Moon and Next Full Moon dates + days away

A dash (`—`) means the event genuinely does not occur on that date. This is normal: the moon skips a rise or set roughly once a month, and at high latitudes the sun can stay up or down all day.

## Data source

Everything is computed locally with `ephem` (libastro, the XEphem engine). There is no almanac API to be down. Geocoding a ZIP or city name uses Open-Meteo (`geocoding-api.open-meteo.com`) — free, no key.

## Notes

- Check the `📍` line in the output. Geocoding matches fuzzily, so a typo'd place name can silently resolve to a real location somewhere else in the world. Coordinates avoid this entirely.
- Times are rounded to the nearest minute and computed at sea level, matching standard almanac convention.
- Run this script for ALL sun, moon, and twilight data — do not use almanac.com or other web scraping, and do not fall back to wttr.in for sun/moon fields.
