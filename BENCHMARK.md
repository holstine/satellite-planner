# Default workload benchmark

Acceptance budget: **under 30 seconds for solve + independent validation + database save** on the default one-hour scenario, with 100 spacecraft and 10,000 mixed-parameter requests. Generation is measured separately.

Run on the local Windows workstation (Intel Core i7-8700K, 32 GB RAM), Python 3.12, using the pinned dependencies:

```powershell
.\.venv\Scripts\python.exe scripts/benchmark.py --save
```

The benchmark uses a temporary database and does not change the working catalog. The script exits with an error if the 30-second solve/validate/save budget is exceeded. The exact latest numbers and checks are committed in [benchmark-result.json](benchmark-result.json).

## Reproducible inputs

- 100 synthetic spacecraft: 70 LEO at 550 km/53°, 15 MEO at 20,200 km/56°, 10 GEO at 35,786 km/0°, and 5 elliptical HEO at 63.4° inclination.
- Start 2026-09-11 12:00 UTC; duration 3,600 seconds.
- Seed 42; latitude −60° to 70°, full longitude; uniform area sampling.
- 10,000 generated requests without feasibility filtering; mixed priority, duration (10/20/30/45/60/90/120 seconds), per-sat energy/data costs, optical/radar sensor, daylight rules, minimum and maximum pointing angles, variable time-window starts and ends, 1–3 simultaneous spacecraft, and 1–2 collections.
- 30-second candidate-start grid, 5-second validation samples, exact collection endpoints.
- Optical daylight required; weather checks disabled for this offline benchmark.
- Priority-first allocation, capacity one per spacecraft, 10-second cooldown, initial battery 400 Wh, reserve 40 Wh, storage 10,000 MB.

## Measured result

The current mixed-orbit, unfiltered workload measured **1.219 seconds for generation**, **33.041 seconds for scheduling**, **0.180 seconds for validation**, and **0.638 seconds for saving**. Solve/validate/save is **33.859 seconds**, which exceeds the 30-second budget. Actual timings vary with machine load; consult the JSON for the latest measured values.

The deterministic workload produces **2,549 fully satisfied requests**, **54 partial requests**, and **7,397 unplanned requests**: **2,804 synchronized collections** containing **3,052 spacecraft instructions**. The validator checks **33,781 geometry samples** in addition to capacity, cooldown, windows, synchronization, repeats, sensors, energy, storage, and decision consistency.

Packed ephemeris: **866,400 bytes**. Target playback buffer: **480,000 bytes**. Saved plan, input snapshot, decisions, instructions, and artifacts occupy about **22 MB** in the isolated database.

The current catalog intentionally includes requests that may be infeasible. The scheduler is responsible for making every feasibility and allocation decision, which is reflected in the result above.

## What is and is not measured

This measures server generation, allocation, independent validation, and persistence. Tests also exercise HTTP availability during a worker job and MCP queries. Browser frame rate and visual interaction have not yet been measured. Rendering uses batched points, a bounded selected cone mesh, a coarse instruction interval index, and debounced hover requests, but those design choices alone do not establish a frame-rate result.

Longer horizons, denser candidate grids, different ephemeris providers, larger fleets, and different request distributions need separate benchmarks. No claim of optimal scheduling or continuous-time access is made.
