"""Plan inspection and independent checks before a solver result is accepted."""

from collections import Counter, defaultdict
from itertools import pairwise

import numpy as np

from .domain import DomainError
from .orbits import sun_direction, target_vectors


def validate_plan(plan, snapshot, ephemeris):
    def require(condition, message):
        if not condition:
            raise DomainError("Solver produced an invalid plan: " + message)

    requests = {r.id: r for r in snapshot.requests}
    fleet = {s.id: s for s in snapshot.spacecraft}
    rules = snapshot.scenario.constraints
    require(
        plan.scenario == snapshot.scenario and plan.satellites == snapshot.spacecraft,
        "output changed the input snapshot",
    )
    collections, by_spacecraft, by_request = defaultdict(list), defaultdict(list), defaultdict(list)
    require(len({i.id for i in plan.instructions}) == len(plan.instructions), "duplicate instruction IDs")
    for instruction in plan.instructions:
        require(
            instruction.request_id in requests and instruction.spacecraft_id in fleet,
            "unknown request or spacecraft",
        )
        request, spacecraft = requests[instruction.request_id], fleet[instruction.spacecraft_id]
        require(request.enabled and spacecraft.enabled, "disabled input was allocated")
        require(
            0 <= instruction.satellite_index < len(snapshot.spacecraft)
            and snapshot.spacecraft[instruction.satellite_index].id == spacecraft.id,
            "incorrect spacecraft index",
        )
        require(
            instruction.end - instruction.start == request.duration_seconds, "incorrect collection duration"
        )
        require(
            max(0, request.window_start_seconds) <= instruction.start
            and instruction.end
            <= min(
                request.window_end_seconds or snapshot.scenario.duration_seconds,
                snapshot.scenario.duration_seconds,
            ),
            "collection outside time window",
        )
        require(
            instruction.sensor == request.sensor and request.sensor in spacecraft.sensors,
            "unsupported sensor",
        )
        require(
            instruction.energy_wh == request.energy_wh and instruction.data_mb == request.data_mb,
            "incorrect resource cost",
        )
        require(
            instruction.latitude == request.latitude and instruction.longitude == request.longitude,
            "incorrect collection coordinates",
        )
        collections[instruction.collection_id].append(instruction)
        by_spacecraft[instruction.spacecraft_id].append(instruction)
    for group in collections.values():
        first = group[0]
        request = requests[first.request_id]
        require(
            len(group) == request.satellites_required and len({i.spacecraft_id for i in group}) == len(group),
            "incomplete synchronized collection",
        )
        require(
            all((i.request_id, i.start, i.end) == (first.request_id, first.start, first.end) for i in group),
            "collection participants are not synchronized",
        )
        by_request[first.request_id].append(first)
    for request_id, groups in by_request.items():
        request = requests[request_id]
        ordered = sorted(groups, key=lambda i: i.start)
        require(len(ordered) <= request.collections_required, "too many collections")
        require(
            all(b.start >= a.end + request.revisit_seconds for a, b in pairwise(ordered)),
            "revisit interval violated",
        )
    geometry_samples = 0
    for spacecraft_id, items in by_spacecraft.items():
        spacecraft = fleet[spacecraft_id]
        charge, storage = spacecraft.initial_battery_wh, spacecraft.initial_storage_mb
        lanes = [0] * min(spacecraft.capacity, rules.capacity_per_satellite)
        times, target_rows = [], []
        for instruction in sorted(items, key=lambda i: i.start):
            lane = min(range(len(lanes)), key=lanes.__getitem__)
            require(lanes[lane] <= instruction.start, "spacecraft capacity/cooldown exceeded")
            lanes[lane] = instruction.end + rules.cooldown_seconds
            require(
                abs(instruction.battery_before_wh - charge) < 1e-8, "incorrect initial instruction battery"
            )
            charge -= instruction.energy_wh
            storage += instruction.data_mb
            require(
                abs(instruction.battery_after_wh - charge) < 1e-8
                and abs(instruction.storage_after_mb - storage) < 1e-8,
                "incorrect instruction resource state",
            )
            require(charge >= spacecraft.battery_reserve_wh - 1e-8, "battery reserve exceeded")
            require(storage <= spacecraft.storage_capacity_mb + 1e-8, "storage capacity exceeded")
            request = requests[instruction.request_id]
            checks = np.unique(
                np.append(
                    np.arange(instruction.start, instruction.end, rules.validation_seconds), instruction.end
                )
            )
            times.extend(checks)
            target_rows.extend([request.model_dump()] * len(checks))
        unix = snapshot.scenario.start.timestamp() + np.asarray(times)
        satellites = ephemeris.positions([spacecraft.model_dump(mode="json")], unix)[:, 0]
        xyz, normals = target_vectors(target_rows)
        delta = satellites - xyz
        unit = delta / np.linalg.norm(delta, axis=1)[:, None]
        elevations = np.sum(unit * normals, axis=1)
        nadir = np.sum(unit * satellites / np.linalg.norm(satellites, axis=1)[:, None], axis=1)
        minimum = np.sin(
            np.deg2rad([max(r["min_elevation_deg"], rules.min_elevation_deg) for r in target_rows])
        )
        max_cos = np.cos(
            np.deg2rad(
                [
                    min(r["max_off_nadir_deg"], rules.max_off_nadir_deg, spacecraft.max_off_nadir_deg)
                    for r in target_rows
                ]
            )
        )
        min_cos = np.cos(np.deg2rad([r["min_off_nadir_deg"] for r in target_rows]))
        require(
            bool(
                np.all(
                    (elevations >= minimum - 1e-10) & (nadir >= max_cos - 1e-10) & (nadir <= min_cos + 1e-10)
                )
            ),
            "pointing constraint failed",
        )
        sunlight = np.sum(normals * sun_direction(unix), axis=1)
        thresholds = np.sin(
            np.deg2rad(
                [
                    max(
                        r["min_sun_elevation_deg"] if r["daylight_only"] else -90,
                        rules.min_sun_elevation_deg if rules.daylight_only else -90,
                    )
                    for r in target_rows
                ]
            )
        )
        require(bool(np.all(sunlight >= thresholds - 1e-10)), "daylight constraint failed")
        geometry_samples += len(times)
    require(
        len(plan.decisions) == len(requests) and {d.request_id for d in plan.decisions} == set(requests),
        "missing or duplicate request decisions",
    )
    for decision in plan.decisions:
        count = len(by_request[decision.request_id])
        request = requests[decision.request_id]
        expected = (
            "disabled"
            if not request.enabled
            else "planned"
            if count == request.collections_required
            else "partial"
            if count
            else "unplanned"
        )
        require(
            decision.collections_planned == count
            and decision.collections_requested == request.collections_required
            and decision.status == expected,
            "decision does not match instructions",
        )
    return dict(
        passed=True,
        instructions_checked=len(plan.instructions),
        collections_checked=len(collections),
        geometry_samples=geometry_samples,
        checks=[
            "membership",
            "time_windows",
            "duration",
            "synchronized_spacecraft",
            "revisit",
            "capacity",
            "cooldown",
            "battery",
            "storage",
            "sensors",
            "sampled_angles",
            "sampled_daylight",
            "decisions",
        ],
    )


class PlanService:
    def __init__(self, repository):
        self.repository = repository

    def explain(self, plan_id, request_id):
        result = self.repository.decision(plan_id, request_id)
        result["collections"] = self.repository.plan_instructions(plan_id, request_id=request_id, limit=1000)[
            "items"
        ]
        result["scope"] = (
            "Evidence from this saved plan and its sampled search, not proof that no better schedule exists."
        )
        return result

    def summary(self, plan_id):
        result = self.repository.get_plan(plan_id)
        decisions = self.repository.plan_decisions(plan_id, limit=100000)["items"]
        result["reasons"] = dict(Counter(d["reason_code"] for d in decisions))
        return result

    def spacecraft_timeline(self, plan_id, spacecraft_id, offset=0, limit=100):
        plan = self.repository.get_plan(plan_id)
        spacecraft = next((s for s in plan["satellites"] if s["id"] == spacecraft_id), None)
        if spacecraft is None:
            raise DomainError("Spacecraft not found in plan", 404)
        instructions = self.repository.plan_instructions(
            plan_id, spacecraft_id=spacecraft_id, offset=offset, limit=limit
        )
        all_items = self.repository.plan_instructions(plan_id, spacecraft_id=spacecraft_id, limit=100000)[
            "items"
        ]
        return dict(
            spacecraft=spacecraft,
            **instructions,
            remaining_battery_wh=spacecraft["initial_battery_wh"] - sum(i["energy_wh"] for i in all_items),
            storage_used_mb=spacecraft["initial_storage_mb"] + sum(i["data_mb"] for i in all_items),
        )
