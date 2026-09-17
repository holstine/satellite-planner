import time
from types import SimpleNamespace

import pytest

from server.application import execute_work
from server.domain import (
    CollectionEdit,
    DomainError,
    WeatherRefresh,
    WeatherSeries,
    WeatherSnapshot,
    WhatIfSpec,
)
from server.plans import validate_plan
from server.scheduling import GreedyScheduler, interval_available
from server.storage import SQLiteRepository, unique_plan_name
from server.weather import OpenMeteoProvider, WeatherEvaluator, WeatherService, location
from server.whatif import edited_result, instruction_for, prepare, solve_variant
from tests.test_scheduling import StaticEphemeris, request, snapshot, solve


def providers():
    return SimpleNamespace(ephemeris=lambda _: StaticEphemeris(), scheduler=lambda _: GreedyScheduler())


def saved(tmp_path, spec=None):
    repository = SQLiteRepository(tmp_path / "test.sqlite")
    repository.initialize()
    spec = spec or snapshot([request(1), request(2)], count=1)
    solved = solve(spec)
    repository.save_plan(solved, spec.model_dump(mode="json"))
    return repository, spec, solved


def variant(repository, changes):
    base, spec, instructions, added = prepare(repository, "test", changes)
    solved = solve_variant("variant", base, spec, instructions, changes, providers(), lambda *_: None)
    return solved, spec, added


def test_atomic_remove_add_move_and_snapshot_isolation(tmp_path):
    repository, spec, original = saved(tmp_path)
    before = repository.plan_snapshot("test")
    first = original.result.instructions[0]
    removed, _, _ = variant(
        repository,
        WhatIfSpec(collections=[CollectionEdit(action="remove", collection_id=first.collection_id)]),
    )
    assert len(removed.result.instructions) == 1
    assert removed.result.decisions[0].status == "unplanned"
    assert removed.result.instructions[0].battery_before_wh == spec.spacecraft[0].initial_battery_wh
    assert removed.result.changes["removed_collections"] == [first.collection_id]
    # Removing then adding is one transaction; occupancy is checked on the final variant.
    replaced, _, _ = variant(
        repository,
        WhatIfSpec(
            collections=[
                CollectionEdit(action="remove", collection_id=first.collection_id),
                CollectionEdit(
                    action="add", request_id=first.request_id, start_seconds=70, spacecraft_ids=["sat-0"]
                ),
            ]
        ),
    )
    assert sorted(i.start for i in replaced.result.instructions) == [30, 70]
    moved, _, _ = variant(
        repository,
        WhatIfSpec(
            collections=[CollectionEdit(action="move", collection_id=first.collection_id, start_seconds=70)]
        ),
    )
    assert moved.result.changes["rearranged_collections"] == [first.collection_id]
    assert repository.plan_snapshot("test") == before
    assert repository.all_requests() == [], "what-if does not populate or change the live catalog"
    assert repository.get_plan("test")["counts"] == original.result.counts


def test_invalid_collision_duration_sensor_and_partial_group_are_rejected(tmp_path):
    repository, _, original = saved(tmp_path)
    first, second = original.result.instructions
    with pytest.raises(DomainError, match="capacity/cooldown"):
        variant(
            repository,
            WhatIfSpec(
                collections=[
                    CollectionEdit(
                        action="move", collection_id=second.collection_id, start_seconds=first.start
                    )
                ]
            ),
        )
    with pytest.raises(DomainError, match="time window"):
        variant(
            repository,
            WhatIfSpec(
                collections=[
                    CollectionEdit(action="move", collection_id=first.collection_id, start_seconds=115)
                ]
            ),
        )
    with pytest.raises(DomainError, match="not in this variant"):
        variant(
            repository, WhatIfSpec(collections=[CollectionEdit(action="remove", collection_id="missing")])
        )
    assert len(repository.list_plans()) == 1


def test_fill_reserves_future_collections_resources_and_revisit(tmp_path):
    spec = snapshot([request(1), request(2), request(3)], count=1)
    locked = instruction_for("locked", spec.requests[0], spec, "sat-0", 50)
    candidate = edited_result("test", spec, [locked])
    repository, _, original = saved(tmp_path, spec)
    # Use a distinct immutable plan with only a future reservation.
    candidate.id = "future"
    original.result = candidate
    repository.save_plan(original, spec.model_dump(mode="json"))
    changes = WhatIfSpec(mode="fill")
    base, modified, instructions, _ = prepare(repository, "future", changes)
    filled = solve_variant("filled", base, modified, instructions, changes, providers(), lambda *_: None)
    assert next(i for i in filled.result.instructions if i.collection_id == "locked").start == 50
    assert len(filled.result.instructions) == 3
    assert min(i.start for i in filled.result.instructions) == 0
    assert filled.result.validation["passed"]
    assert len({i.id for i in filled.result.instructions}) == 3
    assert not interval_available([(50, 70)], 40, 60, 1, 10)
    assert interval_available([(50, 70)], 0, 20, 1, 10)
    assert interval_available([(50, 70)], 40, 60, 2, 10)


def test_request_add_and_spacecraft_remove_are_local_and_atomic(tmp_path):
    repository, spec, original = saved(tmp_path, snapshot([request(1, satellites_required=2)], count=2))
    result, modified, ids = variant(
        repository,
        WhatIfSpec(remove_spacecraft_ids=["sat-0"], add_requests=[request(5).model_dump(exclude={"id"})]),
    )
    assert ids == [2]
    assert len(modified.requests) == 2
    assert result.result.instructions == [], "remove the whole synchronized collection"
    assert len(repository.plan_snapshot("test")["spacecraft"]) == 2
    assert result.result.parent_plan_id == "test"


def test_worker_preview_and_invalid_edits_do_not_save(tmp_path, monkeypatch):
    repository, _, original = saved(tmp_path)
    monkeypatch.setattr("server.application.load_providers", providers)
    for changes, status in [
        (WhatIfSpec(save=False), "completed"),
        (
            WhatIfSpec(
                collections=[
                    CollectionEdit(
                        action="move",
                        collection_id=original.result.instructions[1].collection_id,
                        start_seconds=0,
                    )
                ]
            ),
            "failed",
        ),
    ]:
        job = repository.create_job(
            "whatif",
            {"source_plan_id": "test", "spec": changes.model_dump(mode="json")},
            repository.plan_snapshot("test"),
        )
        execute_work(None, {"path": str(repository.path)}, job["id"])
        result = repository.get_job(job["id"])
        assert result["status"] == status, result
        assert len(repository.list_plans()) == 1
        if status == "completed":
            assert result["result"]["plan_id"] is None
    job = repository.create_job(
        "whatif",
        {"source_plan_id": "test", "spec": WhatIfSpec().model_dump(mode="json")},
        repository.plan_snapshot("test"),
    )
    execute_work(None, {"path": str(repository.path)}, job["id"])
    assert repository.get_job(job["id"])["status"] == "completed"
    assert repository.get_plan(job["id"])["parent_plan_id"] == "test"


def weather(spec, cloud=(10, 10, 90), precipitation=(0, 0, 1), wind=(2, 2, 25)):
    spec.scenario.constraints.affected_by_weather = True
    key, lat, lon, *_ = location(spec.requests[0], spec.scenario)
    epoch = int(spec.scenario.start.timestamp())
    now = time.time()
    cell = WeatherSeries(
        key=key,
        latitude=lat,
        longitude=lon,
        fetched_at=now,
        expires_at=now + 3600,
        times=[epoch + 3600 * i for i in range(3)],
        cloud_cover_pct=list(cloud),
        precipitation_mm=list(precipitation),
        wind_speed_mps=list(wind),
    )
    spec.weather = WeatherSnapshot(
        captured_at=now, cells={key: cell}, request_cells={r.id: key for r in spec.requests}
    )
    return cell


def test_weather_all_thresholds_and_full_dwell_brackets():
    spec = snapshot(
        [request(1, max_cloud_cover_pct=25, max_precipitation_mm=0, max_wind_speed_mps=10)], duration=7200
    )
    weather(spec)
    checker = WeatherEvaluator(spec)
    assert checker.check_collection(0, 0, 20)[0]
    assert checker.check_collection(0, 3590, 3610) == (False, "weather")
    assert checker.check_collection(0, 7000, 7020) == (False, "weather")
    for field in ("cloud_cover_pct", "precipitation_mm", "wind_speed_mps"):
        modified = spec.model_copy(deep=True)
        getattr(next(iter(modified.weather.cells.values())), field)[1] = None
        assert WeatherEvaluator(modified).check_collection(0, 0, 20) == (False, "weather_unavailable")


def test_scheduler_and_independent_validator_share_saved_weather_not_network(monkeypatch):
    monkeypatch.setattr("httpx.get", lambda *a, **k: pytest.fail("Scheduling must not download weather"))
    spec = snapshot([request(1, max_cloud_cover_pct=25)], rules={"affected_by_weather": True})
    result = solve(spec).result
    assert result.decisions[0].reason_code == "weather_unavailable"
    weather(spec, cloud=(80, 80, 80))
    result = solve(spec).result
    assert result.decisions[0].reason_code == "weather"
    cell = weather(spec)
    result = solve(spec).result
    assert result.instructions
    # Reproduction uses freshness when captured, not the current wall clock.
    cell.expires_at = spec.weather.captured_at + 1
    assert validate_plan(result, spec, StaticEphemeris())["passed"]
    cell.cloud_cover_pct[1] = 100
    with pytest.raises(DomainError, match="weather"):
        validate_plan(result, spec, StaticEphemeris())


def test_schedule_weather_switch_cloud_limit_and_radar():
    spec = snapshot(
        [request(1), request(2, sensor="radar"), request(3, max_cloud_cover_pct=20)],
        rules={"affected_by_weather": True, "max_cloud_cover_pct": 50},
        sensors=["optical", "radar"],
    )
    weather(spec, cloud=(60, 60, 60))
    result = solve(spec).result
    assert {i.request_id for i in result.instructions} == {2}
    assert result.decisions[0].reason_code == "weather"
    assert result.decisions[2].reason_code == "weather"
    # Turning the switch off disables all weather restrictions, including explicit request limits.
    spec.scenario.constraints.affected_by_weather = False
    spec.weather = WeatherSnapshot()
    assert {i.request_id for i in solve(spec).result.instructions} == {1, 2, 3}
    # When enabled, unknown cloud cover blocks optical collections but never blocks ordinary radar.
    spec.scenario.constraints.affected_by_weather = True
    assert {i.request_id for i in solve(spec).result.instructions} == {2}
    weather(spec, cloud=(30, 30, 30))
    result = solve(spec).result
    assert {i.request_id for i in result.instructions} == {1, 2}
    spec.weather.cells[next(iter(spec.weather.cells))].cloud_cover_pct[1] = 80
    with pytest.raises(DomainError, match="weather"):
        validate_plan(result, spec, StaticEphemeris())


def test_cache_reuse_staleness_and_changed_location(tmp_path):
    repository = SQLiteRepository(tmp_path / "weather.sqlite")
    repository.initialize()
    spec = snapshot([request(1, max_cloud_cover_pct=25)])
    cell = weather(spec)
    calls = []
    provider = SimpleNamespace(fetch=lambda locations: calls.append(locations) or [cell.model_dump()])
    service = WeatherService(repository, provider)
    body = WeatherRefresh(scenario=spec.scenario)
    assert service.refresh(spec, body, lambda *_: None)["fetched"] == 1
    assert service.refresh(spec, body, lambda *_: None)["fetched"] == 0
    assert len(calls) == 1
    spec.weather = service.capture(spec)
    assert WeatherEvaluator(spec).check_collection(0, 0, 20)[0]
    spec.requests[0].latitude = 20
    assert WeatherEvaluator(spec).check_collection(0, 0, 20) == (False, "weather_unavailable")
    spec.requests[0].latitude = 0
    cell.expires_at = time.time() - 1
    repository.save_weather_cells([cell.model_dump()])
    assert not service.capture(spec).cells


def test_provider_parses_real_units_and_rejects_invalid_payload(monkeypatch):
    spec = snapshot([request(1)])
    entry = {
        "hourly": {
            "time": [0, 3600],
            "cloud_cover": [20, None],
            "precipitation": [0, 1.5],
            "wind_speed_10m": [4, 8],
        }
    }

    def get(url, params, timeout):
        assert params["wind_speed_unit"] == "ms"
        assert params["timezone"] == "UTC"
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: entry)

    monkeypatch.setattr("httpx.get", get)
    cells = OpenMeteoProvider().fetch([location(spec.requests[0], spec.scenario)])
    assert cells[0]["wind_speed_mps"] == [4, 8]
    assert cells[0]["cloud_cover_pct"] == [20, None]
    entry["hourly"]["time"] = [0, 7200]
    with pytest.raises(DomainError, match="invalid hourly"):
        OpenMeteoProvider().fetch([location(spec.requests[0], spec.scenario)])


def test_plan_names_increment_and_match_snapshot_atomically(tmp_path):
    repository, spec, original = saved(tmp_path)
    for number in (2, 3):
        duplicate = solve(spec)
        duplicate.result.id = f"duplicate-{number}"
        duplicate.result.scenario.name = "Observation plan"
        repository.save_plan(duplicate, spec.model_dump(mode="json"))
        expected = f"Observation plan ({number})"
        assert repository.get_plan(duplicate.result.id)["scenario"]["name"] == expected
        assert repository.plan_snapshot(duplicate.result.id)["scenario"]["name"] == expected
        assert duplicate.result.scenario.name == expected
    assert repository.get_plan("test")["scenario"]["name"] == "Observation plan"
    assert unique_plan_name("Mission (3)", {"Mission (3)"}) == "Mission (4)"
    assert len(unique_plan_name("X" * 120, {"X" * 120})) == 120
