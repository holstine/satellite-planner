"""Versioned contracts shared by the UI API, MCP, providers, and stored plans.

Distances are meters, angles degrees, time offsets seconds, energy Wh, data MB.
Request energy/data costs apply to EACH spacecraft in a synchronized collection.
"""

from datetime import UTC, datetime
from itertools import pairwise
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)



class CollectionRequest(Model):
    name: str = Field(min_length=1, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    priority: int = Field(default=50, ge=1, le=100)
    enabled: bool = True
    duration_seconds: int = Field(default=30, ge=5, le=600)
    energy_wh: float = Field(default=5, ge=0, le=10000)
    data_mb: float = Field(default=50, ge=0, le=100000)
    satellites_required: int = Field(default=1, ge=1, le=8)
    collections_required: int = Field(default=1, ge=1, le=20)
    revisit_seconds: int = Field(default=60, ge=0, le=86400)
    window_start_seconds: int = Field(default=0, ge=0, le=86400)
    window_end_seconds: int | None = Field(default=None, ge=1, le=86400)
    min_elevation_deg: float = Field(default=10, ge=0, le=90)
    min_off_nadir_deg: float = Field(default=0, ge=0, le=85)
    max_off_nadir_deg: float = Field(default=45, ge=0, le=85)
    daylight_only: bool = True
    min_sun_elevation_deg: float = Field(default=0, ge=-18, le=90)
    sensor: Literal["optical", "infrared", "radar"] = "optical"
    max_cloud_cover_pct: float | None = Field(default=None, ge=0, le=100)
    max_precipitation_mm: float | None = Field(default=None, ge=0, le=1000)
    max_wind_speed_mps: float | None = Field(default=None, ge=0, le=200)

    @model_validator(mode="after")
    def valid_request(self):
        if not self.name.strip():
            raise ValueError("name cannot be blank")
        if self.min_off_nadir_deg > self.max_off_nadir_deg:
            raise ValueError("minimum off-nadir angle exceeds maximum")
        if self.window_end_seconds is not None and self.window_end_seconds <= self.window_start_seconds:
            raise ValueError("window end must follow window start")
        return self


class RequestRecord(CollectionRequest):
    id: int


class EphemerisSample(Model):
    time: datetime
    x: float
    y: float
    z: float

    @model_validator(mode="after")
    def valid_sample(self):
        if self.time.tzinfo is None:
            raise ValueError("ephemeris sample time requires a UTC offset")
        if self.x * self.x + self.y * self.y + self.z * self.z <= 6378137.0**2:
            raise ValueError("spacecraft sample must be outside Earth")
        return self


class Spacecraft(Model):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["demo", "tle", "sampled"] = "demo"
    enabled: bool = True
    epoch: float = 1789128000
    altitude_km: float = Field(default=550, ge=200, le=50000)
    inclination_deg: float = Field(default=53, ge=0, le=180)
    raan: float = 0
    phase: float = 0
    argument_of_perigee: float = 0
    eccentricity: float = Field(default=0, ge=0, lt=0.9)
    orbit_class: Literal["LEO", "MEO", "GEO", "HEO", "custom"] = "custom"
    line1: str | None = None
    line2: str | None = None
    samples: list[EphemerisSample] = Field(default_factory=list, max_length=100000)
    battery_capacity_wh: float = Field(default=500, gt=0, le=10000000)
    initial_battery_wh: float = Field(default=400, ge=0, le=10000000)
    battery_reserve_wh: float = Field(default=40, ge=0, le=10000000)
    storage_capacity_mb: float = Field(default=10000, ge=0, le=100000000)
    initial_storage_mb: float = Field(default=0, ge=0, le=100000000)
    capacity: int = Field(default=1, ge=1, le=8)
    max_off_nadir_deg: float = Field(default=60, ge=0, le=85)
    sensors: list[Literal["optical", "infrared", "radar"]] = Field(
        default_factory=lambda: ["optical", "radar"], min_length=1, max_length=3
    )

    @model_validator(mode="after")
    def valid_spacecraft(self):
        if not self.battery_reserve_wh <= self.initial_battery_wh <= self.battery_capacity_wh:
            raise ValueError("battery reserve <= initial charge <= capacity is required")
        if self.initial_storage_mb > self.storage_capacity_mb:
            raise ValueError("initial storage exceeds capacity")
        if self.kind == "demo" and (6378.137 + self.altitude_km) * (1 - self.eccentricity) <= 6378.137:
            raise ValueError("orbit perigee must remain above Earth")
        if self.kind == "tle":
            from .fleet import validate_tle_pair

            validate_tle_pair(self.line1 or "", self.line2 or "")
        if self.kind == "sampled":
            times = [s.time.timestamp() for s in self.samples]
            if len(times) < 2 or any(b <= a for a, b in pairwise(times)):
                raise ValueError("sampled ephemeris requires at least two strictly increasing times")
        return self


class FleetReplace(Model):
    spacecraft: list[Spacecraft] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({s.id for s in self.spacecraft}) != len(self.spacecraft):
            raise ValueError("spacecraft IDs must be unique")
        return self


class DemoFleet(Model):
    count: int = Field(default=100, ge=1, le=1000)
    profile: Literal["mixed", "leo"] = "mixed"
    altitude_km: float = Field(default=550, ge=200, le=2000)
    inclination_deg: float = Field(default=53, ge=0, le=180)


class TLEImport(Model):
    text: str = Field(min_length=1, max_length=1000000)


class Constraints(Model):
    optical_daylight_only: bool = True
    affected_by_weather: bool = False
    max_cloud_cover_pct: float = Field(default=50, ge=0, le=100)
    daylight_only: bool = False
    min_sun_elevation_deg: float = Field(default=0, ge=-18, le=90)
    min_elevation_deg: float = Field(default=0, ge=0, le=90)
    max_off_nadir_deg: float = Field(default=85, ge=0, le=85)
    capacity_per_satellite: int = Field(default=1, ge=1, le=8)
    cooldown_seconds: int = Field(default=10, ge=0, le=3600)
    step_seconds: int = Field(default=30, ge=5, le=300)
    validation_seconds: int = Field(default=5, ge=1, le=30)
    ephemeris_step_seconds: int = Field(default=10, ge=1, le=60)


class Scenario(Model):
    name: str = Field(default="Observation plan", min_length=1, max_length=120)
    start: datetime
    duration_seconds: int = Field(default=3600, ge=60, le=86400)
    constraints: Constraints = Field(default_factory=Constraints)
    scheduler: str = Field(default="priority-greedy", min_length=1, max_length=80)
    ephemeris_provider: str = Field(default="hybrid", min_length=1, max_length=80)

    @model_validator(mode="after")
    def valid_time(self):
        if self.start.tzinfo is None:
            raise ValueError("start requires a UTC offset or Z")
        self.start = self.start.astimezone(UTC)
        if not 1957 <= self.start.year <= 2100:
            raise ValueError("start year must be between 1957 and 2100")
        return self


class Generate(Scenario):
    count: int = Field(default=10000, ge=1, le=100000)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    south: float = Field(default=-60, ge=-90, le=90)
    north: float = Field(default=70, ge=-90, le=90)
    west: float = Field(default=-180, ge=-180, le=180)
    east: float = Field(default=180, ge=-180, le=180)
    randomize_parameters: bool = True
    replace_existing: bool = False
    randomize_weather: bool = False

    @model_validator(mode="after")
    def valid_bounds(self):
        if self.south >= self.north or self.west == self.east:
            raise ValueError("latitude bounds must increase and longitude span must be nonzero")
        return self


class BulkRequests(Model):
    requests: list[CollectionRequest] = Field(min_length=1, max_length=100000)


class ImportText(Model):
    text: str = Field(min_length=1, max_length=20000000)
    format: Literal["csv", "json"] = "csv"


class CollectionInstruction(Model):
    id: str
    collection_id: str
    request_id: int
    spacecraft_id: str
    satellite_index: int
    start: int
    end: int
    command: Literal["collect"] = "collect"
    sensor: str
    latitude: float
    longitude: float
    energy_wh: float
    data_mb: float
    battery_before_wh: float
    battery_after_wh: float
    storage_after_mb: float
    priority: int


class WeatherSeries(Model):
    key: str
    latitude: float
    longitude: float
    grid_degrees: float = 0.25
    provider: str = "open-meteo"
    fetched_at: float
    expires_at: float
    times: list[int]
    cloud_cover_pct: list[float | None]
    precipitation_mm: list[float | None]
    wind_speed_mps: list[float | None]


class WeatherSnapshot(Model):
    captured_at: float = 0
    cells: dict[str, WeatherSeries] = Field(default_factory=dict)
    request_cells: dict[int, str] = Field(default_factory=dict)
    attribution: str = "Weather data by Open-Meteo.com (CC BY 4.0); hourly model forecast, not observations."


class PlanSnapshot(Model):
    schema_version: int = 2
    scenario: Scenario
    spacecraft: list[Spacecraft]
    requests: list[RequestRecord]
    weather: WeatherSnapshot = Field(default_factory=WeatherSnapshot)
    locked_instructions: list[CollectionInstruction] = Field(default_factory=list)



class RequestDecision(Model):
    request_id: int
    name: str
    status: Literal["planned", "partial", "unplanned", "disabled"]
    reason_code: str
    explanation: str
    collections_requested: int
    collections_planned: int
    evidence: dict[str, int | float | str | list] = Field(default_factory=dict)


class PlanResult(Model):

    schema_version: int = 2
    id: str
    scenario: Scenario
    satellites: list[Spacecraft]
    instructions: list[CollectionInstruction]
    decisions: list[RequestDecision]
    counts: dict[str, int]
    elapsed_seconds: float
    sample_step: int
    sample_count: int
    target_stride: int = 6
    accuracy: str = "Sampled WGS84 geometry; approximate solar direction; deterministic heuristic allocation."
    validation: dict = Field(default_factory=dict)
    parent_plan_id: str | None = None
    changes: dict = Field(default_factory=dict)
    weather_summary: dict = Field(default_factory=dict)


class CollectionEdit(Model):
    action: Literal["add", "remove", "move"]
    collection_id: str | None = None
    request_id: int | None = None
    start_seconds: int | None = Field(default=None, ge=0, le=86400)
    spacecraft_ids: list[str] | None = Field(default=None, min_length=1, max_length=8)

    @model_validator(mode="after")
    def valid_edit(self):
        if self.action in ("remove", "move") and not self.collection_id:
            raise ValueError("remove/move requires a collection_id")
        if self.action == "add" and (
            self.request_id is None or self.start_seconds is None or not self.spacecraft_ids
        ):
            raise ValueError("add requires request_id, start_seconds and spacecraft_ids")
        if self.action == "move" and self.start_seconds is None and not self.spacecraft_ids:
            raise ValueError("move requires a new time or spacecraft")
        if self.spacecraft_ids and len(set(self.spacecraft_ids)) != len(self.spacecraft_ids):
            raise ValueError("collection spacecraft must be distinct")
        return self


class WhatIfSpec(Model):
    name: str = Field(default="What-if plan", min_length=1, max_length=120)
    mode: Literal["edit", "fill", "reschedule"] = "edit"
    request_changes: list[RequestRecord] = Field(default_factory=list, max_length=10000)
    add_requests: list[CollectionRequest] = Field(default_factory=list, max_length=10000)
    remove_request_ids: list[int] = Field(default_factory=list, max_length=10000)
    spacecraft_changes: list[Spacecraft] = Field(default_factory=list, max_length=1000)
    remove_spacecraft_ids: list[str] = Field(default_factory=list, max_length=1000)
    collections: list[CollectionEdit] = Field(default_factory=list, max_length=10000)
    scenario: Scenario | None = None
    refresh_weather_snapshot: bool = False
    save: bool = True


class WeatherRefresh(Model):
    scenario: Scenario
    plan_id: str | None = None
    max_locations: int = Field(default=500, ge=1, le=10000)
    force: bool = False


class DomainError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status
