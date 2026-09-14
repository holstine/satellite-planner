"""Spatially indexed sampled access and deterministic priority-first scheduling."""
import json
import time
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from .models import Scenario, Generate
from .orbits import B, positions, target_vectors, sun_direction
from . import db

def report(folder, fraction, message):
    if (folder / 'cancel').exists():
        raise InterruptedError('Cancelled')
    tmp = folder / 'progress.tmp'
    tmp.write_text(json.dumps(dict(progress=fraction, message=message)))
    tmp.replace(folder / 'progress.json')

def visible(xyz, normals, sat, sun, c):
    delta = sat - xyz
    unit = delta / np.linalg.norm(delta, axis=1)[:, None]
    elevation = np.sum(unit*normals, axis=1)
    off_nadir = np.sum(unit*(sat/np.linalg.norm(sat)), axis=1)
    ok = (elevation >= np.sin(np.deg2rad(c.min_elevation_deg))) & (off_nadir >= np.cos(np.deg2rad(c.max_off_nadir_deg)))
    if c.daylight_only:
        ok &= normals @ sun >= np.sin(np.deg2rad(c.min_sun_elevation_deg))
    return ok

def candidates(tree, sat, c):
    r = np.linalg.norm(sat)
    if r <= B:
        return []
    # Conservative spherical broad phase; exact WGS84 normal/LOS checks follow.
    theta = min(np.deg2rad(c.max_off_nadir_deg), np.arcsin(B/r))
    gamma = np.arcsin(np.clip(r/B*np.sin(theta), -1, 1)) - theta
    gamma = min(np.arccos(B/r)+.01, gamma+.01)
    return tree.query_ball_point(sat/r, 2*np.sin(gamma/2))

def access(rows, fleet, scenario, folder, schedule=True):
    c = scenario.constraints
    start = scenario.start.timestamp()
    xyz, normals = target_vectors(rows)
    unit = xyz / np.linalg.norm(xyz, axis=1)[:, None]
    tree = cKDTree(unit)
    starts = np.arange(0, scenario.duration_seconds-c.dwell_seconds+1, c.step_seconds)
    checks = np.unique(np.append(np.arange(0, c.dwell_seconds, c.validation_seconds), c.dwell_seconds))
    timestamps = np.unique((starts[:, None]+checks).ravel())
    if len(timestamps)*len(fleet) > 5_000_000:
        raise ValueError('Exceeds 5 million propagation samples; shorten timeframe or increase validation step')
    tracks = positions(fleet, start+timestamps)
    suns = sun_direction(start+timestamps)
    feasible, observed = np.zeros(len(rows), dtype=bool), np.zeros(len(rows), dtype=bool)
    free = np.zeros((len(fleet), c.capacity_per_satellite))
    target_free = np.zeros(len(rows))
    priorities = np.array([r['priority'] for r in rows])
    ids = np.array([r.get('id', i) for i, r in enumerate(rows)])
    events, candidate_count = [], 0
    for ti, offset in enumerate(starts):
        if ti % 4 == 0:
            report(folder, ti/max(1, len(starts)), f'Checking access {ti+1:,}/{len(starts):,}')
        times_idx = np.searchsorted(timestamps, offset+checks)
        for si in range(len(fleet)):
            pool = np.asarray(candidates(tree, tracks[times_idx[0], si], c), dtype=int)
            if not len(pool):
                continue
            if not schedule:
                pool = pool[~feasible[pool]]
            candidate_count += len(pool)
            for ki in times_idx:
                pool = pool[visible(xyz[pool], normals[pool], tracks[ki, si], suns[ki], c)]
                if not len(pool):
                    break
            feasible[pool] = True
            if not schedule or not len(pool):
                continue
            if c.observe_target_once:
                pool = pool[~observed[pool]]
            pool = pool[target_free[pool] <= offset]
            available = np.flatnonzero(free[si] <= offset)
            if not len(available) or not len(pool):
                continue
            order = np.lexsort((ids[pool], -priorities[pool]))
            for lane, target in zip(available, pool[order]):
                free[si, lane] = offset+c.dwell_seconds+c.cooldown_seconds
                target_free[target] = offset+c.dwell_seconds
                observed[target] = True
                events.append(dict(satellite_index=si, target_id=int(ids[target]), start=int(offset),
                    end=int(offset+c.dwell_seconds), priority=int(priorities[target])))
    report(folder, 1, 'Access checks complete')
    return feasible, observed, events, candidate_count

def run_schedule(request, fleet, rows, folder_str):
    folder = Path(folder_str)
    scenario = Scenario.model_validate(request)
    begun = time.perf_counter()
    feasible, observed, events, comparisons = access(rows, fleet, scenario, folder)
    sample_step = 10
    seconds = np.arange(0, scenario.duration_seconds+sample_step, sample_step)
    positions(fleet, scenario.start.timestamp()+seconds).astype('<f8').tofile(folder/'positions.bin')
    tx, _ = target_vectors(rows)
    np.column_stack(([r['id'] for r in rows], tx, feasible, observed)).astype('<f8').tofile(folder/'targets.bin')
    result = dict(id=folder.name, scenario=request, satellites=fleet, events=events,
        sample_step=sample_step, sample_count=len(seconds), target_stride=6,
        counts=dict(targets=len(rows), feasible=int(feasible.sum()), scheduled=int(observed.sum()),
            inaccessible=int((~feasible).sum()), unassigned=int((feasible & ~observed).sum()),
            observations=len(events), candidates=comparisons),
        elapsed_seconds=round(time.perf_counter()-begun, 3),
        accuracy='Sampled geometric feasibility; greedy scheduling; not an operational flight plan.')
    (folder/'result.json').write_text(json.dumps(result))
    return result

def run_generate(request, fleet, folder_str):
    folder = Path(folder_str)
    spec = Generate.model_validate(request)
    begun = time.perf_counter()
    rng = np.random.default_rng(spec.seed)
    accepted, attempted, feasible_count = [], 0, 0
    max_attempts = spec.count*10
    while len(accepted) < spec.count and attempted < max_attempts:
        n = min(max(1000, (spec.count-len(accepted))*2), 20000, max_attempts-attempted)
        lat = np.rad2deg(np.arcsin(rng.uniform(np.sin(np.deg2rad(spec.south)), np.sin(np.deg2rad(spec.north)), n)))
        width = (spec.east-spec.west) % 360 or 360
        lon = (spec.west+rng.uniform(0, width, n)+180) % 360-180
        batch = [dict(id=i, name=f'R{spec.seed}-{attempted+i+1:06}', latitude=float(lat[i]),
            longitude=float(lon[i]), priority=1, enabled=True) for i in range(n)]
        if spec.feasible_only:
            scenario = Scenario.model_validate({k: request[k] for k in ('start','duration_seconds','constraints')})
            good, _, _, _ = access(batch, fleet, scenario, folder, False)
            batch = [r for r, ok in zip(batch, good) if ok]
        feasible_count += len(batch)
        accepted.extend(batch[:spec.count-len(accepted)])
        attempted += n
        report(folder, len(accepted)/spec.count, f'{len(accepted):,} accepted from {attempted:,} candidates')
    report(folder, 1, 'Saving accepted targets')
    db.insert_targets(accepted)
    return dict(accepted=len(accepted), attempted=attempted, rejected=attempted-feasible_count,
        surplus=feasible_count-len(accepted), requested=spec.count, complete=len(accepted)==spec.count,
        elapsed_seconds=round(time.perf_counter()-begun, 3),
        note='Feasible means sampled access exists, not guaranteed schedule capacity.' if spec.feasible_only else 'Unfiltered random targets')
