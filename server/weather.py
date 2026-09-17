"""Cached real model weather, captured with plans; never fetched inside a solve."""

import math
import os
import time
from datetime import timedelta

import httpx
import numpy as np

from .domain import DomainError, WeatherSeries, WeatherSnapshot

FIELDS = ("cloud_cover_pct", "precipitation_mm", "wind_speed_mps")
LIMITS = ("max_cloud_cover_pct", "max_precipitation_mm", "max_wind_speed_mps")
GRID = 0.25


def location(request, scenario):
    # Explicit quarter-degree cells; do not imply target-scale weather accuracy.
    lat = min(89.875, max(-89.875, math.floor((request.latitude + 90) / GRID) * GRID - 90 + GRID / 2))
    lon = math.floor(((request.longitude + 180) % 360) / GRID) * GRID - 180 + GRID / 2
    start = scenario.start.date()
    end = (scenario.start + timedelta(seconds=scenario.duration_seconds + 3600)).date()
    return f"open-meteo:{lat:.3f}:{lon:.3f}:{start}:{end}", lat, lon, str(start), str(end)


class OpenMeteoProvider:
    name = "open-meteo"

    def fetch(self, locations):
        if not locations:
            return []
        endpoint = os.environ.get("ORBIT_WEATHER_URL", "https://api.open-meteo.com/v1/forecast")
        params = dict(
            latitude=",".join(str(p[1]) for p in locations),
            longitude=",".join(str(p[2]) for p in locations),
            start_date=locations[0][3],
            end_date=locations[0][4],
            timezone="UTC",
            timeformat="unixtime",
            hourly="cloud_cover,precipitation,wind_speed_10m",
            wind_speed_unit="ms",
            precipitation_unit="mm",
        )
        if os.environ.get("ORBIT_WEATHER_API_KEY"):
            params["apikey"] = os.environ["ORBIT_WEATHER_API_KEY"]
        try:
            response = httpx.get(endpoint, params=params, timeout=20)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Avoid including an API key from the request URL in errors.
            raise DomainError(
                "Weather provider unavailable or timeframe unsupported; cached data is retained.", 502
            ) from exc
        entries = data if isinstance(data, list) else [data]
        if len(entries) != len(locations):
            raise DomainError("Weather provider returned an incomplete batch", 502)
        now = time.time()
        cells = []
        for pos, entry in zip(locations, entries, strict=True):
            hourly = entry.get("hourly", {})
            times = hourly.get("time", [])
            columns = [hourly.get(field, []) for field in ("cloud_cover", "precipitation", "wind_speed_10m")]
            if (
                not times
                or any(len(c) != len(times) for c in columns)
                or any(b - a != 3600 for a, b in zip(times, times[1:], strict=False))
            ):
                raise DomainError("Weather provider returned invalid hourly samples", 502)
            for index, values in enumerate(columns):
                if any(
                    v is not None and (not math.isfinite(v) or v < 0 or (index == 0 and v > 100))
                    for v in values
                ):
                    raise DomainError("Weather provider returned invalid weather values", 502)
            cells.append(
                WeatherSeries(
                    key=pos[0],
                    latitude=pos[1],
                    longitude=pos[2],
                    fetched_at=now,
                    expires_at=now + 3600,
                    times=times,
                    **dict(zip(FIELDS, columns, strict=True)),
                ).model_dump()
            )
        return cells


class WeatherService:
    def __init__(self, repository, provider=None):
        self.repository = repository
        self.provider = provider or OpenMeteoProvider()

    def capture(self, snapshot):
        locations = {r.id: location(r, snapshot.scenario) for r in snapshot.requests}
        cached = self.repository.weather_cells([p[0] for p in locations.values()])
        now = time.time()
        cells = {
            key: WeatherSeries.model_validate(value)
            for key, value in cached.items()
            if value["expires_at"] >= now
        }
        return WeatherSnapshot(
            captured_at=now, cells=cells, request_cells={rid: pos[0] for rid, pos in locations.items()}
        )

    def refresh(self, snapshot, spec, progress):
        locations = {
            location(r, snapshot.scenario)[0]: location(r, snapshot.scenario)
            for r in snapshot.requests
            if r.enabled
        }
        cached = self.repository.weather_cells(list(locations))
        pending = [
            p
            for key, p in locations.items()
            if spec.force or key not in cached or cached[key]["expires_at"] < time.time()
        ]
        selected = pending[: spec.max_locations]
        fetched = 0
        # Budget by location, not HTTP calls. The public provider charges multi-location requests.
        # Cache a rolling minute of calls so consecutive refresh jobs respect that budget.
        for start in range(0, len(selected), 50):
            batch = selected[start : start + 50]
            while True:
                now = time.time()
                usage = [v for v in self.repository.get_setting("weather_usage", []) if now - v < 86400]
                if len(usage) + len(batch) > 9900 or sum(now - v < 3600 for v in usage) + len(batch) > 4900:
                    raise DomainError(
                        "Weather provider hourly/daily budget reached; completed batches remain cached. Try later.",
                        429,
                    )
                if sum(now - v < 60 for v in usage) + len(batch) <= 550:
                    break
                progress(
                    fetched / max(1, len(selected)),
                    "Waiting for weather provider rate budget; completed batches are cached",
                )
                time.sleep(0.5)
            progress(
                fetched / max(1, len(selected)),
                f"Fetching model weather {fetched:,}/{len(selected):,} locations",
            )
            self.repository.set_setting("weather_usage", usage + [time.time()] * len(batch))
            self.repository.save_weather_cells(self.provider.fetch(batch))
            fetched += len(batch)
        return dict(
            fetched=fetched,
            locations=len(locations),
            remaining=max(0, len(pending) - fetched),
            note="Hourly model weather cached for one hour; refresh again if locations remain.",
        )


class WeatherEvaluator:
    """Vectorized request/start lookup. Conservative hourly brackets cover full dwell."""

    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.limits = np.array(
            [
                [getattr(r, key) if getattr(r, key) is not None else np.inf for key in LIMITS]
                for r in snapshot.requests
            ]
        ).reshape(-1, 3)
        rules = snapshot.scenario.constraints
        if not rules.affected_by_weather:
            self.limits[:] = np.inf
        else:
            for i, request in enumerate(snapshot.requests):
                if request.sensor in ("optical", "infrared"):
                    self.limits[i, 0] = min(self.limits[i, 0], rules.max_cloud_cover_pct)
        self.required = np.any(np.isfinite(self.limits), axis=1)
        self.origin = math.floor(snapshot.scenario.start.timestamp() / 3600) * 3600
        end = snapshot.scenario.start.timestamp() + snapshot.scenario.duration_seconds
        self.hours = np.arange(self.origin, math.ceil(end / 3600) * 3600 + 3601, 3600)
        self.values = np.full((len(snapshot.requests), len(self.hours), 3), np.nan)
        for ri, request in enumerate(snapshot.requests):
            key = snapshot.weather.request_cells.get(request.id)
            cell = snapshot.weather.cells.get(key)
            # A changed request location may not reuse the old weather cell.
            if (
                not cell
                or key != location(request, snapshot.scenario)[0]
                or cell.expires_at < snapshot.weather.captured_at
            ):
                continue
            by_time = {t: i for i, t in enumerate(cell.times)}
            for hi, hour in enumerate(self.hours):
                if hour in by_time:
                    for fi, field in enumerate(FIELDS):
                        value = getattr(cell, field)[by_time[hour]]
                        self.values[ri, hi, fi] = np.nan if value is None else value

    def evaluate(self, starts, ends):
        starts = np.broadcast_to(starts, (len(self.required),))
        ends = np.broadcast_to(ends, (len(self.required),))
        epoch = self.snapshot.scenario.start.timestamp()
        lo = np.floor((epoch + starts - self.origin) / 3600).astype(int)
        hi = np.ceil((epoch + ends - self.origin) / 3600).astype(int)
        missing = np.zeros(len(self.required), dtype=bool)
        rejected = np.zeros(len(self.required), dtype=bool)
        for step in range(int(np.max(hi - lo, initial=0)) + 1):
            indices = lo + step
            active = self.required & (indices <= hi)
            valid = (indices >= 0) & (indices < len(self.hours))
            missing |= active & ~valid
            rows = np.flatnonzero(active & valid)
            values = self.values[rows, indices[rows]]
            wanted = np.isfinite(self.limits[rows])
            missing[rows] |= np.any(np.isnan(values) & wanted, axis=1)
            rejected[rows] |= np.any((values > self.limits[rows]) & wanted, axis=1)
        return ~(missing | rejected), missing, rejected

    def check_collection(self, request_index, start, end):
        if not self.required[request_index]:
            return True, "weather"
        epoch = self.snapshot.scenario.start.timestamp()
        lo = math.floor((epoch + start - self.origin) / 3600)
        hi = math.ceil((epoch + end - self.origin) / 3600)
        if lo < 0 or hi >= len(self.hours):
            return False, "weather_unavailable"
        values = self.values[request_index, lo : hi + 1]
        wanted = np.isfinite(self.limits[request_index])
        if np.any(np.isnan(values[:, wanted])):
            return False, "weather_unavailable"
        return bool(np.all(values[:, wanted] <= self.limits[request_index, wanted])), "weather"


def weather_summary(snapshot):
    rules = snapshot.scenario.constraints
    required = sum(
        rules.affected_by_weather
        and (any(getattr(r, key) is not None for key in LIMITS)
             or r.sensor in ("optical", "infrared"))
        for r in snapshot.requests
    )
    return dict(
        affected_by_weather=rules.affected_by_weather,
        required_requests=required,
        cached_cells=len(snapshot.weather.cells),
        captured_at=snapshot.weather.captured_at,
        attribution=snapshot.weather.attribution,
        resolution="0.25 degree cells; hourly model weather",
    )
