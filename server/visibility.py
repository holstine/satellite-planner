"""Indexed, vectorized opportunity search shared by generation and scheduling."""

import numpy as np
from scipy.spatial import cKDTree

from .domain import DomainError
from .orbits import B, sun_direction, target_vectors


def candidate_indices(tree, satellite, max_off_nadir):
    radius = np.linalg.norm(satellite)
    theta = min(np.deg2rad(max_off_nadir), np.arcsin(B / radius))
    gamma = np.arcsin(np.clip(radius / B * np.sin(theta), -1, 1)) - theta
    gamma = min(np.arccos(B / radius) + 0.01, gamma + 0.01)
    return tree.query_ball_point(satellite / radius, 2 * np.sin(gamma / 2))


class Opportunities:
    def __init__(self, snapshot, ephemeris, progress):
        self.snapshot, self.progress = snapshot, progress
        self.rows = [r.model_dump() for r in snapshot.requests]
        self.fleet = [s.model_dump(mode="json") for s in snapshot.spacecraft]
        self.rules = snapshot.scenario.constraints
        self.xyz, self.normals = target_vectors(self.rows)
        self.tree = cKDTree(self.xyz / np.linalg.norm(self.xyz, axis=1)[:, None])
        self.durations = np.array([r["duration_seconds"] for r in self.rows])
        self.starts = np.arange(0, snapshot.scenario.duration_seconds - 4, self.rules.step_seconds)
        self.checks = {
            int(d): np.unique(np.append(np.arange(0, d, self.rules.validation_seconds), d))
            for d in np.unique(self.durations)
        }
        offsets = np.unique(np.concatenate(list(self.checks.values()))) if self.checks else np.array([0])
        self.checkpoints = offsets[1:]
        self.times = np.unique((self.starts[:, None] + offsets).ravel())
        self.times = self.times[self.times <= snapshot.scenario.duration_seconds]
        if len(self.times) * len(self.fleet) > 5_000_000:
            raise DomainError(
                "Exceeds 5 million propagation samples; shorten timeframe or increase search/validation steps"
            )
        progress(0.01, "Propagating fleet and building spatial index")
        self.tracks = ephemeris.positions(self.fleet, snapshot.scenario.start.timestamp() + self.times)
        self.suns = sun_direction(snapshot.scenario.start.timestamp() + self.times)
        self.minimum_elevation = np.sin(
            np.deg2rad([max(r["min_elevation_deg"], self.rules.min_elevation_deg) for r in self.rows])
        )
        self.minimum_off_cos = np.cos(np.deg2rad([r["min_off_nadir_deg"] for r in self.rows]))
        self.maximum_off = np.array(
            [min(r["max_off_nadir_deg"], self.rules.max_off_nadir_deg) for r in self.rows]
        )
        self.daylight = np.array([r["daylight_only"] or self.rules.daylight_only for r in self.rows])
        self.sun_minimum = np.sin(
            np.deg2rad(
                [
                    max(
                        r["min_sun_elevation_deg"] if r["daylight_only"] else -90,
                        self.rules.min_sun_elevation_deg if self.rules.daylight_only else -90,
                    )
                    for r in self.rows
                ]
            )
        )
        self.window_start = np.array([r["window_start_seconds"] for r in self.rows])
        self.window_end = np.array(
            [
                min(
                    r["window_end_seconds"] or snapshot.scenario.duration_seconds,
                    snapshot.scenario.duration_seconds,
                )
                for r in self.rows
            ]
        )
        self.enabled = np.array([r["enabled"] for r in self.rows], dtype=bool)
        self.evidence = {
            key: np.zeros(len(self.rows), dtype=np.int64)
            for key in (
                "spatial_candidates",
                "angle_rejections",
                "daylight_rejections",
                "sensor_rejections",
                "dwell_rejections",
                "single_spacecraft_opportunities",
                "synchronized_opportunities",
                "capacity_rejections",
                "battery_rejections",
                "storage_rejections",
                "revisit_rejections",
            )
        }

    def masks(self, pool, satellite, sun, si):
        delta = satellite - self.xyz[pool]
        unit = delta / np.linalg.norm(delta, axis=1)[:, None]
        elevation = np.einsum("ij,ij->i", unit, self.normals[pool])
        off = unit @ (satellite / np.linalg.norm(satellite))
        angles = (elevation >= self.minimum_elevation[pool] - 1e-12) & (
            off <= self.minimum_off_cos[pool] + 1e-12
        )
        angles &= (
            off
            >= np.cos(np.deg2rad(np.minimum(self.maximum_off[pool], self.fleet[si]["max_off_nadir_deg"])))
            - 1e-12
        )
        sun_ok = ~self.daylight[pool] | ((self.normals[pool] @ sun) >= self.sun_minimum[pool] - 1e-12)
        return angles, sun_ok

    def scan(self):
        for ti, offset in enumerate(self.starts):
            if ti % 4 == 0:
                self.progress(
                    0.05 + 0.85 * ti / max(1, len(self.starts)),
                    f"Checking opportunities {ti + 1:,}/{len(self.starts):,}",
                )
            eligible = (
                self.enabled & (self.window_start <= offset) & (offset + self.durations <= self.window_end)
            )
            available = {}
            first = int(np.searchsorted(self.times, offset))
            for si, spacecraft in enumerate(self.fleet):
                if not spacecraft["enabled"]:
                    continue
                pool = np.asarray(
                    candidate_indices(
                        self.tree,
                        self.tracks[first, si],
                        min(float(self.maximum_off.max(initial=0)), spacecraft["max_off_nadir_deg"]),
                    ),
                    dtype=int,
                )
                pool = pool[eligible[pool]]
                if not len(pool):
                    continue
                self.evidence["spatial_candidates"][pool] += 1
                sensors = np.array([self.rows[i]["sensor"] in spacecraft["sensors"] for i in pool])
                self.evidence["sensor_rejections"][pool[~sensors]] += 1
                pool = pool[sensors]
                if not len(pool):
                    continue
                angles, daylight = self.masks(pool, self.tracks[first, si], self.suns[first], si)
                self.evidence["angle_rejections"][pool[~angles]] += 1
                self.evidence["daylight_rejections"][pool[angles & ~daylight]] += 1
                pool = pool[angles & daylight]
                for check in self.checkpoints:
                    if not len(pool):
                        break
                    # Shared validation samples are evaluated once across durations.
                    # Extra duration endpoints are conservative checks for longer requests.
                    index = int(np.searchsorted(self.times, offset + check))
                    angles, daylight = self.masks(pool, self.tracks[index, si], self.suns[index], si)
                    self.evidence["dwell_rejections"][pool[~(angles & daylight)]] += 1
                    pool = pool[angles & daylight]
                    finished = pool[self.durations[pool] == check]
                    self.evidence["single_spacecraft_opportunities"][finished] += 1
                    for target in finished:
                        available.setdefault(int(target), []).append(si)
                    pool = pool[self.durations[pool] > check]
            yield int(offset), available


def feasible_requests(snapshot, ephemeris, progress):
    opportunities = Opportunities(snapshot, ephemeris, progress)
    feasible = np.zeros(len(snapshot.requests), dtype=bool)
    for _, available in opportunities.scan():
        for ri, spacecraft in available.items():
            request = snapshot.requests[ri]
            # Initial budgets only: competition is deliberately left to scheduling.
            eligible = [
                si
                for si in spacecraft
                if snapshot.spacecraft[si].initial_battery_wh - request.energy_wh
                >= snapshot.spacecraft[si].battery_reserve_wh
                and snapshot.spacecraft[si].initial_storage_mb + request.data_mb
                <= snapshot.spacecraft[si].storage_capacity_mb
            ]
            feasible[ri] |= len(eligible) >= request.satellites_required
        opportunities.enabled[feasible] = False
    return feasible
