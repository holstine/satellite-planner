from datetime import UTC, datetime
from itertools import pairwise

import numpy as np
import pytest
from scipy.spatial import cKDTree

from server.domain import (
    Constraints,
    DomainError,
    Generate,
    PlanSnapshot,
    RequestRecord,
    Scenario,
    Spacecraft,
)
from server.fleet import HybridEphemeris
from server.orbits import A, demo_fleet, positions, sun_direction, target_vectors
from server.plans import validate_plan
from server.requests import generate_requests
from server.scheduling import DeadlineScheduler, GreedyScheduler
from server.visibility import Opportunities, candidate_indices


class StaticEphemeris:
    name = "static"

    def positions(self, fleet, times):
        return np.tile([A + 550000, 0, 0], (len(np.atleast_1d(times)), len(fleet), 1))


def request(i=1, **kw):
    return RequestRecord(
        id=i, **dict(name=f"R{i}", latitude=0, longitude=0, daylight_only=False, duration_seconds=20, **kw)
    )


def snapshot(requests, count=2, duration=120, rules=None, **spacecraft):
    return PlanSnapshot(
        scenario=Scenario(
            start="2026-09-11T12:00:00Z",
            duration_seconds=duration,
            constraints=Constraints(step_seconds=10, cooldown_seconds=10, **(rules or {})),
        ),
        spacecraft=[Spacecraft(id=f"sat-{i}", name=f"Sat {i}", **spacecraft) for i in range(count)],
        requests=requests,
    )


def solve(spec, scheduler=None, ephemeris=None):
    provider = ephemeris or StaticEphemeris()
    result = (scheduler or GreedyScheduler()).solve("test", spec, provider, lambda *_: None)
    result.result.validation = validate_plan(result.result, spec, provider)
    return result


def test_priority_capacity_cooldown_and_uniqueness():
    spec = snapshot([request(i, priority=p) for i, p in enumerate([1, 90, 5, 80, 8, 7, 3, 2])])
    plan = solve(spec).result
    assert [i.request_id for i in plan.instructions[:2]] == [1, 3]
    assert len({i.request_id for i in plan.instructions}) == len(plan.instructions) == 8
    for si in range(2):
        assigned = [i for i in plan.instructions if i.satellite_index == si]
        assert all(b.start >= a.end + 10 for a, b in pairwise(assigned))
    assert plan.validation["passed"]


def test_atomic_simultaneous_collection_and_insufficient_fleet():
    plan = solve(snapshot([request(1, satellites_required=2), request(2, satellites_required=3)])).result
    group = [i for i in plan.instructions if i.request_id == 1]
    assert len(group) == 2 and len({i.start for i in group}) == 1
    assert not any(i.request_id == 2 for i in plan.instructions)
    assert plan.decisions[1].reason_code == "simultaneous_spacecraft"


@pytest.mark.parametrize(
    ("budget", "cost", "reason"),
    [
        ({"initial_battery_wh": 45, "battery_reserve_wh": 40}, {"energy_wh": 6}, "battery"),
        ({"storage_capacity_mb": 10}, {"data_mb": 11}, "storage"),
    ],
)
def test_resource_rejections_are_explained(budget, cost, reason):
    spec = snapshot([request(**cost)], **budget)
    plan = solve(spec).result
    assert not plan.instructions and plan.decisions[0].reason_code == reason
    assert plan.decisions[0].evidence[reason + "_rejections"] > 0


def test_budgets_deplete_and_group_allocation_does_not_partially_consume():
    spec = snapshot(
        [
            request(1, priority=100, energy_wh=10),
            request(2, priority=90, energy_wh=10, satellites_required=2),
        ],
        initial_battery_wh=50,
        battery_reserve_wh=40,
    )
    plan = solve(spec).result
    assert len(plan.instructions) == 1
    assert plan.instructions[0].battery_after_wh == 40
    assert plan.decisions[1].reason_code == "battery"


def test_repeats_revisit_and_partial_results():
    spec = snapshot([request(collections_required=4, revisit_seconds=30)], duration=120)
    plan = solve(spec).result
    assert [i.start for i in plan.instructions] == [0, 50, 100]
    assert plan.decisions[0].status == "partial"
    assert plan.decisions[0].collections_planned == 3


def test_window_disabled_sensor_and_pointing_constraints():
    rows = [
        request(1, window_start_seconds=110),
        request(2, enabled=False),
        request(3, sensor="radar"),
        request(4, min_off_nadir_deg=5),
    ]
    plan = solve(snapshot(rows, sensors=["optical"])).result
    assert not plan.instructions
    assert [d.reason_code for d in plan.decisions] == ["time_window", "disabled", "sensor", "no_access"]


def test_multi_capacity_respects_spacecraft_limit():
    rows = [request(i) for i in range(6)]
    spec = snapshot(rows, count=1, rules={"capacity_per_satellite": 3}, capacity=2)
    plan = solve(spec).result
    assert len([i for i in plan.instructions if i.start == 0]) == 2


def test_daylight_checked_through_entire_collection(monkeypatch):
    from server import visibility

    spec = snapshot([request()])
    spec.requests[0].daylight_only = True
    start = spec.scenario.start.timestamp()
    monkeypatch.setattr(
        visibility,
        "sun_direction",
        lambda times: np.array([[1, 0, 0] if t < start + 10 else [-1, 0, 0] for t in times]),
    )
    plan = solve(spec).result
    assert not plan.instructions
    assert plan.decisions[0].reason_code == "continuous_access"


def test_validator_rejects_tampered_instructions():
    spec = snapshot([request(satellites_required=2)])
    plan = solve(spec).result
    plan.instructions.pop()
    with pytest.raises(DomainError, match="incomplete synchronized"):
        validate_plan(plan, spec, StaticEphemeris())
    plan = solve(spec).result
    plan.instructions[0].energy_wh = 0
    with pytest.raises(DomainError, match="resource cost"):
        validate_plan(plan, spec, StaticEphemeris())


def test_replaceable_scheduler_changes_order_without_breaking_contract():
    spec = snapshot([request(1, priority=100), request(2, priority=1, window_end_seconds=30)], count=1)
    assert solve(spec).result.instructions[0].request_id == 1
    assert solve(spec, DeadlineScheduler()).result.instructions[0].request_id == 2


def test_spatial_filter_never_drops_exact_visible_candidates():
    rng = np.random.default_rng(7)
    rows = [
        RequestRecord(
            id=i,
            name=str(i),
            latitude=float(lat),
            longitude=float(lon),
            daylight_only=False,
            min_elevation_deg=0,
            max_off_nadir_deg=85,
        )
        for i, (lat, lon) in enumerate(
            zip(rng.uniform(-90, 90, 12000), rng.uniform(-180, 180, 12000), strict=True)
        )
    ]
    spec = snapshot(rows, count=20, duration=60)
    spec.spacecraft = [Spacecraft.model_validate(s) for s in demo_fleet(20)]
    scan = Opportunities(spec, HybridEphemeris(), lambda *_: None)
    xyz, normals = target_vectors([r.model_dump() for r in rows])
    tree = cKDTree(xyz / np.linalg.norm(xyz, axis=1)[:, None])
    for angle in (0, 10, 45, 65, 85):
        for sat in scan.tracks[0]:
            unit = (sat - xyz) / np.linalg.norm(sat - xyz, axis=1)[:, None]
            visible = (np.sum(unit * normals, axis=1) >= 0) & (
                (unit @ (sat / np.linalg.norm(sat))) >= np.cos(np.deg2rad(angle))
            )
            assert set(np.flatnonzero(visible)) <= set(candidate_indices(tree, sat, angle))


def test_sun_equinox_and_orbit_rotation():
    noon = datetime(2026, 3, 20, 12, tzinfo=UTC).timestamp()
    sun = sun_direction(np.array([noon, noon + 43200]))
    assert sun[0, 0] > 0.99 and sun[1, 0] < -0.99
    assert np.allclose(np.linalg.norm(sun, axis=1), 1)
    track = positions(demo_fleet(3), [noon, noon + 10])
    assert track.shape == (2, 3, 3) and np.allclose(np.linalg.norm(track, axis=2), A + 550000)
    assert not np.allclose(track[0], track[1])


def test_demo_mixed_fleet_has_stable_orbit_classes_and_elliptical_heo():
    fleet = demo_fleet(100)
    assert {
        orbit: sum(s["orbit_class"] == orbit for s in fleet) for orbit in ("LEO", "MEO", "GEO", "HEO")
    } == {"LEO": 70, "MEO": 15, "GEO": 10, "HEO": 5}
    heo = [s for s in fleet if s["orbit_class"] == "HEO"]
    radii = np.linalg.norm(positions(heo, [1789128000, 1789128000 + 18000]), axis=2)
    assert np.all(radii > A) and not np.allclose(radii[0], radii[1])
    assert all(s["eccentricity"] == 0 for s in demo_fleet(20, profile="leo"))


def test_generation_is_reproducible_mixed_and_crosses_date_line():
    spec = Generate(
        start="2026-09-11T12:00:00Z",
        count=100,
        seed=13,
        west=170,
        east=-170,
        south=-10,
        north=10,
    )
    first = generate_requests(spec, lambda *_: None)
    second = generate_requests(spec, lambda *_: None)
    assert first["records"] == second["records"] and first["summary"]["generated"] == 100
    for field in (
        "duration_seconds",
        "priority",
        "energy_wh",
        "data_mb",
        "satellites_required",
        "collections_required",
        "revisit_seconds",
        "window_start_seconds",
        "window_end_seconds",
        "min_elevation_deg",
        "min_off_nadir_deg",
        "max_off_nadir_deg",
        "daylight_only",
        "min_sun_elevation_deg",
        "sensor",
    ):
        assert len({r[field] for r in first["records"]}) > 1, field
    assert all(
        r["window_end_seconds"] is None
        or r["window_end_seconds"] >= r["window_start_seconds"] + r["duration_seconds"]
        for r in first["records"]
    )
    assert all(-10 <= r["latitude"] <= 10 and abs(r["longitude"]) >= 170 for r in first["records"])


def test_sampled_ephemeris_refuses_extrapolation_and_interpolates():
    spacecraft = Spacecraft(
        id="s",
        name="Sampled",
        kind="sampled",
        samples=[
            {"time": "2026-09-11T12:00:00Z", "x": A + 550000, "y": 0, "z": 0},
            {"time": "2026-09-11T12:01:00Z", "x": A + 550000, "y": 1000, "z": 0},
        ],
    )
    start = spacecraft.samples[0].time.timestamp()
    provider = HybridEphemeris()
    assert provider.positions([spacecraft.model_dump(mode="json")], np.array([start + 30]))[
        0, 0, 1
    ] == pytest.approx(500)
    with pytest.raises(DomainError):
        provider.positions([spacecraft.model_dump(mode="json")], np.array([start - 1]))


def test_binary_layout_and_playback_end():
    spec = snapshot([request()], duration=65)
    result = solve(spec)
    assert len(result.positions) == result.result.sample_count * 2 * 3 * 8
    assert len(result.targets) == 6 * 8
    assert result.result.sample_count == 8
