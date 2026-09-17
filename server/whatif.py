"""Atomic what-if variants of immutable plans. Invalid edits never save a plan."""

from collections import Counter
from uuid import uuid4

import numpy as np

from .contracts import SolvedPlan
from .domain import (
    CollectionInstruction,
    DomainError,
    PlanResult,
    PlanSnapshot,
    RequestDecision,
    RequestRecord,
)
from .orbits import target_vectors
from .plans import validate_plan
from .scheduling import update_resource_states
from .weather import weather_summary


def compare_plans(before, after):
    def groups(plan):
        result = {}
        for i in plan.instructions:
            entry = result.setdefault(
                i.collection_id, dict(request_id=i.request_id, start=i.start, end=i.end, spacecraft=[])
            )
            entry["spacecraft"].append(i.spacecraft_id)
        for entry in result.values():
            entry["spacecraft"].sort()
        return result

    a, b = groups(before), groups(after)
    added, removed = sorted(b.keys() - a.keys()), sorted(a.keys() - b.keys())
    moved = sorted(key for key in a.keys() & b.keys() if a[key] != b[key])
    return dict(
        added_collections=added,
        removed_collections=removed,
        rearranged_collections=moved,
        retained_collections=len(a.keys() & b.keys()) - len(moved),
        count_delta={
            key: after.counts.get(key, 0) - before.counts.get(key, 0)
            for key in set(before.counts) | set(after.counts)
        },
    )


def read_plan(repository, plan_id):
    return PlanResult.model_validate(
        dict(
            repository.get_plan(plan_id),
            instructions=repository.plan_instructions(plan_id, limit=2000000)["items"],
            decisions=repository.plan_decisions(plan_id, limit=100000)["items"],
        )
    )


def prepare(repository, plan_id, spec):
    base = read_plan(repository, plan_id)
    snapshot = PlanSnapshot.model_validate(repository.plan_snapshot(plan_id))
    snapshot.locked_instructions = []
    if spec.scenario:
        snapshot.scenario = spec.scenario.model_copy(deep=True)
    snapshot.scenario.name = spec.name
    requests = {r.id: r for r in snapshot.requests}
    spacecraft = {s.id: s for s in snapshot.spacecraft}
    removed_requests = set(spec.remove_request_ids)
    removed_spacecraft = set(spec.remove_spacecraft_ids)
    if not removed_requests <= requests.keys() or not removed_spacecraft <= spacecraft.keys():
        raise DomainError("Cannot remove a request or spacecraft absent from the source plan")
    if len({r.id for r in spec.request_changes}) != len(spec.request_changes) or len(
        {s.id for s in spec.spacecraft_changes}
    ) != len(spec.spacecraft_changes):
        raise DomainError("Duplicate request/spacecraft changes")
    for record in spec.request_changes:
        if record.id not in requests or record.id in removed_requests:
            raise DomainError(f"Request {record.id} cannot be updated; use add_requests for new requests")
        requests[record.id] = record
    for record in spec.spacecraft_changes:
        if record.id in removed_spacecraft:
            raise DomainError("Cannot both remove and update a spacecraft")
        spacecraft[record.id] = record
    next_id = max(requests, default=0) + 1
    added_ids = []
    for record in spec.add_requests:
        requests[next_id] = RequestRecord(id=next_id, **record.model_dump())
        added_ids.append(next_id)
        next_id += 1
    for key in removed_requests:
        del requests[key]
    for key in removed_spacecraft:
        del spacecraft[key]
    snapshot.requests, snapshot.spacecraft = list(requests.values()), list(spacecraft.values())
    # Removing a participant removes its entire synchronized collection.
    dropped = {
        i.collection_id
        for i in base.instructions
        if i.request_id in removed_requests or i.spacecraft_id in removed_spacecraft
    }
    groups = {}
    if spec.mode != "reschedule":
        for instruction in base.instructions:
            if instruction.collection_id not in dropped:
                groups.setdefault(instruction.collection_id, []).append(instruction.model_copy(deep=True))
    elif spec.collections:
        raise DomainError("Full rescheduling cannot include manual collection edits; use edit or fill mode")
    for edit in spec.collections:
        if edit.action in ("move", "remove") and edit.collection_id not in groups:
            raise DomainError(f"Collection {edit.collection_id} is not in this variant")
        if edit.action == "remove":
            del groups[edit.collection_id]
            continue
        if edit.action == "move":
            previous = groups.pop(edit.collection_id)
            rid, start, participants = (
                previous[0].request_id,
                previous[0].start,
                [i.spacecraft_id for i in previous],
            )
            if edit.request_id is not None and edit.request_id != rid:
                raise DomainError("Moving a collection cannot change its request")
            cid = edit.collection_id
        else:
            rid, start, participants = edit.request_id, edit.start_seconds, edit.spacecraft_ids
            cid = edit.collection_id or f"whatif:{uuid4().hex}"
            if cid in groups:
                raise DomainError("Collection ID already exists")
        start = edit.start_seconds if edit.start_seconds is not None else start
        participants = edit.spacecraft_ids or participants
        if rid not in requests or any(s not in spacecraft for s in participants):
            raise DomainError("Collection references an unknown request or spacecraft")
        groups[cid] = [instruction_for(cid, requests[rid], snapshot, sid, start) for sid in participants]
    # Updated request parameters consistently update all its commands before validation.
    instructions = [
        instruction_for(cid, requests[group[0].request_id], snapshot, old.spacecraft_id, old.start)
        for cid, group in groups.items()
        for old in group
    ]
    return base, snapshot, instructions, added_ids


def instruction_for(cid, request, snapshot, spacecraft_id, start):
    si = next((i for i, s in enumerate(snapshot.spacecraft) if s.id == spacecraft_id), None)
    if si is None:
        raise DomainError("Unknown collection spacecraft")
    return CollectionInstruction(
        id=f"{cid}:{spacecraft_id}",
        collection_id=cid,
        request_id=request.id,
        spacecraft_id=spacecraft_id,
        satellite_index=si,
        start=start,
        end=start + request.duration_seconds,
        sensor=request.sensor,
        latitude=request.latitude,
        longitude=request.longitude,
        energy_wh=request.energy_wh,
        data_mb=request.data_mb,
        battery_before_wh=0,
        battery_after_wh=0,
        storage_after_mb=0,
        priority=request.priority,
    )


def edited_result(plan_id, snapshot, instructions):
    update_resource_states(instructions, snapshot.spacecraft)
    groups = {r.id: set() for r in snapshot.requests}
    for instruction in instructions:
        groups[instruction.request_id].add(instruction.collection_id)
    decisions = []
    for request in snapshot.requests:
        count = len(groups[request.id])
        status = (
            "disabled"
            if not request.enabled
            else "planned"
            if count == request.collections_required
            else "partial"
            if count
            else "unplanned"
        )
        decisions.append(
            RequestDecision(
                request_id=request.id,
                name=request.name,
                status=status,
                reason_code="fulfilled" if status == "planned" else "what_if_not_allocated",
                explanation="Collections retained or explicitly assigned in this what-if variant; no automatic feasibility search was performed.",
                collections_requested=request.collections_required,
                collections_planned=count,
            )
        )
    step = snapshot.scenario.constraints.ephemeris_step_seconds
    assigned = sum(bool(v) for v in groups.values())
    counts = dict(
        targets=len(snapshot.requests),
        scheduled=assigned,
        feasible=assigned,
        inaccessible=0,
        unassigned=len(snapshot.requests) - assigned,
        observations=len(instructions),
        collections=sum(map(len, groups.values())),
        requested_collections=sum(r.collections_required for r in snapshot.requests if r.enabled),
        candidates=0,
        **dict(Counter(d.status for d in decisions)),
    )
    return PlanResult(
        id=plan_id,
        scenario=snapshot.scenario,
        satellites=snapshot.spacecraft,
        instructions=instructions,
        decisions=decisions,
        counts=counts,
        elapsed_seconds=0,
        sample_step=step,
        sample_count=int(np.ceil(snapshot.scenario.duration_seconds / step)) + 1,
        weather_summary=weather_summary(snapshot),
    )


def solve_variant(plan_id, base, snapshot, instructions, spec, providers, progress):
    ephemeris = providers.ephemeris(snapshot.scenario.ephemeris_provider)
    candidate = edited_result(plan_id, snapshot, instructions)
    # Fixed collections must be valid before any new allocation is attempted.
    candidate.validation = validate_plan(candidate, snapshot, ephemeris)
    if spec.mode in ("fill", "reschedule"):
        snapshot.locked_instructions = instructions if spec.mode == "fill" else []
        solved = providers.scheduler(snapshot.scenario.scheduler).solve(
            plan_id, snapshot, ephemeris, progress
        )
    else:
        seconds = np.append(
            np.arange(0, snapshot.scenario.duration_seconds, candidate.sample_step),
            snapshot.scenario.duration_seconds,
        )
        positions = ephemeris.positions(
            [s.model_dump(mode="json") for s in snapshot.spacecraft],
            snapshot.scenario.start.timestamp() + seconds,
        )
        xyz, _ = target_vectors([r.model_dump() for r in snapshot.requests])
        assigned = {i.request_id for i in instructions}
        flags = [int(r.id in assigned) for r in snapshot.requests]
        packed = np.column_stack(([r.id for r in snapshot.requests], xyz, flags, flags)).astype("<f8")
        solved = SolvedPlan(candidate, positions.astype("<f8").tobytes(), packed.tobytes())
    solved.result.validation = validate_plan(solved.result, snapshot, ephemeris)
    solved.result.parent_plan_id = base.id
    solved.result.changes = compare_plans(base, solved.result)
    return solved
