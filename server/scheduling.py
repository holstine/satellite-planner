"""Deterministic allocation of complete synchronized collections."""

import time
from collections import Counter

import numpy as np

from .contracts import SolvedPlan
from .domain import CollectionInstruction, PlanResult, RequestDecision
from .visibility import Opportunities
from .weather import weather_summary


def interval_available(items, start, end, capacity, cooldown):
    """Check concurrent occupation including cooldown against future reservations."""
    events = [(start, 1), (end + cooldown, -1)]
    for a, b in items:
        if a < end + cooldown and start < b + cooldown:
            events.extend(((a, 1), (b + cooldown, -1)))
    count = 0
    for _, delta in sorted(events):
        count += delta
        if count > capacity:
            return False
    return True


def update_resource_states(instructions, fleet):
    instructions.sort(key=lambda i: (i.start, i.id))
    for si, spacecraft in enumerate(fleet):
        battery, storage = spacecraft.initial_battery_wh, spacecraft.initial_storage_mb
        for instruction in sorted(
            (i for i in instructions if i.satellite_index == si), key=lambda i: (i.start, i.id)
        ):
            instruction.battery_before_wh = battery
            battery -= instruction.energy_wh
            storage += instruction.data_mb
            instruction.battery_after_wh = battery
            instruction.storage_after_mb = storage


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
        instructions = [i.model_copy(deep=True) for i in snapshot.locked_instructions]
        reservations = [[] for _ in fleet]
        request_slots = {r.id: {} for r in requests}
        for instruction in instructions:
            si = instruction.satellite_index
            battery[si] -= instruction.energy_wh
            storage[si] += instruction.data_mb
            reservations[si].append((instruction.start, instruction.end))
            request_slots[instruction.request_id][instruction.collection_id] = (
                instruction.start,
                instruction.end,
            )
        for ri, request in enumerate(requests):
            completed[ri] = len(request_slots[request.id])
            if completed[ri] >= request.collections_required:
                opportunities.enabled[ri] = False
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
                if snapshot.locked_instructions and any(
                    not (
                        offset >= end + request.revisit_seconds
                        or offset + request.duration_seconds + request.revisit_seconds <= start
                    )
                    for start, end in request_slots[request.id].values()
                ):
                    evidence["revisit_rejections"][ri] += 1
                    continue
                eligible = []
                for si in participants:
                    busy = not np.any(free[si] <= offset)
                    if snapshot.locked_instructions:
                        busy = not interval_available(
                            reservations[si],
                            offset,
                            offset + request.duration_seconds,
                            min(rules.capacity_per_satellite, fleet[si].capacity),
                            rules.cooldown_seconds,
                        )
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
                if snapshot.locked_instructions:
                    collection_id = f"{request.id}:fill:{plan_id}:{completed[ri] + 1}"
                for si in selected:
                    lane = int(np.flatnonzero(free[si] <= offset)[0])
                    free[si][lane] = offset + request.duration_seconds + rules.cooldown_seconds
                    before = float(battery[si])
                    battery[si] -= request.energy_wh
                    storage[si] += request.data_mb
                    if snapshot.locked_instructions:
                        reservations[si].append((offset, offset + request.duration_seconds))
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
                request_slots[request.id][collection_id] = (offset, offset + request.duration_seconds)
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
            elif ev["weather_unavailable"]:
                code, explanation = (
                    "weather_unavailable",
                    "Required model weather is missing, stale, or outside the cached timeframe. Refresh weather before scheduling.",
                )
            elif ev["weather_rejections"]:
                code, explanation = (
                    "weather",
                    "Cached hourly model weather exceeded the request's cloud, precipitation, or wind limits during candidate collection intervals.",
                )
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
        if snapshot.locked_instructions:
            update_resource_states(instructions, fleet)
        feasible = (evidence["synchronized_opportunities"] > 0) | (completed > 0)
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
            weather_summary=weather_summary(snapshot),
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
