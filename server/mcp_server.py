"""Agent tools use the same application boundary and saved evidence as the UI."""

from datetime import datetime

from mcp.server import MCPServer

from .domain import (
    BulkRequests,
    CollectionEdit,
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
    WeatherRefresh,
    WhatIfSpec,
)


def page(offset, limit):
    if offset < 0 or not 1 <= limit <= 1000:
        raise DomainError("Use offset >= 0 and limit between 1 and 1000")


def create_mcp(service):
    mcp = MCPServer(
        "Orbit Desk",
        version="2.0.0",
        instructions="Manage spacecraft and collection requests, generate workloads, schedule immutable plans, and inspect instructions and factual rejection evidence. Times require UTC offsets. Jobs are asynchronous; poll job_status. Queries are paginated. Energy and data costs apply to each participating spacecraft. Explain sampled heuristic outcomes, not proofs of optimality.",
    )

    @mcp.tool()
    def system_overview() -> dict[str, object]:
        """List providers, database counts, units, and modeling assumptions."""
        return dict(
            providers=service.providers.describe(),
            database=service.repository.overview(),
            constraints=service.constraints(),
        )

    @mcp.tool()
    def list_requests(offset: int = 0, limit: int = 50, query: str = "") -> dict[str, object]:
        """Search the current request catalog by name."""
        page(offset, limit)
        return service.repository.list_requests(offset, limit, query)

    @mcp.tool()
    def clear_requests() -> dict[str, object]:
        """Delete the entire current request catalog. Saved plans remain available; active jobs must finish first."""
        return dict(deleted=service.repository.clear_requests())

    @mcp.tool()
    def get_request(request_id: int) -> dict[str, object]:
        """Read every parameter of a current catalog request."""
        return service.repository.get_request(request_id)

    @mcp.tool()
    def save_request(request: CollectionRequest, request_id: int | None = None) -> dict[str, object]:
        """Create a request, or replace parameters of an existing ID."""
        return service.repository.put_request(request.model_dump(), request_id)

    @mcp.tool()
    def bulk_create_requests(batch: BulkRequests) -> dict[str, object]:
        """Atomically validate and insert a batch of requests."""
        return dict(inserted=service.repository.add_requests([r.model_dump() for r in batch.requests]))

    @mcp.tool()
    def import_requests(body: ImportText) -> dict[str, object]:
        """Import CSV or a JSON array using the full request schema."""
        return service.requests.import_text(body)

    @mcp.tool()
    def delete_request(request_id: int) -> dict[str, object]:
        """Delete one catalog request. Saved plan snapshots are retained."""
        service.repository.delete_request(request_id)
        return dict(deleted=request_id)

    @mcp.tool()
    def list_spacecraft() -> list[dict]:
        """Read fleet ephemeris definitions, sensors, and initial resource budgets."""
        return service.repository.fleet()

    @mcp.tool()
    def save_spacecraft(spacecraft: Spacecraft) -> dict[str, object]:
        """Create or replace a spacecraft, including demo, TLE, or timestamped ECEF ephemeris."""
        record = spacecraft.model_dump(mode="json")
        service.repository.put_spacecraft(record)
        return record

    @mcp.tool()
    def replace_fleet(fleet: FleetReplace) -> dict[str, object]:
        """Replace the current fleet with validated unique spacecraft."""
        service.repository.replace_fleet([s.model_dump(mode="json") for s in fleet.spacecraft])
        return dict(spacecraft=len(fleet.spacecraft))

    @mcp.tool()
    def create_demo_fleet(spec: DemoFleet) -> dict[str, object]:
        """Replace fleet with a synthetic constellation; default 100 spacecraft."""
        return dict(spacecraft=len(service.demo_fleet(spec)))

    @mcp.tool()
    def import_tle_fleet(body: TLEImport) -> dict[str, object]:
        """Replace fleet from checksum-validated TLE pairs with optional names."""
        return dict(spacecraft=len(service.import_tle(body)))

    @mcp.tool()
    def delete_spacecraft(spacecraft_id: str) -> dict[str, object]:
        """Delete one spacecraft from the current catalog."""
        service.repository.delete_spacecraft(spacecraft_id)
        return dict(deleted=spacecraft_id)

    @mcp.tool()
    def spacecraft_state(spacecraft_id: str, time: datetime) -> dict[str, object]:
        """Propagate a spacecraft to an absolute time; initial budgets are not telemetry."""
        if time.tzinfo is None:
            raise DomainError("Time requires a UTC offset")
        return service.fleet.state(spacecraft_id, time.timestamp())

    @mcp.tool()
    def configure_constraints(constraints: Constraints) -> dict[str, object]:
        """Save default global guardrails. Pass them in a scenario when scheduling."""
        return service.save_constraints(constraints)

    @mcp.tool()
    async def generate_requests(spec: Generate) -> dict[str, object]:
        """Create exactly the requested count of random requests, without feasibility checks or fleet requirements. Scheduling evaluates them later. Append unless replace_existing is explicitly true."""
        return await service.submit("generate", spec)

    @mcp.tool()
    async def schedule_plan(scenario: Scenario) -> dict[str, object]:
        """Snapshot the current catalog and start scheduling in a background process."""
        return await service.submit("schedule", scenario)

    @mcp.tool()
    async def what_if_plan(plan_id: str, changes: WhatIfSpec) -> dict[str, object]:
        """Create a validated immutable variant. edit keeps existing collections; fill schedules around them; reschedule rearranges everything. Batch request/fleet changes and collection add/remove/move operations are atomic. save=false previews validation/comparison only. Original plans and live catalogs are never changed. Poll job_status for validation failures or new plan_id."""
        return await service.submit_whatif(plan_id, changes)

    @mcp.tool()
    async def add_plan_collection(
        plan_id: str, request_id: int, start_seconds: int, spacecraft_ids: list[str]
    ) -> dict[str, object]:
        """Add a synchronized collection in a new variant, only if full plan validation passes."""
        return await service.submit_whatif(
            plan_id,
            WhatIfSpec(
                collections=[
                    CollectionEdit(
                        action="add",
                        request_id=request_id,
                        start_seconds=start_seconds,
                        spacecraft_ids=spacecraft_ids,
                    )
                ]
            ),
        )

    @mcp.tool()
    async def remove_plan_collection(plan_id: str, collection_id: str) -> dict[str, object]:
        """Remove all participants of a collection in a new variant; recompute resources and decisions."""
        return await service.submit_whatif(
            plan_id, WhatIfSpec(collections=[CollectionEdit(action="remove", collection_id=collection_id)])
        )

    @mcp.tool()
    async def move_plan_collection(
        plan_id: str, collection_id: str, start_seconds: int, spacecraft_ids: list[str] | None = None
    ) -> dict[str, object]:
        """Try a new time/spacecraft for a collection; invalid variants are rejected with no saved plan."""
        return await service.submit_whatif(
            plan_id,
            WhatIfSpec(
                collections=[
                    CollectionEdit(
                        action="move",
                        collection_id=collection_id,
                        start_seconds=start_seconds,
                        spacecraft_ids=spacecraft_ids,
                    )
                ]
            ),
        )

    @mcp.tool()
    def compare_plans(original_plan_id: str, variant_plan_id: str) -> dict[str, object]:
        """Report added, removed, rearranged and retained collections, plus count deltas."""
        return service.compare(original_plan_id, variant_plan_id)

    @mcp.tool()
    async def refresh_weather(spec: WeatherRefresh) -> dict[str, object]:
        """Fetch real hourly model weather into the cache in a background job. Uses plan snapshot locations if plan_id is set, otherwise current catalog. Acquisition is rate-limited separately from scheduling. max_locations bounds new downloads; cached locations are reused for one hour."""
        return await service.refresh_weather(spec)

    @mcp.tool()
    def query_cached_weather(spec: WeatherRefresh, offset: int = 0, limit: int = 10) -> dict[str, object]:
        """Inspect fresh cached cloud %, precipitation mm/hour and wind m/s, with source and timestamps. Does not download. Missing coverage cannot satisfy weather constraints."""
        page(offset, limit)
        captured = service.weather.capture(service.weather_input(spec))
        cells = list(captured.cells.values())
        return dict(
            total=len(cells),
            captured_at=captured.captured_at,
            attribution=captured.attribution,
            items=[c.model_dump() for c in cells[offset : offset + limit]],
        )

    @mcp.tool()
    def request_plan_weather(plan_id: str, request_id: int) -> dict[str, object]:
        """Read the exact saved weather evidence for a request, not today's replacement forecast."""
        evidence = service.repository.decision(plan_id, request_id)
        weather = service.repository.plan_snapshot(plan_id).get("weather", {})
        key = weather.get("request_cells", {}).get(str(request_id))
        return dict(
            request=evidence["request"],
            decision=evidence["decision"],
            captured_at=weather.get("captured_at"),
            cell=weather.get("cells", {}).get(key),
            attribution=weather.get("attribution"),
        )

    @mcp.tool()
    def list_jobs() -> list[dict]:
        """List the 30 most recent background jobs."""
        return service.repository.list_jobs()

    @mcp.tool()
    def job_status(job_id: str) -> dict[str, object]:
        """Read job progress, completion result, or error."""
        return service.job(job_id)

    @mcp.tool()
    def cancel_job(job_id: str) -> dict[str, object]:
        """Request cooperative cancellation before results are saved."""
        return service.repository.cancel_job(job_id)

    @mcp.tool()
    def list_plans() -> list[dict]:
        """List the 30 most recent immutable plans."""
        return service.repository.list_plans()

    @mcp.tool()
    def plan_summary(plan_id: str) -> dict[str, object]:
        """Summarize counts, reasons, solver, and independent validation checks."""
        return service.plans.summary(plan_id)

    @mcp.tool()
    def query_decisions(
        plan_id: str, status: str | None = None, reason: str | None = None, offset: int = 0, limit: int = 50
    ) -> dict[str, object]:
        """Find planned, partial, unplanned, or disabled requests; optionally filter a reason code."""
        page(offset, limit)
        return service.repository.plan_decisions(plan_id, status, reason, offset, limit)

    @mcp.tool()
    def explain_request(plan_id: str, request_id: int) -> dict[str, object]:
        """Explain a scheduling result using saved inputs, evidence counters, and collection instructions."""
        return service.plans.explain(plan_id, request_id)

    @mcp.tool()
    def query_instructions(
        plan_id: str,
        request_id: int | None = None,
        spacecraft_id: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, object]:
        """Read commands, participant spacecraft, times, and resource allocations."""
        page(offset, limit)
        return service.repository.plan_instructions(plan_id, request_id, spacecraft_id, offset, limit)

    @mcp.tool()
    def spacecraft_plan(
        plan_id: str, spacecraft_id: str, offset: int = 0, limit: int = 100
    ) -> dict[str, object]:
        """Inspect a spacecraft timeline and final planned resource budgets."""
        page(offset, limit)
        return service.plans.spacecraft_timeline(plan_id, spacecraft_id, offset, limit)

    @mcp.resource("orbit://schema/requests")
    def request_schema() -> dict[str, object]:
        return CollectionRequest.model_json_schema()

    @mcp.resource("orbit://schema/spacecraft")
    def spacecraft_schema() -> dict[str, object]:
        return Spacecraft.model_json_schema()

    @mcp.resource("orbit://schema/scenario")
    def scenario_schema() -> dict[str, object]:
        return Scenario.model_json_schema()

    @mcp.resource("orbit://schema/whatif")
    def whatif_schema() -> dict[str, object]:
        return WhatIfSpec.model_json_schema()

    @mcp.resource("orbit://schema/weather-refresh")
    def weather_schema() -> dict[str, object]:
        return WeatherRefresh.model_json_schema()

    return mcp
