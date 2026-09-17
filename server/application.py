"""Application boundary shared by REST and MCP; CPU work runs in a process."""

import asyncio
import time
from concurrent.futures import ProcessPoolExecutor

from .domain import (
    Constraints,
    DomainError,
    Generate,
    PlanSnapshot,
    Scenario,
    Spacecraft,
    WeatherRefresh,
    WhatIfSpec,
)
from .fleet import FleetService, parse_tle
from .orbits import demo_fleet
from .plans import PlanService, validate_plan
from .providers import load_providers, repository_factory
from .requests import RequestService, generate_requests
from .weather import WeatherService
from .whatif import compare_plans, prepare, read_plan, solve_variant


def execute_work(factory, options, job_id):
    repository = repository_factory(factory, options)
    job = repository.get_job(job_id)

    def progress(fraction, message):
        if repository.job_cancelled(job_id):
            raise InterruptedError("Job cancelled")
        repository.update_job(job_id, progress=fraction, message=message)

    try:
        progress(0, "Starting worker")
        repository.update_job(job_id, status="running")
        if job["kind"] == "weather":
            spec = WeatherRefresh.model_validate(job["request"])
            result = WeatherService(repository).refresh(
                PlanSnapshot.model_validate(job["snapshot"]), spec, progress
            )
        elif job["kind"] == "whatif":
            spec = WhatIfSpec.model_validate(job["request"]["spec"])
            base, snapshot, instructions, added_ids = prepare(
                repository, job["request"]["source_plan_id"], spec
            )
            if spec.refresh_weather_snapshot:
                snapshot.weather = WeatherService(repository).capture(snapshot)
            begun = time.perf_counter()
            solved = solve_variant(job_id, base, snapshot, instructions, spec, load_providers(), progress)
            solved.result.elapsed_seconds = round(time.perf_counter() - begun, 3)
            progress(0.98, "Saving validated variant" if spec.save else "What-if validation complete")
            if spec.save:
                repository.save_plan(solved, snapshot.model_dump(mode="json"))
            result = dict(
                plan_id=job_id if spec.save else None,
                validation=solved.result.validation,
                comparison=solved.result.changes,
                added_request_ids=added_ids,
                counts=solved.result.counts,
                elapsed_seconds=solved.result.elapsed_seconds,
            )
        elif job["kind"] == "schedule":
            snapshot = PlanSnapshot.model_validate(job["snapshot"])
            providers = load_providers()
            ephemeris = providers.ephemeris(snapshot.scenario.ephemeris_provider)
            begun = time.perf_counter()
            solved = providers.scheduler(snapshot.scenario.scheduler).solve(
                job_id, snapshot, ephemeris, progress
            )
            progress(0.95, "Checking plan contract")
            solved.result.validation = validate_plan(solved.result, snapshot, ephemeris)
            solved.result.elapsed_seconds = round(time.perf_counter() - begun, 3)
            progress(0.98, "Saving immutable plan")
            repository.save_plan(solved, job["snapshot"])
            result = dict(
                plan_id=job_id, counts=solved.result.counts, elapsed_seconds=solved.result.elapsed_seconds
            )
        else:
            spec = Generate.model_validate(job["request"])
            generated = generate_requests(spec, progress)
            progress(0.98, "Saving generated requests")
            repository.add_requests(generated["records"], replace=spec.replace_existing)
            result = generated["summary"]
        repository.update_job(job_id, status="completed", result=result, progress=1, message="Complete")
    except Exception as exc:
        repository.update_job(
            job_id,
            status="cancelled" if isinstance(exc, InterruptedError) else "failed",
            error=str(exc),
            message=str(exc),
        )


class Application:
    def __init__(self, factory=None, options=None):
        self.factory, self.options = factory, options or {}
        self.repository = repository_factory(factory, self.options)
        self.providers = load_providers()
        self.requests = RequestService(self.repository)
        self.plans = PlanService(self.repository)
        self.fleet = FleetService(self.repository, self.providers.ephemeris("hybrid"))
        self.weather = WeatherService(self.repository)
        self.pool = None
        self.tasks = set()

    async def start(self):
        self.repository.initialize()
        for job in self.repository.list_jobs(100000):
            if job["status"] in ("queued", "running"):
                self.repository.update_job(job["id"], status="failed", error="Server restarted during job")
        self.pool = ProcessPoolExecutor(max_workers=1)

    async def close(self):
        for job in self.repository.list_jobs(100000):
            if job["status"] in ("queued", "running"):
                self.repository.cancel_job(job["id"])
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.pool:
            self.pool.shutdown(wait=True, cancel_futures=True)

    async def submit(self, kind, body):
        if self.pool is None:
            raise DomainError("Job worker is not running", 503)
        scenario = Scenario.model_validate(body.model_dump(include=set(Scenario.model_fields)))
        if kind == "generate":
            snapshot = dict(scenario=scenario.model_dump(mode="json"), requests=[], spacecraft=[])
        else:
            self.providers.scheduler(scenario.scheduler)
            self.providers.ephemeris(scenario.ephemeris_provider)
            snapshot = self.repository.snapshot(scenario.model_dump(mode="json"))
            if not any(s["enabled"] for s in snapshot["spacecraft"]):
                raise DomainError("Add at least one enabled spacecraft")
            if not any(r["enabled"] for r in snapshot["requests"]):
                raise DomainError("Add at least one enabled request")
            parsed = PlanSnapshot.model_validate(snapshot)
            parsed.weather = self.weather.capture(parsed)
            snapshot = parsed.model_dump(mode="json")
        return self.enqueue(kind, body.model_dump(mode="json"), snapshot)

    async def submit_whatif(self, plan_id, spec):
        snapshot = self.repository.plan_snapshot(plan_id)
        return self.enqueue(
            "whatif", dict(source_plan_id=plan_id, spec=spec.model_dump(mode="json")), snapshot
        )

    def weather_input(self, spec):
        if spec.plan_id:
            return PlanSnapshot.model_validate(self.repository.plan_snapshot(spec.plan_id))
        return PlanSnapshot.model_validate(self.repository.snapshot(spec.scenario.model_dump(mode="json")))

    async def refresh_weather(self, spec):
        return self.enqueue(
            "weather", spec.model_dump(mode="json"), self.weather_input(spec).model_dump(mode="json")
        )

    def compare(self, first, second):
        return compare_plans(read_plan(self.repository, first), read_plan(self.repository, second))

    def enqueue(self, kind, body, snapshot):
        if self.pool is None:
            raise DomainError("Job worker is not running", 503)
        job = self.repository.create_job(kind, body, snapshot)

        async def run():
            try:
                await asyncio.get_running_loop().run_in_executor(
                    self.pool, execute_work, self.factory, self.options, job["id"]
                )
            except Exception as exc:
                self.repository.update_job(job["id"], status="failed", error=str(exc))

        task = asyncio.create_task(run())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return job

    def constraints(self):
        return Constraints.model_validate(self.repository.get_setting("constraints", {})).model_dump()

    def save_constraints(self, body):
        self.repository.set_setting("constraints", body.model_dump())
        return body.model_dump()

    def demo_fleet(self, body):
        records = [
            Spacecraft.model_validate(r).model_dump(mode="json") for r in demo_fleet(**body.model_dump())
        ]
        self.repository.replace_fleet(records)
        return records

    def import_tle(self, body):
        records = parse_tle(body.text)
        self.repository.replace_fleet(records)
        return records

    def job(self, job_id):
        result = self.repository.get_job(job_id, include_snapshot=False)
        result.pop("snapshot", None)
        return result
