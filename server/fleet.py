"""Fleet management and interchangeable ephemeris implementations."""

import numpy as np
from sgp4.api import Satrec

from .domain import DomainError, Spacecraft
from .orbits import A
from .orbits import positions as orbital_positions


def validate_tle_pair(a: str, b: str):
    if not a.startswith("1 ") or not b.startswith("2 ") or len(a) != 69 or len(b) != 69:
        raise ValueError("TLEs need complete 69-character line 1 and line 2 pairs")
    for line in (a, b):
        checksum = sum(int(ch) if ch.isdigit() else 1 if ch == "-" else 0 for ch in line[:68]) % 10
        if not line[68].isdigit() or checksum != int(line[68]):
            raise ValueError("TLE checksum failed")
    if a[2:7] != b[2:7]:
        raise ValueError("TLE catalog IDs do not match")
    rec = Satrec.twoline2rv(a, b)
    error, _, _ = rec.sgp4(rec.jdsatepoch, rec.jdsatepochF)
    if error:
        raise ValueError(f"Invalid orbit: SGP4 code {error}")
    return rec


def parse_tle(text: str) -> list[dict]:
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    result, i = [], 0
    try:
        while i < len(lines):
            name = lines[i] if not lines[i].startswith("1 ") else f"SAT {len(result) + 1}"
            if not lines[i].startswith("1 "):
                i += 1
            a, b = lines[i : i + 2]
            rec = validate_tle_pair(a, b)
            result.append(
                Spacecraft(
                    id=f"tle-{rec.satnum}",
                    name=name.removeprefix("0 "),
                    kind="tle",
                    line1=a,
                    line2=b,
                    epoch=(rec.jdsatepoch + rec.jdsatepochF - 2440587.5) * 86400,
                ).model_dump(mode="json")
            )
            i += 2
        if not result or len(result) > 1000 or len({r["id"] for r in result}) != len(result):
            raise ValueError("Import 1–1,000 unique satellites")
    except (ValueError, IndexError) as exc:
        raise DomainError(str(exc)) from exc
    return result


class HybridEphemeris:
    name = "hybrid"

    def positions(self, spacecraft: list[dict], unix_seconds: np.ndarray) -> np.ndarray:
        times = np.atleast_1d(unix_seconds).astype(float)
        result = np.empty((len(times), len(spacecraft), 3), dtype=np.float64)
        for i, sat in enumerate(spacecraft):
            if sat["kind"] == "sampled":
                parsed = Spacecraft.model_validate(sat)
                sample_times = np.array([s.time.timestamp() for s in parsed.samples])
                if times.min() < sample_times[0] or times.max() > sample_times[-1]:
                    raise DomainError(f"{sat['name']}: ephemeris does not cover the complete timeframe")
                coords = np.array([[s.x, s.y, s.z] for s in parsed.samples])
                for axis in range(3):
                    result[:, i, axis] = np.interp(times, sample_times, coords[:, axis])
            else:
                result[:, i] = orbital_positions([sat], times)[:, 0]
        if not np.isfinite(result).all() or (np.linalg.norm(result, axis=2) <= A).any():
            raise DomainError("Propagated spacecraft positions must be finite and outside Earth")
        return result


class FleetService:
    def __init__(self, repository, ephemeris):
        self.repository, self.ephemeris = repository, ephemeris

    def state(self, spacecraft_id: str, unix_seconds: float) -> dict:
        sat = next((s for s in self.repository.fleet() if s["id"] == spacecraft_id), None)
        if sat is None:
            raise DomainError("Spacecraft not found", 404)
        position = self.ephemeris.positions([sat], np.array([unix_seconds]))[0, 0].tolist()
        return dict(
            spacecraft=sat,
            time_unix=unix_seconds,
            frame="ECEF",
            units="meters",
            position=position,
            resource_state="Configured initial planning budget; use a plan spacecraft timeline for allocations.",
        )
