from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator

class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

class Target(Model):
    name: str = Field(min_length=1, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    priority: int = Field(default=1, ge=1, le=100)
    enabled: bool = True

class Constraints(Model):
    daylight_only: bool = True
    min_sun_elevation_deg: float = Field(default=0, ge=-18, le=90)
    min_elevation_deg: float = Field(default=10, ge=0, le=90)
    max_off_nadir_deg: float = Field(default=45, ge=0, le=85)
    capacity_per_satellite: int = Field(default=1, ge=1, le=8)
    observe_target_once: bool = True
    dwell_seconds: int = Field(default=30, ge=5, le=600)
    cooldown_seconds: int = Field(default=10, ge=0, le=3600)
    step_seconds: int = Field(default=30, ge=5, le=300)
    validation_seconds: int = Field(default=5, ge=1, le=30)

class Scenario(Model):
    start: datetime
    duration_seconds: int = Field(default=3600, ge=60, le=86400)
    constraints: Constraints = Field(default_factory=Constraints)

    @model_validator(mode='after')
    def validate_time(self):
        if self.start.tzinfo is None:
            raise ValueError('start must include UTC offset or Z')
        self.start = self.start.astimezone(timezone.utc)
        if not 1957 <= self.start.year <= 2100:
            raise ValueError('start year must be between 1957 and 2100')
        if self.constraints.dwell_seconds > self.duration_seconds:
            raise ValueError('dwell must fit inside the timeframe')
        return self

class Generate(Scenario):
    count: int = Field(default=10000, ge=1, le=100000)
    seed: int = Field(default=42, ge=0, le=2**32-1)
    south: float = Field(default=-60, ge=-90, le=90)
    north: float = Field(default=70, ge=-90, le=90)
    west: float = Field(default=-180, ge=-180, le=180)
    east: float = Field(default=180, ge=-180, le=180)
    feasible_only: bool = True

    @model_validator(mode='after')
    def bounds(self):
        if self.south >= self.north or self.west == self.east:
            raise ValueError('latitude bounds must increase; longitude span must be nonzero')
        return self

class Bulk(Model):
    targets: list[Target] = Field(min_length=1, max_length=100000)

class ImportText(Model):
    text: str = Field(min_length=1, max_length=20_000_000)
    format: Literal['csv', 'json'] = 'csv'

class DemoFleet(Model):
    count: int = Field(default=100, ge=1, le=1000)
    altitude_km: float = Field(default=550, ge=200, le=2000)
    inclination_deg: float = Field(default=53, ge=0, le=180)

class TLEImport(Model):
    text: str = Field(min_length=1, max_length=1_000_000)
