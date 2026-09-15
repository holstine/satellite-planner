"""Reproduce the 100 spacecraft / 10,000 mixed requests baseline in isolation."""

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.domain import Generate, PlanSnapshot, RequestRecord, Scenario, Spacecraft
from server.fleet import HybridEphemeris
from server.orbits import demo_fleet
from server.plans import validate_plan
from server.requests import generate_requests
from server.scheduling import GreedyScheduler
from server.storage import SQLiteRepository


def main():
    begun = time.perf_counter()
    spec = Generate(start="2026-09-11T12:00:00Z")
    fleet = [Spacecraft.model_validate(s) for s in demo_fleet(100)]
    provider = HybridEphemeris()
    last = [0]

    def progress(fraction, message):
        if time.perf_counter() - last[0] > 2:
            print(message, flush=True)
            last[0] = time.perf_counter()

    generated = generate_requests(spec, progress)
    snapshot = PlanSnapshot(
        scenario=Scenario.model_validate(spec.model_dump(include=set(Scenario.model_fields))),
        spacecraft=fleet,
        requests=[RequestRecord(id=i + 1, **r) for i, r in enumerate(generated["records"])],
    )
    solved = GreedyScheduler().solve("benchmark", snapshot, provider, progress)
    validation_start = time.perf_counter()
    solved.result.validation = validate_plan(solved.result, snapshot, provider)
    validation_seconds = time.perf_counter() - validation_start
    with tempfile.TemporaryDirectory() as folder:
        repository = SQLiteRepository(Path(folder) / "benchmark.sqlite")
        repository.initialize()
        save_start = time.perf_counter()
        repository.save_plan(solved, snapshot.model_dump(mode="json"))
        save_seconds = time.perf_counter() - save_start
        report = dict(
            generation=generated["summary"],
            solve_seconds=solved.result.elapsed_seconds,
            validation_seconds=round(validation_seconds, 3),
            save_seconds=round(save_seconds, 3),
            counts=solved.result.counts,
            validation=solved.result.validation,
            positions_bytes=len(solved.positions),
            targets_bytes=len(solved.targets),
            database_bytes=repository.overview()["size_bytes"],
            total_seconds=round(time.perf_counter() - begun, 3),
            solve_budget_seconds=30,
            solve_budget_passed=solved.result.elapsed_seconds + validation_seconds + save_seconds < 30,
        )
        print(json.dumps(report, indent=2), flush=True)
        if "--save" in sys.argv:
            output = Path(__file__).resolve().parents[1] / "benchmark-result.json"
            output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        if not report["solve_budget_passed"]:
            raise SystemExit("Default workload exceeded the 30-second solve/validate/save budget")


if __name__ == "__main__":
    main()
