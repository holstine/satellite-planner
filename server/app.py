"""Thin local REST and MCP transport adapters."""

from contextlib import asynccontextmanager
from datetime import datetime

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .application import Application
from .domain import (
    BulkRequests,
    CollectionRequest,
    Constraints,
    DemoFleet,
    DomainError,
    FleetReplace,
    Generate,
    ImportText,
    Scenario,
    Spacecraft,
    TLEImport,
)
from .mcp_server import create_mcp
from .orbits import target_vectors


def create_app(application=None):
    service = application or Application()
    mcp = create_mcp(service)
    mcp_app = mcp.streamable_http_app(streamable_http_path="/", stateless_http=True, json_response=True)

    @asynccontextmanager
    async def lifespan(app):
        await service.start()
        async with mcp.session_manager.run():
            yield
        await service.close()

    app = FastAPI(title="Orbit Desk", version="2.0.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])
    app.state.application = service
    app.mount("/mcp", mcp_app)

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin not in (
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8000",
            "http://localhost:8000",
        ):
            return Response("Origin not allowed", status_code=403)
        try:
            oversized = int(request.headers.get("content-length", 0)) > 25_000_000
        except ValueError:
            return Response("Invalid content length", status_code=400)
        if oversized:
            return Response("Import exceeds 25 MB", status_code=413)
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return dict(
            status="ok",
            version=2,
            storage=service.repository.overview()["adapter"],
            worker_processes=1,
            mcp="/mcp/",
        )

    @app.get("/api/providers")
    def providers():
        return service.providers.describe()

    @app.get("/api/database")
    def database():
        return service.repository.overview()

    @app.get("/api/requests")
    def requests(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=1000), q: str = ""):
        return service.repository.list_requests(offset, limit, q)

    @app.delete("/api/requests")
    def clear_requests():
        return dict(deleted=service.repository.clear_requests())

    @app.get("/api/requests/points")
    def points():
        rows = service.repository.all_requests()
        xyz, _ = target_vectors(rows)
        data = np.column_stack(([r["id"] for r in rows], xyz, [r["enabled"] for r in rows])).astype("<f8")
        return Response(
            data.tobytes(), media_type="application/octet-stream", headers={"X-Record-Stride": "5"}
        )

    @app.get("/api/requests/export")
    def export():
        return Response(
            service.requests.export_csv(),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="requests.csv"'},
        )

    @app.post("/api/requests", status_code=201)
    def create_request(body: CollectionRequest):
        return service.repository.put_request(body.model_dump())

    @app.post("/api/requests/bulk", status_code=201)
    def bulk(body: BulkRequests):
        return dict(inserted=service.repository.add_requests([r.model_dump() for r in body.requests]))

    @app.post("/api/requests/import", status_code=201)
    def import_requests(body: ImportText):
        return service.requests.import_text(body)

    @app.get("/api/requests/{request_id}")
    def get_request(request_id: int):
        return service.repository.get_request(request_id)

    @app.put("/api/requests/{request_id}")
    def update_request(request_id: int, body: CollectionRequest):
        return service.repository.put_request(body.model_dump(), request_id)

    @app.delete("/api/requests/{request_id}")
    def delete_request(request_id: int):
        service.repository.delete_request(request_id)
        return dict(deleted=request_id)

    @app.get("/api/constraints")
    def constraints():
        return service.constraints()

    @app.put("/api/constraints")
    def update_constraints(body: Constraints):
        return service.save_constraints(body)

    @app.get("/api/fleet")
    def fleet():
        return service.repository.fleet()

    @app.put("/api/fleet")
    def replace_fleet(body: FleetReplace):
        service.repository.replace_fleet([s.model_dump(mode="json") for s in body.spacecraft])
        return service.repository.fleet()

    @app.put("/api/fleet/demo")
    def demo(body: DemoFleet):
        return service.demo_fleet(body)

    @app.put("/api/fleet/tle")
    def tle(body: TLEImport):
        return service.import_tle(body)

    @app.put("/api/fleet/{spacecraft_id}")
    def spacecraft(spacecraft_id: str, body: Spacecraft):
        if spacecraft_id != body.id:
            raise DomainError("Spacecraft ID must match URL")
        service.repository.put_spacecraft(body.model_dump(mode="json"))
        return body

    @app.delete("/api/fleet/{spacecraft_id}")
    def delete_spacecraft(spacecraft_id: str):
        service.repository.delete_spacecraft(spacecraft_id)
        return dict(deleted=spacecraft_id)

    @app.get("/api/fleet/{spacecraft_id}/state")
    def state(spacecraft_id: str, time: datetime):
        if time.tzinfo is None:
            raise DomainError("State time requires a UTC offset")
        return service.fleet.state(spacecraft_id, time.timestamp())

    @app.post("/api/jobs/schedule", status_code=202)
    async def schedule(body: Scenario):
        return await service.submit("schedule", body)

    @app.post("/api/jobs/generate", status_code=202)
    async def generate(body: Generate):
        return await service.submit("generate", body)

    @app.get("/api/jobs")
    def jobs():
        return service.repository.list_jobs()

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        return service.job(job_id)

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel(job_id: str):
        return service.repository.cancel_job(job_id)

    @app.get("/api/plans")
    def plans():
        return service.repository.list_plans()

    @app.get("/api/plans/{plan_id}")
    def plan(plan_id: str):
        return service.plans.summary(plan_id)

    @app.get("/api/plans/{plan_id}/snapshot")
    def snapshot(plan_id: str):
        return service.repository.plan_snapshot(plan_id)

    @app.get("/api/plans/{plan_id}/decisions")
    def decisions(
        plan_id: str,
        status: str | None = None,
        reason: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=1000),
    ):
        return service.repository.plan_decisions(plan_id, status, reason, offset, limit)

    @app.get("/api/plans/{plan_id}/requests/{request_id}")
    def explain(plan_id: str, request_id: int):
        return service.plans.explain(plan_id, request_id)

    @app.get("/api/plans/{plan_id}/spacecraft/{spacecraft_id}")
    def timeline(
        plan_id: str, spacecraft_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=1000)
    ):
        return service.plans.spacecraft_timeline(plan_id, spacecraft_id, offset, limit)

    @app.get("/api/plans/{plan_id}/instructions")
    def instructions(
        plan_id: str,
        request_id: int | None = None,
        spacecraft_id: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=1000),
    ):
        return service.repository.plan_instructions(plan_id, request_id, spacecraft_id, offset, limit)

    @app.get("/api/plans/{plan_id}/playback")
    def playback(plan_id: str):
        result = service.repository.get_plan(plan_id)
        result["instructions"] = service.repository.plan_instructions(plan_id, limit=2000000)["items"]
        return result

    @app.get("/api/plans/{plan_id}/files/{name}")
    def artifact(plan_id: str, name: str):
        return Response(service.repository.artifact(plan_id, name), media_type="application/octet-stream")

    return app


app = create_app()
