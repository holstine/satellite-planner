# Orbit Desk

Local Cesium satellite visualization and target scheduling workspace. Initial engineering target: **100 satellites and 10,000 targets**.

## Run

Requires Node 22.13+ and Python 3.12+. From PowerShell in this folder:

```powershell
.\start.ps1 -Install  # first run; installs locked dependencies
.\start.ps1           # subsequent runs
```

Open **http://127.0.0.1:5173**. API documentation: **http://127.0.0.1:8000/docs**.

Or use two terminals:

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.app:app --host 127.0.0.1 --port 8000
npm run dev
```

Both servers bind to loopback. This is a single-user local application, with no account system. Do not expose these development ports as a shared service. SQLite and run artifacts persist in `data/`. Set `ORBIT_DATA_DIR` to select another directory before starting the API.

## Workflow

1. **Fleet:** use the included 100-satellite synthetic constellation or replace it with TLEs. Two-line and named three-line input is supported; line checksums and catalog IDs are validated.
2. **Plan:** select start in UTC and duration, then edit daylight, sun elevation, minimum look elevation, maximum off-nadir angle, satellite capacity, dwell, cooldown, and revisit rules. Save defaults if desired.
3. **Targets:** generate seeded random targets (up to 100,000 per job), optionally filtered to those observable in this timeframe under current rules. Geographic bounds support date-line crossing. Generation samples latitude uniformly in sine(latitude), avoiding polar overpopulation. It tries at most ten times the requested count and reports a shortfall when constraints cannot be met.
4. Alternatively, paste or upload CSV/JSON, add individual targets, edit priorities/coordinates/enabled state, delete targets, or export CSV. Imports are atomic and validated before persistence. Target lists are paginated.
5. **Compute schedule:** the API snapshots enabled targets, the constellation, timeframe, and constraints. A separate process computes results without blocking API requests. Polling reports progress; cancellation is cooperative.
6. Play, pause, change speed, and scrub the saved run. Select a satellite by clicking its point or using the selector. Toggle target points, active observation lines, selected field of regard, and its geometric horizon. Load past runs or export schedule JSON. Reloading the page opens the most recent completed run.

CSV example (optional fields may be omitted):

```csv
name,latitude,longitude,priority,enabled
Denver,39.74,-104.99,10,true
Tokyo,35.68,139.69,5,true
```

JSON import is an array of objects with the same fields. Larger priority values win. Coordinates are degrees on the WGS84 surface; targets currently have zero height.

## Architecture and performance

- **Web:** React/Vinext + CesiumJS. Cesium code, workers, and Natural Earth imagery are served locally, without an ion token or external imagery request. Assets are copied from the pinned Cesium package before development/build.
- **Rendering:** static targets and moving satellites use separate `PointPrimitiveCollection`s. Dense objects have no per-object HTML or labels. Packed Float64 position buffers avoid parsing coordinate JSON. The browser linearly interpolates 10-second Earth-fixed ephemeris samples. Detail geometry is restricted to one selected satellite, with a 32-segment field boundary, eight spokes, translucent triangles, and a 64-segment ellipsoid horizon. Detail refresh is capped at 5 Hz; actual updates may be less frequent at high playback speeds.
- **Server:** FastAPI, SQLite WAL, one bounded CPU worker process, NumPy, SciPy cKDTree, and SGP4. A job uses a frozen input snapshot. Only one compute job can run at a time; jobs survive in history, and interrupted jobs are marked failed after restart.
- **Scheduling:** propagate once for unique timestamps, query spatial candidates conservatively, then apply vectorized WGS84 surface-normal elevation, off-nadir, and solar-elevation checks. Check each dwell at the selected validation interval, including both endpoints. A deterministic priority-first greedy assignment enforces satellite capacity, per-lane cooldown, and target exclusivity; it is not a global optimizer.
- **Filtering:** observable means at least one complete sampled dwell passes geometric/daylight rules. Unassigned means observable but omitted by the greedy assignment. An unassigned target is not proven unschedulable. Capacity rules cannot be used as an independent yes/no geographic filter.
- **Storage:** job manifests and original inputs are JSON; ephemerides and target points are little-endian Float64 binary. `positions.bin` shape is `(sample_count, satellite_count, 3)`, XYZ meters. Run `targets.bin` rows are `[id,x,y,z,feasible,scheduled]`; current target points are `[id,x,y,z,enabled]`. Target edits and fleet replacements never modify saved runs.
- **Bounds:** 100,000 rows per import/generation, 1,000 satellites, up to 24-hour scenarios, and five million propagation sample/satellite pairs per job. The initial supported benchmark is substantially below these guardrails. Input snapshots and artifacts accumulate on disk; no automatic retention deletion is performed.

See [BENCHMARK.md](BENCHMARK.md) for measured local results. Performance targets are not universal hardware guarantees. Browser frame rate has not yet been measured through automated browser testing.

## Accuracy and current limits

Synthetic satellites use circular two-body orbits for repeatable demonstrations. Imported TLEs use SGP4 TEME positions rotated using GMST, without Earth-orientation/polar-motion corrections. Solar direction is a low-order approximation; no atmospheric refraction or terrain mask is included. Visibility is sampled, not a continuous-time proof; short access windows between candidate starts can be missed. The selected cone depicts geometric field of regard clipped to the ellipsoid, not the full daylight/elevation feasibility mask.

Observation durations are scenario-wide. No attitude/slew-rate model, weather, land-only mask, target altitude, battery, downlink, storage, sensor-specific constraints, or optimal scheduling solver is implemented yet. Cooldown is a fixed per-capacity-lane dead time, not a physical slew simulation. At capacity >1, lanes are independent; there is no modeled shared spacecraft pointing constraint. SGP4 fidelity depends on element age and validity. This is a planning prototype, not an operational flight-plan generator.

For larger deployments, keep this API/worker boundary, add explicit jobs/retention, use spatially tiled target delivery and visibility-driven level of detail, split ephemerides into time chunks, and benchmark a worker pool before adding distributed scheduling. PostgreSQL/PostGIS is a sensible multi-user persistence migration when needed; it is not required for the current local scale.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pytest -q
npx tsc --noEmit
npm run build
npm run lint
```

The test suite checks spatial broad-phase completeness against brute force, daylight across dwell, horizon/off-nadir rejection, scheduler priority/capacity/cooldown/uniqueness, cancellation, random reproducibility, binary layouts, CRUD, atomic imports, persistent constraints, and TLE validation.

The development server proxies `/api` to FastAPI. `npm start` serves the production build with the same API forwarding configured in `next.config.ts`; start FastAPI separately first. `start.ps1` uses the development flow. Application lint excludes the unmodified generated UI catalog and its mobile hook; TypeScript still checks the full project.

Reference APIs: [Cesium point collections](https://cesium.com/learn/cesiumjs/ref-doc/PointPrimitiveCollection.html), [Cesium scene rendering](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html), [SGP4 implementation](https://pypi.org/project/sgp4/), [CelesTrak SGP4 tutorial](https://www.celestrak.org/software/tutorials/sgp4.php).
