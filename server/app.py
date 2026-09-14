import asyncio
import csv
import io
import json
import uuid
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import ValidationError
from sgp4.api import Satrec
from . import db
from .models import Target, Bulk, ImportText, Constraints, Scenario, Generate, DemoFleet, TLEImport
from .orbits import demo_fleet, target_vectors
from .engine import run_schedule, run_generate

tasks = set()

@asynccontextmanager
async def lifespan(app):
    db.initialize()
    app.state.pool = ProcessPoolExecutor(max_workers=1)
    app.state.job_lock = asyncio.Lock()
    if db.setting('fleet') is None:
        db.save_setting('fleet', demo_fleet())
    yield
    with db.connection() as conn:
        active = conn.execute("SELECT id FROM jobs WHERE status IN ('queued','running')").fetchall()
    for row in active:
        (db.DATA/'jobs'/row['id']/'cancel').touch()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    app.state.pool.shutdown(wait=True, cancel_futures=True)

app = FastAPI(title='Orbit Desk API', version='0.1.0', lifespan=lifespan)

@app.middleware('http')
async def local_origin(request: Request, call_next):
    # Bind loopback and reject cross-origin browser mutations. No permissive CORS.
    origin = request.headers.get('origin')
    if origin and origin not in ('http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8000'):
        return Response('Origin not allowed', status_code=403)
    if int(request.headers.get('content-length', 0)) > 25_000_000:
        return Response('Import exceeds 25 MB', status_code=413)
    return await call_next(request)

@app.get('/api/health')
def health():
    return dict(status='ok', storage='SQLite', worker_processes=1)

@app.get('/api/targets')
def targets(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=1000), q: str = ''):
    with db.connection() as conn:
        total = conn.execute('SELECT COUNT(*) FROM targets WHERE name LIKE ?', ('%'+q+'%',)).fetchone()[0]
        rows = conn.execute('SELECT * FROM targets WHERE name LIKE ? ORDER BY id LIMIT ? OFFSET ?', ('%'+q+'%', limit, offset))
        return dict(total=total, items=[dict(r) for r in rows])

@app.get('/api/targets/points')
def target_points():
    rows = db.read_targets()
    xyz, _ = target_vectors(rows)
    packed = np.column_stack(([r['id'] for r in rows], xyz, [r['enabled'] for r in rows]))
    return Response(packed.astype('<f8').tobytes(), media_type='application/octet-stream', headers={'X-Record-Stride':'5'})

@app.get('/api/targets/export')
def export_targets():
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=['name','latitude','longitude','priority','enabled'])
    writer.writeheader()
    for row in db.read_targets():
        row.pop('id')
        writer.writerow(row)
    return Response(out.getvalue(), media_type='text/csv', headers={'Content-Disposition':'attachment; filename="targets.csv"'})

@app.post('/api/targets', status_code=201)
def create_target(target: Target):
    with db.connection() as conn:
        cur = conn.execute('INSERT INTO targets(name,latitude,longitude,priority,enabled) VALUES(?,?,?,?,?)', tuple(target.model_dump().values()))
        return dict(id=cur.lastrowid, **target.model_dump())

@app.post('/api/targets/bulk', status_code=201)
def bulk_targets(body: Bulk):
    return dict(inserted=db.insert_targets([t.model_dump() for t in body.targets]))

@app.post('/api/targets/import', status_code=201)
def import_targets(body: ImportText):
    try:
        rows = list(csv.DictReader(io.StringIO(body.text.lstrip('\ufeff')))) if body.format == 'csv' else json.loads(body.text)
        targets = Bulk(targets=rows)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, str(exc)[:5000])
    return dict(inserted=db.insert_targets([t.model_dump() for t in targets.targets]))

@app.get('/api/targets/{target_id}')
def get_target(target_id: int):
    with db.connection() as conn:
        row = conn.execute('SELECT * FROM targets WHERE id=?', (target_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Target not found')
        return dict(row)

@app.put('/api/targets/{target_id}')
def update_target(target_id: int, target: Target):
    with db.connection() as conn:
        cur = conn.execute('UPDATE targets SET name=?,latitude=?,longitude=?,priority=?,enabled=? WHERE id=?', (*target.model_dump().values(), target_id))
        if not cur.rowcount:
            raise HTTPException(404, 'Target not found')
    return dict(id=target_id, **target.model_dump())

@app.delete('/api/targets/{target_id}')
def delete_target(target_id: int):
    with db.connection() as conn:
        cur = conn.execute('DELETE FROM targets WHERE id=?', (target_id,))
        if not cur.rowcount:
            raise HTTPException(404, 'Target not found')
    return dict(deleted=target_id)

@app.get('/api/constraints')
def constraints():
    return db.setting('constraints', Constraints().model_dump())

@app.put('/api/constraints')
def save_constraints(body: Constraints):
    db.save_setting('constraints', body.model_dump())
    return body

@app.get('/api/satellites')
def satellites():
    return db.setting('fleet', [])

@app.put('/api/satellites/demo')
def replace_demo(body: DemoFleet):
    fleet = demo_fleet(**body.model_dump())
    db.save_setting('fleet', fleet)
    return fleet

@app.put('/api/satellites/tle')
def import_tle(body: TLEImport):
    lines = [s.strip() for s in body.text.splitlines() if s.strip()]
    fleet, i = [], 0
    try:
        while i < len(lines):
            name = lines[i] if not lines[i].startswith('1 ') else f'SAT {len(fleet)+1}'
            if not lines[i].startswith('1 '):
                i += 1
            a, b = lines[i:i+2]
            if not a.startswith('1 ') or not b.startswith('2 ') or len(a) != 69 or len(b) != 69:
                raise ValueError('TLEs require complete 69-character line 1 and line 2 pairs')
            for line in (a, b):
                checksum = sum(int(ch) if ch.isdigit() else 1 if ch == '-' else 0 for ch in line[:68]) % 10
                if not line[68].isdigit() or checksum != int(line[68]):
                    raise ValueError(f'TLE checksum failed for {name}')
            if a[2:7] != b[2:7]:
                raise ValueError('TLE catalog IDs do not match')
            rec = Satrec.twoline2rv(a, b)
            error, _, _ = rec.sgp4(rec.jdsatepoch, rec.jdsatepochF)
            if error:
                raise ValueError(f'Invalid orbit for {name}: SGP4 code {error}')
            fleet.append(dict(id=f'tle-{rec.satnum}', name=name.removeprefix('0 '), kind='tle', line1=a, line2=b,
                epoch=(rec.jdsatepoch+rec.jdsatepochF-2440587.5)*86400))
            i += 2
        if not fleet or len(fleet) > 1000 or len({s['id'] for s in fleet}) != len(fleet):
            raise ValueError('Import 1–1,000 unique satellites')
    except (ValueError, IndexError) as exc:
        raise HTTPException(422, str(exc))
    db.save_setting('fleet', fleet)
    return fleet

def job_row(job_id):
    with db.connection() as conn:
        row = conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'Job not found')
    return dict(row)

async def execute_job(job_id, kind, request, fleet, rows, folder):
    with db.connection() as conn:
        conn.execute("UPDATE jobs SET status='running' WHERE id=?", (job_id,))
    try:
        args = (request, fleet, rows, str(folder)) if kind == 'schedule' else (request, fleet, str(folder))
        result = await asyncio.get_running_loop().run_in_executor(app.state.pool, run_schedule if kind == 'schedule' else run_generate, *args)
        with db.connection() as conn:
            conn.execute("UPDATE jobs SET status='completed', result=? WHERE id=?", (json.dumps(result), job_id))
    except Exception as exc:
        with db.connection() as conn:
            conn.execute('UPDATE jobs SET status=?, error=? WHERE id=?', ('cancelled' if isinstance(exc, InterruptedError) else 'failed', str(exc), job_id))

async def submit(kind, body):
    async with app.state.job_lock:
        with db.connection() as conn:
            active = conn.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        if active:
            raise HTTPException(409, 'A job is already running. Wait or cancel it first.')
        fleet = db.setting('fleet', [])
        rows = db.read_targets(enabled=True) if kind == 'schedule' else []
        if not fleet or (kind == 'schedule' and not rows):
            raise HTTPException(422, 'Add satellites and at least one enabled target first')
        job_id = uuid.uuid4().hex
        folder = db.DATA/'jobs'/job_id
        folder.mkdir(parents=True)
        request = body.model_dump(mode='json')
        # Persist a complete input snapshot, including names, for reproducibility.
        (folder/'input.json').write_text(json.dumps(dict(request=request, satellites=fleet, targets=rows)))
        with db.connection() as conn:
            conn.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)', (job_id, kind, 'queued', datetime.now(timezone.utc).isoformat(), json.dumps(request), None, None))
        task = asyncio.create_task(execute_job(job_id, kind, request, fleet, rows, folder))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return dict(id=job_id, status='queued')

@app.post('/api/jobs/schedule', status_code=202)
async def schedule_job(body: Scenario):
    return await submit('schedule', body)

@app.post('/api/jobs/generate', status_code=202)
async def generate_job(body: Generate):
    return await submit('generate', body)

@app.get('/api/jobs')
def jobs():
    with db.connection() as conn:
        return [dict(r) for r in conn.execute('SELECT id,kind,status,created,error FROM jobs ORDER BY created DESC LIMIT 30')]

@app.get('/api/jobs/{job_id}')
def get_job(job_id: str):
    row = job_row(job_id)
    row['request'] = json.loads(row['request'])
    row['result'] = json.loads(row['result']) if row['result'] else None
    path = db.DATA/'jobs'/job_id/'progress.json'
    try:
        row.update(json.loads(path.read_text()))
    except (OSError, ValueError):
        pass
    return row

@app.post('/api/jobs/{job_id}/cancel')
def cancel_job(job_id: str):
    row = job_row(job_id)
    if row['status'] in ('queued', 'running'):
        (db.DATA/'jobs'/job_id/'cancel').touch()
    return dict(status='cancellation_requested')

@app.get('/api/jobs/{job_id}/files/{filename}')
def job_file(job_id: str, filename: str):
    row = job_row(job_id)
    if row['status'] != 'completed' or filename not in ('positions.bin','targets.bin','result.json','input.json'):
        raise HTTPException(404, 'Artifact unavailable')
    path = db.DATA/'jobs'/job_id/filename
    if not path.is_file():
        raise HTTPException(404, 'Artifact not found')
    return FileResponse(path, media_type='application/json' if filename.endswith('.json') else 'application/octet-stream')
