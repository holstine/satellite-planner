# Orbit Desk

A local Cesium workspace and MCP server for spacecraft collection planning. The default workload is **100 spacecraft, 10,000 requests, and a one-hour plan**, with a **30-second scheduling budget**.

## Run locally

Requires Node 22.13+ and Python 3.12+. In PowerShell:

```powershell
.\start.ps1 -Install   # first run or changed dependencies
.\start.ps1            # subsequent runs
```

Open **http://127.0.0.1:5173**. API documentation: **http://127.0.0.1:8000/docs**. MCP Streamable HTTP endpoint: **http://127.0.0.1:8000/mcp/**. See [MCP.md](MCP.md) for the agent workflow.

For separate terminals:

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.app:app --host 127.0.0.1 --port 8000
npm run dev
```

Both services bind to loopback. This is a single-user local application. It serves Cesium, its workers, and Natural Earth imagery locally without an ion token. Data lives in `data/orbit.sqlite`; set `ORBIT_DATA_DIR` before startup to choose another directory. The production flow is `npm run build`, then `npm start`, with the API running separately.

## Workflow

1. **Fleet:** the initial catalog contains 100 synthetic spacecraft: 70 LEO, 15 MEO, 10 GEO, and 5 HEO. The HEO entries use elliptical two-body orbits; the others are circular. Edit individual resource budgets, sensor availability, and orbit parameters. Replace the constellation with a mixed or LEO-only demo fleet, TLE data, or JSON with demo, TLE, or sampled ECEF ephemeris.
2. **Schedule:** choose the UTC start, timeframe, provider, and shared limits. Request and spacecraft limits can make a shared constraint stricter. Choose priority-first or earliest-deadline allocation.
3. **Requests:** add/edit/delete requests, import CSV or JSON in bulk, or generate 10,000 seeded requests with mixed duration, priority, energy, data, sensor, sunlight, window, repeat, and simultaneous-spacecraft requirements. Generation appends to the existing catalog. Optional feasibility filtering uses the Schedule tab's timeframe and guardrails.
4. **Build plan:** a background process searches opportunities, allocates collections, independently validates the result, and saves the plan with its input snapshot. The API remains available; progress and cancellation are exposed in the UI and MCP.
5. **Plan:** choose a saved plan; filter fulfilled, partial, unplanned, or disabled requests; read recorded explanations and evidence; inspect spacecraft command timelines and final resource budgets. Click a timeline item to seek playback.
6. **Globe:** play, pause, change speed, and scrub. Select a spacecraft for a filled field-of-regard volume and ellipsoid horizon. Hover a target for its collection count, participants, times, and decision. The map layer menu controls target points, active collection lines, visibility volume, horizon, and access filtering.

The sidebar uses a bounded vertical tab layout: the selected panel starts directly below its tab chooser and scrolls independently of the globe. Requests includes **Clear all requests** and a **Replace current request catalog** toggle (on by default in the UI). Replacement saves the generated batch atomically; saved plans keep their snapshots. Random generation varies time on target from 10–120 seconds along with resource costs, time windows, angles, sensors, repeat counts, and spacecraft counts.

### Request data

```csv
name,latitude,longitude,priority,duration_seconds,energy_wh,data_mb,satellites_required,collections_required,daylight_only,sensor
Denver,39.74,-104.99,90,30,5,50,2,1,true,optical
Tokyo,35.68,139.69,50,20,3,20,1,2,false,radar
```

Only name, latitude, and longitude are required. Export CSV to get the complete template. Imports are validated atomically; one invalid row rejects the batch. Blank CSV cells use defaults. JSON imports accept an array of the same objects. Unknown fields are rejected.

- Angles are degrees; coordinates lie on the WGS84 surface.
- Duration, revisit gap, and window bounds are seconds. Windows are relative to scenario start; a null end means scenario end.
- Energy (Wh) and data (MB) costs apply to **each participating spacecraft**.
- A collection with multiple spacecraft is allocated atomically, with the same start/end on every participant.
- Repeat collections observe the requested gap after the previous collection ends.
- Battery reserve, storage, sensor compatibility, per-spacecraft capacity, shared capacity, and per-lane cooldown always apply.
- Current resource accounting reserves collection costs at its start from the configured initial budget.

## Replaceable parts

| Part | Contract / implementation | Responsibility |
| --- | --- | --- |
| Fleet | `Spacecraft`, `EphemerisProvider`; `server/fleet.py` | Initial state, TLE validation, demo propagation, sampled ephemeris interpolation |
| Requests | `CollectionRequest`; `server/requests.py` | Validation, CRUD via repository, atomic import/export, reproducible generation |
| Scheduling | `Scheduler`; `server/scheduling.py`, `server/visibility.py` | Indexed access search and allocation policy |
| Plan | `PlanSnapshot`, `PlanResult`, `CollectionInstruction`, `RequestDecision`; `server/plans.py` | Immutable instructions, independent validation, evidence and timeline queries |
| Visualization | `Playback`, `GlobeOptions`; `components/orbit-globe.tsx`, `lib/plan-playback.ts` | Cesium batches, interval-indexed playback, selected details and hover inspection |
| Database | `Repository`; `server/storage.py` | SQLite migration, catalogs, jobs, immutable plans, indexed decisions/instructions, binary artifacts |
| Application / transports | `server/application.py`, `server/app.py`, `server/mcp_server.py` | Shared application services used by REST and MCP; bounded process worker |

Provider protocols are in [server/contracts.py](server/contracts.py). The built-in scheduler implementations (`priority-greedy`, `earliest-deadline`) use the same contracts and result validator. Add a trusted Python module exposing `register(providers)` and set `ORBIT_PROVIDER_MODULES=my_package.providers` to register another scheduler or ephemeris provider. Both the API process and worker load this registry. A scheduler implements `solve(plan_id, snapshot, ephemeris, progress) -> SolvedPlan`; an ephemeris provider returns finite ECEF meters shaped `(time, spacecraft, 3)`.

Set `ORBIT_REPOSITORY_FACTORY=my_package.storage:RepositoryClass` to replace storage. The factory must implement the full repository protocol with durable, concurrency-safe job state. `Application(factory=..., options=...)` injects factory options; the same configuration is passed to the worker. No database-specific SQL is exposed to the agent.

### Database migration

The first v2 startup backs up an existing v1 database to `data/backups/before-v2.sqlite`, preserves request IDs, migrates the target catalog and fleet, and keeps old target/job tables as `legacy_targets_v1` and `legacy_jobs_v1`. Original job files are retained. Legacy runs remain archived on disk; the new Plan tab lists v2 plans with recorded decisions. Migration is idempotent. New catalog edits and deletes never change saved plan inputs or instructions.

SQLite uses WAL, parameterized SQL, and indexes for request/spacecraft timelines and status/reason queries. Plans, their snapshots, per-request decisions, instructions, and binary playback buffers are in the database. No automatic retention deletion is performed.

## Performance and interpretation

See [BENCHMARK.md](BENCHMARK.md) and [benchmark-result.json](benchmark-result.json) for measured results. The reproducible benchmark fails if solving, independent validation, and saving exceed 30 seconds on the machine running it.

- Spatial cKDTree filtering reduces spacecraft/request comparisons before vectorized angle and sunlight checks.
- Ephemeris is propagated once at unique search timestamps. Requests with different durations share validation samples. Fulfilled requests leave the remaining search.
- Generation stops searching a candidate once one feasible synchronized collection is found. It checks initial resource budgets, but does not guarantee all repeats or sufficient schedule capacity. Ten times the requested count is the maximum generation attempt budget.
- One process performs CPU work while the API serves CRUD and job status. Concurrent compute submissions return a conflict instead of creating an unbounded queue. Cancellation is cooperative at progress checkpoints. Interrupted jobs are marked failed on startup.
- Targets and satellites use batched point primitives, with no HTML per object. Ephemeris/target positions are little-endian Float64 buffers. Active commands use a coarse interval index rather than per-second expansion or full-plan frame scans. A single closed cone mesh updates at most 5 Hz. Hover lookup is debounced and cached with a 128-entry bound.
- `positions.bin` has `(sample_count, spacecraft_count, 3)` XYZ meters. Samples use `sample_step` seconds and include the exact scenario endpoint; the last interval can be shorter. `targets.bin` records are `[id,x,y,z,feasible,scheduled]`; current catalog points are `[id,x,y,z,enabled]`.

Unplanned explanations are **evidence from this sampled heuristic run**, not a proof of global infeasibility. Counts distinguish fulfilled requests, partial requests, synchronized collections, and per-spacecraft instructions. Evidence records spatial candidates, angle/daylight/sensor/duration failures, synchronized opportunities, and allocation blockers.

### Modeling bounds

The built-in model uses two-body demo orbits: circular LEO/MEO/GEO and elliptical HEO, or SGP4 TLE propagation with a GMST Earth-fixed rotation. Sampled ephemerides interpolate in ECEF and reject extrapolation. Solar direction is approximate. Access checks include collection endpoints and samples across its duration; extra duration endpoints may add conservative checks for longer requests. Opportunities between candidate starts can be missed.

The selected volume shows the spacecraft/shared geometric field of regard clipped to the ellipsoid. Request-specific pointing limits and sunlight are evaluated by the scheduler. Initial budgets are configured planning state. Recharge, bus power, downlink, slew dynamics, terrain, weather, and spacecraft-specific command encoding are extension work. Capacity lanes assume independent simultaneous collection capability and fixed cooldown. These assumptions are reported by the API/MCP provider overview.

Guardrails allow 100,000 rows per bulk operation, 1,000 spacecraft per fleet replacement, up to 24-hour scenarios, and five million propagation sample/spacecraft pairs. The 30-second budget is for the default one-hour, 100 × 10,000 benchmark; larger workloads or finer time grids need separate measurement.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check server tests scripts/benchmark.py
node --experimental-strip-types --test tests/playback.test.mjs
npx tsc --noEmit
npm run lint
npm run build
.\.venv\Scripts\python.exe scripts/benchmark.py --save
```

Tests cover allocation and independent rejection checks, resource accounting, simultaneous groups, repeat gaps, time windows, daylight throughout dwell, broad-phase completeness against brute force, reproducibility/date-line bounds, sampled ephemeris, immutable snapshots, migration, CRUD/imports, background jobs, cancellation/restart recovery, MCP in-process and HTTP transport, and playback interval boundaries. Browser visual inspection and frame-rate measurements remain pending browser-testing authorization.
