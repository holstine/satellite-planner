# Agent access

Start Orbit Desk's API, then configure your MCP client for **Streamable HTTP** at:

```text
http://127.0.0.1:8000/mcp/
```

The UI and MCP use the same local application services and database. Keep one API instance per database. The agent does not need a separate database connection. The endpoint binds to the local machine and checks browser origins and host headers.

## Typical workflow

1. `system_overview()` reports available schedulers, ephemeris providers, storage counts, units, and model assumptions.
2. `list_spacecraft()` and `list_requests(offset=0, limit=50)` inspect the current catalogs.
3. `create_demo_fleet(spec={"count":100})` replaces the current fleet when a synthetic constellation is wanted.
4. `generate_requests(spec={"start":"2026-09-11T12:00:00Z","count":10000,"seed":42})` starts mixed-parameter generation with access filtering. It appends by default; `replace_existing=true` explicitly replaces the catalog.
5. Poll `job_status(job_id=...)` until completed, failed, or cancelled. A job ID is returned immediately. Use `cancel_job` to request cancellation.
6. `schedule_plan(scenario={"name":"Baseline","start":"2026-09-11T12:00:00Z","duration_seconds":3600})` snapshots and schedules the catalogs. Specify `constraints`, `scheduler`, and `ephemeris_provider` when overriding defaults.
7. `plan_summary(plan_id=...)` reports outcomes and independent validation.
8. `query_decisions(plan_id=..., status="unplanned")` finds unplanned requests. `explain_request(plan_id=..., request_id=...)` returns the saved request, decision, evidence, and collection instructions.
9. `spacecraft_plan(plan_id=..., spacecraft_id=...)` shows its instruction timeline and remaining budgets. `query_instructions` filters by request or spacecraft.

Changing the current catalog never rewrites a saved plan. To try different assumptions, change inputs and create another plan.

## Tools

| Domain | Tools |
| --- | --- |
| Overview / database | `system_overview` |
| Fleet | `list_spacecraft`, `save_spacecraft`, `replace_fleet`, `create_demo_fleet`, `import_tle_fleet`, `delete_spacecraft`, `spacecraft_state` |
| Requests | `list_requests`, `get_request`, `save_request`, `bulk_create_requests`, `import_requests`, `delete_request`, `generate_requests` |
| Scheduling | `configure_constraints`, `schedule_plan`, `list_jobs`, `job_status`, `cancel_job` |
| Plan | `list_plans`, `plan_summary`, `query_decisions`, `explain_request`, `query_instructions`, `spacecraft_plan` |

Schema resources: `orbit://schema/requests`, `orbit://schema/spacecraft`, and `orbit://schema/scenario`. REST OpenAPI also exposes the same models at `/openapi.json` and `/docs`.

All list/query tools with `offset`/`limit` require `offset >= 0` and `1 <= limit <= 1000`. Catalog bulk insertion accepts a `batch` with a `requests` array. `clear_requests` deletes the current catalog while preserving saved plans and refuses to run during an active job. `save_request` creates unless `request_id` is given, in which case it replaces that record's parameters. `save_spacecraft` creates or replaces its ID. `configure_constraints` saves UI defaults; include the desired constraints in the scenario passed to `schedule_plan`.

## Explaining results accurately

Use `explain_request`, rather than inferring a reason from a map color. The recorded evidence applies to the chosen timeframe, input snapshot, search grid, and heuristic allocation. Capacity or resource failures show what blocked this run; another ordering or timeframe may produce a different result. A partial request has some collections but fewer than requested.

Energy/data are charged per participating spacecraft, and a synchronized group is committed only when every participant can satisfy the collection. Spacecraft state reports configured initial budgets; `spacecraft_plan` reports planned allocations. Solar, orbital, and resource model assumptions are included in `system_overview`.

The MCP transport is tested with the official Python MCP SDK. A minimal client example using the pinned SDK:

```python
import asyncio
from mcp import Client

async def main():
    async with Client('http://127.0.0.1:8000/mcp/') as client:
        result = await client.call_tool('system_overview', {})
        print(result.structured_content)

asyncio.run(main())
```
