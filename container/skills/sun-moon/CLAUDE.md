# Sun & Moon Data

Use `/container/skills/sun-moon/sun-moon.py` to get accurate civil twilight, sunrise, sunset, moonrise, moonset, moon phase, and upcoming full/new moon dates.

## Usage

```bash
python3 /container/skills/sun-moon/sun-moon.py "87123"
```

Accepts a US ZIP code or city name. ZIP code is preferred — more precise, and easy to change for travel.

## Output

Returns (all local time unless noted):
- Morning civil twilight begin / Evening civil twilight end
- Sunrise / Sunset
- Moonrise / Moonset
- Moon illumination % and current phase name
- Next New Moon and Next Full Moon dates + days away (UTC)

## Data sources

- **Sun/moon data**: USNO OneDay API (`aa.usno.navy.mil`) — authoritative, free, no key
- **Geocoding**: Open-Meteo (`geocoding-api.open-meteo.com`) — free, no key

## Notes

- `requests` and `zoneinfo` are standard/pre-installed — no pip install needed in the container
- Handles DST automatically
- Run this script for ALL sun, moon, and twilight data — do not use almanac.com or other web scraping
