import asyncio
import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient
from mcp import Client

from server.app import create_app
from server.application import Application, execute_work
from server.domain import CollectionRequest, PlanSnapshot, Scenario, Spacecraft
from server.mcp_server import create_mcp
from server.plans import validate_plan
from server.scheduling import GreedyScheduler
from server.storage import SQLiteRepository
from tests.test_scheduling import StaticEphemeris


@pytest.fixture
def application(tmp_path):
    return Application(options={"path": str(tmp_path / "orbit.sqlite")})


@pytest.fixture
def client(application):
    with TestClient(create_app(application), base_url="http://127.0.0.1:8000") as client:
        yield client


def request(**kw):
    return dict(name="Denver", latitude=39.74, longitude=-104.99, priority=5, enabled=True, **kw)


def test_crud_pagination_and_binary(client):
    created = client.post("/api/requests", json=request())
    assert created.status_code == 201
    rid = created.json()["id"]
    assert client.get(f"/api/requests/{rid}").json()["duration_seconds"] == 30
    changed = request(energy_wh=12, satellites_required=2)
    assert client.put(f"/api/requests/{rid}", json=changed).status_code == 200
    assert client.get("/api/requests?limit=1&q=Denver").json()["items"][0]["energy_wh"] == 12
    assert len(client.get("/api/requests/points").content) == 40
    assert "energy_wh" in client.get("/api/requests/export").text
    assert client.delete(f"/api/requests/{rid}").status_code == 200
    assert client.get(f"/api/requests/{rid}").status_code == 404


def test_bulk_import_atomic_validation_and_roundtrip(client):
    invalid = {**request(), "latitude": 91}
    assert client.post("/api/requests/bulk", json={"requests": [request(), invalid]}).status_code == 422
    assert client.get("/api/requests").json()["total"] == 0
    csv = "name,latitude,longitude,energy_wh,satellites_required\nA,0,180,8,2\nB,-90,-180,2,1"
    assert client.post("/api/requests/import", json={"text": csv, "format": "csv"}).json()["inserted"] == 2
    bad = "name,latitude,longitude\nC,1,1\nD,nonsense,2"
    assert client.post("/api/requests/import", json={"text": bad, "format": "csv"}).status_code == 422
    exported = client.get("/api/requests/export").text
    assert (
        client.post("/api/requests/import", json={"text": exported, "format": "csv"}).json()["inserted"] == 2
    )
    assert client.get("/api/requests").json()["total"] == 4


def test_constraints_validation_origin_and_fleet(client):
    assert client.post("/api/jobs/schedule", json={"start": "2026-09-11T12:00:00"}).status_code == 422
    assert client.post("/api/jobs/schedule", json={"start": "2026-09-11T12:00:00Z"}).status_code == 422
    assert (
        client.post("/api/requests", json=request(), headers={"Origin": "https://example.org"}).status_code
        == 403
    )
    assert client.put("/api/fleet/tle", json={"text": "broken"}).status_code == 422
    c = client.get("/api/constraints").json()
    c["capacity_per_satellite"] = 2
    assert client.put("/api/constraints", json=c).status_code == 200
    assert client.get("/api/constraints").json() == c
    c["capacity_per_satellite"] = 0
    assert client.put("/api/constraints", json=c).status_code == 422
    assert (
        client.put("/api/fleet/s", json={"id": "s", "name": "S", "initial_battery_wh": 1000}).status_code
        == 422
    )
    assert client.put("/api/fleet/s", json={"id": "s", "name": "S"}).status_code == 200
    assert client.get("/api/fleet/s/state?time=2026-09-11T12:00:00Z").status_code == 200
    assert client.delete("/api/fleet/s").status_code == 200


def test_import_valid_tle(client):
    a = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753"
    b = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"
    response = client.put("/api/fleet/tle", json={"text": "VANGUARD 1\n" + a + "\n" + b})
    assert response.status_code == 200, response.text
    assert response.json()[0]["kind"] == "tle"
    assert len(client.get("/api/fleet").json()) == 1


def saved_plan(application):
    repository = application.repository
    record = repository.put_request(
        CollectionRequest(name="Origin", latitude=0, longitude=0, daylight_only=False).model_dump()
    )
    repository.replace_fleet([Spacecraft(id="s", name="S").model_dump(mode="json")])
    snapshot = PlanSnapshot.model_validate(
        repository.snapshot(
            Scenario(start="2026-09-11T12:00:00Z", duration_seconds=60).model_dump(mode="json")
        )
    )
    solved = GreedyScheduler().solve("saved", snapshot, StaticEphemeris(), lambda *_: None)
    solved.result.validation = validate_plan(solved.result, snapshot, StaticEphemeris())
    repository.save_plan(solved, snapshot.model_dump(mode="json"))
    return record["id"]


def test_plan_snapshot_survives_catalog_changes_and_is_queryable(client, application):
    rid = saved_plan(application)
    client.delete(f"/api/requests/{rid}")
    client.delete("/api/fleet/s")
    explanation = client.get(f"/api/plans/saved/requests/{rid}").json()
    assert explanation["request"]["name"] == "Origin" and len(explanation["collections"]) == 1
    assert explanation["decision"]["status"] == "planned"
    assert client.get("/api/plans/saved/spacecraft/s").json()["remaining_battery_wh"] == 395
    assert client.get("/api/plans/saved/decisions?status=planned").json()["total"] == 1
    assert client.get("/api/plans/saved/instructions?spacecraft_id=missing").json()["total"] == 0
    assert client.get("/api/plans/saved/snapshot").json()["requests"][0]["id"] == rid
    assert len(client.get("/api/plans/saved/files/targets.bin").content) == 48
    assert client.get("/api/plans/saved/files/secrets").status_code == 404


def test_clear_catalog_retains_saved_plans_and_blocks_during_jobs(client, application):
    rid = saved_plan(application)
    snapshot = application.repository.snapshot(Scenario(start="2026-09-11T12:00:00Z").model_dump(mode="json"))
    job = application.repository.create_job("generate", {}, snapshot)
    assert client.delete("/api/requests").status_code == 409
    assert client.get("/api/requests").json()["total"] == 1
    application.repository.update_job(job["id"], status="cancelled")
    assert client.delete("/api/requests").json()["deleted"] == 1
    assert client.get("/api/requests").json()["total"] == 0
    assert client.get("/api/requests/points").content == b""
    assert client.get(f"/api/plans/saved/requests/{rid}").json()["request"]["name"] == "Origin"
    assert client.delete("/api/requests").json()["deleted"] == 0


def test_cancel_and_restart_recovery(application):
    repository = application.repository
    repository.initialize()
    snapshot = repository.snapshot(Scenario(start="2026-09-11T12:00:00Z").model_dump(mode="json"))
    job = repository.create_job("generate", {"start": "2026-09-11T12:00:00Z"}, snapshot)
    repository.cancel_job(job["id"])
    execute_work(application.factory, application.options, job["id"])
    assert repository.get_job(job["id"])["status"] == "cancelled"
    interrupted = repository.create_job("generate", {}, snapshot)

    async def restart():
        await application.start()
        await application.close()

    asyncio.run(restart())
    assert repository.get_job(interrupted["id"])["status"] == "failed"


def test_background_process_job_and_api_responsiveness(client):
    client.post("/api/requests", json=request())
    submitted = client.post(
        "/api/jobs/schedule", json={"start": "2026-09-11T12:00:00Z", "duration_seconds": 60}
    )
    assert submitted.status_code == 202
    job_id = submitted.json()["id"]
    assert client.get("/api/health").status_code == 200
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert job["status"] == "completed", job
    assert client.get(f"/api/plans/{job_id}").json()["validation"]["passed"]


def test_mcp_tools_share_catalog_and_saved_explanations(client, application):
    rid = saved_plan(application)

    async def session():
        async with Client(create_mcp(application)) as mcp:
            tools = await mcp.list_tools()
            names = {t.name for t in tools.tools}
            assert {
                "schedule_plan",
                "explain_request",
                "query_decisions",
                "save_spacecraft",
                "generate_requests",
            } <= names
            saved = await mcp.call_tool("save_request", {"request": request(energy_wh=7)})
            assert not saved.is_error
            found = await mcp.call_tool("list_requests", {"query": "Denver"})
            assert found.structured_content["total"] == 1
            explanation = await mcp.call_tool("explain_request", {"plan_id": "saved", "request_id": rid})
            assert explanation.structured_content["decision"]["status"] == "planned"
            bad = await mcp.call_tool("query_decisions", {"plan_id": "saved", "limit": 0})
            assert bad.is_error
            schema = await mcp.read_resource("orbit://schema/requests")
            assert "satellites_required" in schema.contents[0].text

    asyncio.run(session())
    assert client.get("/api/requests?q=Denver").json()["items"][0]["energy_wh"] == 7


def test_http_mcp_initialization_and_tool_call(client):
    headers = {"Accept": "application/json, text/event-stream"}
    response = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert response.status_code == 200, response.text
    response = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "system_overview", "arguments": {}},
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["structuredContent"]["database"]["schema_version"] == 2


def test_v1_migration_preserves_catalog_and_backs_up(tmp_path):
    path = tmp_path / "orbit.sqlite"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            "CREATE TABLE targets(id INTEGER PRIMARY KEY,name TEXT,latitude REAL,longitude REAL,priority INTEGER,enabled INTEGER); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE jobs(id TEXT);"
        )
        conn.execute("INSERT INTO targets VALUES(7,?,?,?,?,?)", ("Old request", 1, 2, 50, 1))
        conn.execute(
            "INSERT INTO settings VALUES(?,?)",
            ("fleet", json.dumps([{"id": "old", "name": "Old spacecraft", "kind": "demo"}])),
        )
    repository = SQLiteRepository(path)
    repository.initialize()
    repository.initialize()
    assert repository.get_request(7)["name"] == "Old request"
    assert len(repository.all_requests()) == 1 and repository.fleet()[0]["id"] == "old"
    assert (tmp_path / "backups" / "before-v2.sqlite").exists()
    assert repository.overview()["legacy_archive"]
