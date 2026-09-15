"""Request import/export and reproducible random workload generation."""

import csv
import io
import json
import time

import numpy as np

from .domain import BulkRequests, CollectionRequest, DomainError


class RequestService:
    def __init__(self, repository):
        self.repository = repository

    def import_text(self, body):
        try:
            rows = (
                list(csv.DictReader(io.StringIO(body.text.lstrip("\ufeff"))))
                if body.format == "csv"
                else json.loads(body.text)
            )
            # Empty CSV cells mean use the contract default, especially nullable windows.
            if isinstance(rows, list):
                rows = [{k: v for k, v in r.items() if v != ""} if isinstance(r, dict) else r for r in rows]
            records = BulkRequests(requests=rows)
        except (ValueError, TypeError) as exc:
            raise DomainError(str(exc)[:5000]) from exc
        return dict(inserted=self.repository.add_requests([r.model_dump() for r in records.requests]))

    def export_csv(self):
        out = io.StringIO(newline="")
        writer = csv.DictWriter(out, fieldnames=list(CollectionRequest.model_fields))
        writer.writeheader()
        for record in self.repository.all_requests():
            writer.writerow({k: v for k, v in record.items() if k != "id"})
        return out.getvalue()


def generate_requests(spec, progress):
    begun = time.perf_counter()
    rng = np.random.default_rng(spec.seed)
    records = []
    while len(records) < spec.count:
        progress(0.95 * len(records) / spec.count, f"Creating requests {len(records):,}/{spec.count:,}")
        n = min(1000, spec.count - len(records))
        lat = np.rad2deg(
            np.arcsin(rng.uniform(np.sin(np.deg2rad(spec.south)), np.sin(np.deg2rad(spec.north)), n))
        )
        width = (spec.east - spec.west) % 360 or 360
        lon = (spec.west + rng.uniform(0, width, n) + 180) % 360 - 180
        batch = []
        for i in range(n):
            options = {}
            if spec.randomize_parameters:
                duration = int(rng.choice([10, 20, 30, 45, 60, 90, 120]))
                start = (
                    int(rng.integers(0, max(1, (spec.duration_seconds - duration) // 2)))
                    if rng.random() < 0.5
                    else 0
                )
                end = (
                    int(
                        rng.integers(
                            start + max(duration, (spec.duration_seconds - start) // 3),
                            spec.duration_seconds + 1,
                        )
                    )
                    if start
                    else None
                )
                options = dict(
                    duration_seconds=duration,
                    energy_wh=float(rng.integers(2, 16)),
                    data_mb=float(rng.integers(10, 151)),
                    satellites_required=int(rng.choice([1, 2, 3], p=[0.85, 0.12, 0.03])),
                    collections_required=int(rng.choice([1, 2], p=[0.9, 0.1])),
                    revisit_seconds=int(rng.choice([30, 60, 120])),
                    window_start_seconds=start,
                    window_end_seconds=end,
                    min_elevation_deg=float(rng.choice([5, 10, 15])),
                    min_off_nadir_deg=float(rng.choice([0, 5, 10])),
                    max_off_nadir_deg=float(rng.choice([35, 45, 55])),
                    daylight_only=bool(rng.random() < 0.8),
                    min_sun_elevation_deg=float(rng.choice([0, 5, 10])),
                    sensor=str(rng.choice(["optical", "radar"], p=[0.85, 0.15])),
                )
            batch.append(
                CollectionRequest(
                    name=f"R{spec.seed}-{len(records) + i + 1:06}",
                    latitude=float(lat[i]),
                    longitude=float(lon[i]),
                    priority=int(rng.integers(1, 101)),
                    **options,
                )
            )
        records.extend(r.model_dump() for r in batch)
    return dict(
        records=records,
        summary=dict(
            generated=len(records),
            requested=spec.count,
            complete=len(records) == spec.count,
            elapsed_seconds=round(time.perf_counter() - begun, 3),
            seed=spec.seed,
            note="All requests created. Feasibility and allocation are evaluated only when scheduling.",
        ),
    )
