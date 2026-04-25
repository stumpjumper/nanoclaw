# NWS Hourly Forecast

Use `/container/skills/nws-hourly/nws-hourly.py` to get a true hourly weather forecast from the current hour through midnight.

## Usage

```bash
python3 /container/skills/nws-hourly/nws-hourly.py "87123"
```

Accepts a US ZIP code or city name. ZIP code is preferred — more precise.

## Output

One line per hour from now through midnight local time:

```
HOURLY FORECAST — Albuquerque, NM — Mon Mar 30

   3pm   68°F  Mostly Sunny               Wind: S 10 mph        Rain:   0%
   4pm   66°F  Partly Cloudy              Wind: SW 8 mph        Rain:   5%
   ...
  11pm   50°F  Clear                      Wind: W 5 mph         Rain:   0%
```

Fields per line: hour, temperature (°F), short forecast, wind direction + speed, precipitation probability.

## Data source

- **Geocoding**: Open-Meteo (`geocoding-api.open-meteo.com`) — free, no key
- **Forecast**: National Weather Service (`api.weather.gov`) — free, no key, US only

## Notes

- `requests` and `zoneinfo` are standard/pre-installed — no pip install needed
- NWS requires a User-Agent header; it's included in the script
- Handles DST automatically via NWS's own timezone metadata
- US locations only — NWS does not cover international addresses
