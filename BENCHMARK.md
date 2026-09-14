# Local baseline — 2026-09-11

Measured on this workstation: Intel Core i7-8700K (6 cores / 12 threads), about 32 GB RAM, Windows, Python 3.12.0. One CPU job process; timings below are a single run, not a statistical performance guarantee. Dependency installation and web development were also active.

Scenario: 2026-09-11 12:00 UTC, one hour, 100 synthetic circular satellites at 550 km / 53° inclination. Constraints: daylight, sun elevation >=0°, target elevation >=10°, off-nadir <=45°, capacity 1, 30 s dwell, 10 s cooldown, observe once, candidate starts every 30 s, validation every 5 s including endpoints.

| Work | Measured result |
|---|---:|
| Random generation, 10,000 observable targets | 2.909 s |
| Random candidates tested (seed 42) | 22,024 |
| Candidates rejected by sampled access | 11,578 |
| Additional feasible candidates beyond requested count | 446 |
| Schedule, including binary artifact creation | 2.122 s |
| Targets passing access | 10,000 |
| Targets assigned / observations | 3,202 |
| Observable but unassigned | 6,798 |
| Spatial candidates entering narrow checks | 400,866 |
| Ephemerides, 361 samples × 100 satellites × XYZ Float64 | 866,400 bytes |
| Target snapshot, 10,000 rows × 6 Float64 | 480,000 bytes |

Generation input bounds: latitude -60° to 70°, longitude -180° to 180°. Generation excludes candidates with no complete sampled access interval in this scenario. It does not enforce eventual schedule allocation.

The candidate count is the sum entering the first narrow-phase check per satellite/start pair. A candidate may then undergo several dwell-time checks, so this number is not the total number of geometry evaluations.

Artifacts are under `data/jobs/46ab3067004a4eb4ba3394e0b6d0959b/`; generation job is `3849391307fb4c198fd8c52001c201d0`. Load the completed run from the Plan tab, or reload the app to open the latest run.

**Not measured:** browser frame rate, GPU time, interaction latency, and sustained memory behavior. The app shows rendered FPS during playback, but no browser performance acceptance test was run. The synthetic workload does not establish real TLE propagation performance or continuous-time schedule accuracy.

Validation includes a randomized comparison of indexed candidate filtering against brute-force visibility and deterministic tests of capacity, cooldown, priority, daylight throughout dwell, and target exclusivity. These checks validate implemented sampled rules; they do not establish mission-grade orbital accuracy or global scheduling optimality.
