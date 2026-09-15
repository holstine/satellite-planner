"""Deterministic allocation of complete synchronized collections."""

import time
from collections import Counter

import numpy as np

from .contracts import SolvedPlan
from .domain import CollectionInstruction, PlanResult, RequestDecision
from .visibility import Opportunities


class GreedyScheduler:
    name = "priority-greedy"

    def order(self, indices, requests):
        return sorted(indices, key=lambda i: (-requests[i].priority, requests[i].id))

    def solve(self, plan_id, snapshot, ephemeris, progress):
        begun = time.perf_counter()
        opportunities = Opportunities(snapshot, ephemeris, progress)
        requests, fleet, rules = snapshot.requests, snapshot.spacecraft, snapshot.scenario.constraints
        free = [np.zeros(min(rules.capacity_per_satellite, s.capacity)) for s in fleet]
        battery = np.array([s.initial_battery_wh for s in fleet])
        storage = np.array([s.initial_storage_mb for s in fleet])
        completed = np.zeros(len(requests), dtype=int)
        next_collection = np.zeros(len(requests))
        instructions = []
        evidence = opportunities.evidence
        for offset, available in opportunities.scan():
            for ri in self.order(available, requests):
                request = requests[ri]
                participants = available[ri]
                if len(participants) < request.satellites_required:
                    continue
                evidence["synchronized_opportunities"][ri] += 1
                if completed[ri] >= request.collections_required:
                    continue
                if next_collection[ri] > offset:
                    evidence["revisit_rejections"][ri] += 1
                    continue
                eligible = []
                for si in participants:
                    busy = not np.any(free[si] <= offset)
                    no_energy = battery[si] - request.energy_wh < fleet[si].battery_reserve_wh - 1e-9
                    no_storage = storage[si] + request.data_mb > fleet[si].storage_capacity_mb + 1e-9
                    evidence["capacity_rejections"][ri] += int(busy)
                    evidence["battery_rejections"][ri] += int(no_energy)
                    evidence["storage_rejections"][ri] += int(no_storage)
                    if not (busy or no_energy or no_storage):
                        eligible.append(si)
                if len(eligible) < request.satellites_required:
                    continue
                # More remaining energy first; stable fleet ID resolves ties.
                selected = sorted(eligible, key=lambda si: (-battery[si], fleet[si].id))[
                    : request.satellites_required
                ]
                collection_id = f"{request.id}:{completed[ri] + 1}"
                for si in selected:
                    lane = int(np.flatnonzero(free[si] <= offset)[0])
                    free[si][lane] = offset + request.duration_seconds + rules.cooldown_seconds
                    before = float(battery[si])
                    battery[si] -= request.energy_wh
                    storage[si] += request.data_mb
                    instructions.append(
                        CollectionInstruction(
                            id=f"{collection_id}:{fleet[si].id}",
                            collection_id=collection_id,
                            request_id=request.id,
                            spacecraft_id=fleet[si].id,
                            satellite_index=si,
                            start=offset,
                            end=offset + request.duration_seconds,
                            sensor=request.sensor,
                            latitude=request.latitude,
                            longitude=request.longitude,
                            energy_wh=request.energy_wh,
                            data_mb=request.data_mb,
                            battery_before_wh=before,
                            battery_after_wh=float(battery[si]),
                            storage_after_mb=float(storage[si]),
                            priority=request.priority,
                        )
                    )
                completed[ri] += 1
                next_collection[ri] = offset + request.duration_seconds + request.revisit_seconds
                if completed[ri] >= request.collections_required:
                    opportunities.enabled[ri] = False
        decisions = []
        for ri, request in enumerate(requests):
            ev = {key: int(value[ri]) for key, value in evidence.items()}
            ev["search_step_seconds"] = rules.step_seconds
            ev["validation_step_seconds"] = rules.validation_seconds
            status = (
                "planned"
                if completed[ri] == request.collections_required
                else "partial"
                if completed[ri]
                else "unplanned"
            )
            if not request.enabled:
                status, code, explanation = (
                    "disabled",
                    "disabled",
                    "Request was disabled in the plan input snapshot.",
                )
            elif status == "planned":
                code, explanation = "fulfilled", "All requested collections were allocated."
            elif request.window_start_seconds + request.duration_seconds > min(
                request.window_end_seconds or snapshot.scenario.duration_seconds,
                snapshot.scenario.duration_seconds,
            ):
                code, explanation = (
                    "time_window",
                    "The collection duration does not fit inside the request window and plan timeframe.",
                )
            elif ev["synchronized_opportunities"]:
                blockers = {
                    k: ev[k]
                    for k in (
                        "capacity_rejections",
                        "battery_rejections",
                        "storage_rejections",
                        "revisit_rejections",
                    )
                    if ev[k]
                }
                code = (
                    max(blockers, key=blockers.get).removesuffix("_rejections") if blockers else "competition"
                )
                explanation = (
                    "Sampled opportunities existed, but the remaining collections were blocked during this heuristic allocation: "
                    + ", ".join(f"{k.removesuffix('_rejections')} ({v} checks)" for k, v in blockers.items())
                    + "."
                )
                ev["blockers"] = list(blockers)
            elif ev["single_spacecraft_opportunities"]:
                code, explanation = (
                    "simultaneous_spacecraft",
                    f"Individual access existed, but no sampled start had {request.satellites_required} spacecraft visible for the entire collection together.",
                )
            elif ev["dwell_rejections"]:
                code, explanation = (
                    "continuous_access",
                    "Some starts were visible, but angle or daylight constraints failed at a later validation sample during the collection.",
                )
            elif ev["daylight_rejections"]:
                code, explanation = (
                    "daylight",
                    "Geometric candidates failed the required sunlight threshold at sampled starts.",
                )
            elif ev["sensor_rejections"] and not ev["angle_rejections"]:
                code, explanation = "sensor", "Nearby spacecraft did not carry the required sensor."
            else:
                code, explanation = (
                    "no_access",
                    "No complete access opportunity satisfied the request on the sampled time grid. A finer grid or different timeframe may change this result.",
                )
            decisions.append(
                RequestDecision(
                    request_id=request.id,
                    name=request.name,
                    status=status,
                    reason_code=code,
                    explanation=explanation,
                    collections_requested=request.collections_required,
                    collections_planned=int(completed[ri]),
                    evidence=ev,
                )
            )
        feasible = evidence["synchronized_opportunities"] > 0
        scheduled = completed > 0
        step = rules.ephemeris_step_seconds
        # Include the exact endpoint; the final interpolation interval may be shorter.
        seconds = np.unique(
            np.append(
                np.arange(0, snapshot.scenario.duration_seconds, step), snapshot.scenario.duration_seconds
            )
        )
        tracks = ephemeris.positions(opportunities.fleet, snapshot.scenario.start.timestamp() + seconds)
        packed = np.column_stack(([r.id for r in requests], opportunities.xyz, feasible, scheduled)).astype(
            "<f8"
        )
        counts = dict(
            targets=len(requests),
            feasible=int(feasible.sum()),
            scheduled=int(scheduled.sum()),
            inaccessible=int((~feasible & np.array([r.enabled for r in requests])).sum()),
            unassigned=int((feasible & ~scheduled).sum()),
            observations=len(instructions),
            collections=int(completed.sum()),
            requested_collections=sum(r.collections_required for r in requests if r.enabled),
            candidates=int(evidence["spatial_candidates"].sum()),
            **dict(Counter(d.status for d in decisions)),
        )
        result = PlanResult(
            id=plan_id,
            scenario=snapshot.scenario,
            satellites=fleet,
            instructions=instructions,
            decisions=decisions,
            counts=counts,
            elapsed_seconds=round(time.perf_counter() - begun, 3),
            sample_step=step,
            sample_count=len(seconds),
        )
        result.elapsed_seconds = round(time.perf_counter() - begun, 3)
        return SolvedPlan(result, tracks.astype("<f8").tobytes(), packed.tobytes())


class DeadlineScheduler(GreedyScheduler):
    name = "earliest-deadline"

    def order(self, indices, requests):
        return sorted(
            indices,
            key=lambda i: (requests[i].window_end_seconds or 86400, -requests[i].priority, requests[i].id),
        )
