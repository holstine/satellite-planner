"""SQLite adapter. Catalog changes never alter an already saved plan."""

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .domain import CollectionRequest, Constraints, DomainError, Spacecraft
from .orbits import demo_fleet


def encode(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


class SQLiteRepository:
    def __init__(self, path=None):
        self.path = Path(
            path
            or Path(os.environ.get("ORBIT_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
            / "orbit.sqlite"
        )

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self):
        with self.connection() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            legacy = conn.execute("SELECT name FROM sqlite_master WHERE name='targets'").fetchone()
            if version > 2:
                raise RuntimeError("Database belongs to a newer Orbit Desk version")
            if legacy and version < 2:
                backup = self.path.parent / "backups" / "before-v2.sqlite"
                backup.parent.mkdir(exist_ok=True)
                if not backup.exists():
                    with sqlite3.connect(backup) as destination:
                        conn.backup(destination)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS requests_name ON requests(name);
                CREATE TABLE IF NOT EXISTS spacecraft(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS work_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                    created TEXT NOT NULL, request TEXT NOT NULL, snapshot TEXT NOT NULL, result TEXT, error TEXT,
                    progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', cancel INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS jobs_created ON work_jobs(created DESC);
                CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, created TEXT NOT NULL, metadata TEXT NOT NULL, snapshot TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS instructions(plan_id TEXT NOT NULL REFERENCES plans(id), id TEXT NOT NULL,
                    request_id INTEGER NOT NULL, spacecraft_id TEXT NOT NULL, start INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(plan_id,id));
                CREATE INDEX IF NOT EXISTS instructions_request ON instructions(plan_id,request_id,start);
                CREATE INDEX IF NOT EXISTS instructions_spacecraft ON instructions(plan_id,spacecraft_id,start);
                CREATE TABLE IF NOT EXISTS decisions(plan_id TEXT NOT NULL REFERENCES plans(id), request_id INTEGER NOT NULL,
                    status TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, request TEXT NOT NULL,
                    PRIMARY KEY(plan_id,request_id));
                CREATE INDEX IF NOT EXISTS decisions_filter ON decisions(plan_id,status,reason);
                CREATE TABLE IF NOT EXISTS artifacts(plan_id TEXT NOT NULL REFERENCES plans(id), name TEXT NOT NULL,
                    data BLOB NOT NULL, PRIMARY KEY(plan_id,name));
            """)
            if version < 2:
                if legacy:
                    records = [dict(row) for row in conn.execute("SELECT * FROM targets ORDER BY id")]
                    conn.executemany(
                        "INSERT INTO requests(id,name,payload) VALUES(?,?,?)",
                        [
                            (
                                r["id"],
                                r["name"],
                                encode(
                                    CollectionRequest.model_validate(
                                        {k: v for k, v in r.items() if k != "id"}
                                    ).model_dump()
                                ),
                            )
                            for r in records
                        ],
                    )
                    conn.execute("ALTER TABLE targets RENAME TO legacy_targets_v1")
                    conn.execute("ALTER TABLE jobs RENAME TO legacy_jobs_v1")
                old_fleet = conn.execute("SELECT value FROM settings WHERE key='fleet'").fetchone()
                fleet = json.loads(old_fleet[0]) if old_fleet else demo_fleet()
                conn.executemany(
                    "INSERT INTO spacecraft VALUES(?,?)",
                    [(s["id"], encode(Spacecraft.model_validate(s).model_dump(mode="json"))) for s in fleet],
                )
                old_rules = conn.execute("SELECT value FROM settings WHERE key='constraints'").fetchone()
                rules = json.loads(old_rules[0]) if old_rules else {}
                rules = Constraints.model_validate(
                    {k: v for k, v in rules.items() if k in Constraints.model_fields}
                ).model_dump()
                conn.execute("INSERT OR REPLACE INTO settings VALUES('constraints',?)", (encode(rules),))
                conn.execute("DELETE FROM settings WHERE key='fleet'")
                conn.execute("PRAGMA user_version=2")

    @staticmethod
    def _request(row):
        return dict(id=row["id"], **json.loads(row["payload"]))

    def list_requests(self, offset=0, limit=50, q=""):
        with self.connection() as conn:
            pattern = "%" + q + "%"
            total = conn.execute("SELECT COUNT(*) FROM requests WHERE name LIKE ?", (pattern,)).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM requests WHERE name LIKE ? ORDER BY id LIMIT ? OFFSET ?",
                (pattern, limit, offset),
            )
            return dict(total=total, items=[self._request(r) for r in rows])

    def all_requests(self):
        with self.connection() as conn:
            return [self._request(r) for r in conn.execute("SELECT * FROM requests ORDER BY id")]

    def get_request(self, request_id):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if row is None:
                raise DomainError("Request not found", 404)
            return self._request(row)

    def put_request(self, record, request_id=None):
        with self.connection() as conn:
            if request_id is None:
                request_id = conn.execute(
                    "INSERT INTO requests(name,payload) VALUES(?,?)", (record["name"], encode(record))
                ).lastrowid
            elif not conn.execute(
                "UPDATE requests SET name=?,payload=? WHERE id=?",
                (record["name"], encode(record), request_id),
            ).rowcount:
                raise DomainError("Request not found", 404)
        return dict(id=request_id, **record)

    def add_requests(self, records, replace=False):
        with self.connection() as conn:
            if replace:
                conn.execute("DELETE FROM requests")
            conn.executemany(
                "INSERT INTO requests(name,payload) VALUES(?,?)",
                [(r["name"], encode({k: v for k, v in r.items() if k != "id"})) for r in records],
            )
        return len(records)

    def delete_request(self, request_id):
        with self.connection() as conn:
            if not conn.execute("DELETE FROM requests WHERE id=?", (request_id,)).rowcount:
                raise DomainError("Request not found", 404)

    def clear_requests(self):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute(
                "SELECT 1 FROM work_jobs WHERE status IN ('queued','running') LIMIT 1"
            ).fetchone():
                raise DomainError("Wait for the active job or cancel it before clearing requests", 409)
            count = conn.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
            conn.execute("DELETE FROM requests")
        return count

    def fleet(self):
        with self.connection() as conn:
            return [json.loads(r[0]) for r in conn.execute("SELECT payload FROM spacecraft ORDER BY id")]

    def replace_fleet(self, records):
        with self.connection() as conn:
            conn.execute("DELETE FROM spacecraft")
            conn.executemany("INSERT INTO spacecraft VALUES(?,?)", [(r["id"], encode(r)) for r in records])

    def put_spacecraft(self, record):
        with self.connection() as conn:
            conn.execute("INSERT OR REPLACE INTO spacecraft VALUES(?,?)", (record["id"], encode(record)))

    def delete_spacecraft(self, spacecraft_id):
        with self.connection() as conn:
            if not conn.execute("DELETE FROM spacecraft WHERE id=?", (spacecraft_id,)).rowcount:
                raise DomainError("Spacecraft not found", 404)

    def get_setting(self, key, default=None):
        with self.connection() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_setting(self, key, value):
        with self.connection() as conn:
            conn.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (key, encode(value)))

    def snapshot(self, scenario):
        with self.connection() as conn:
            conn.execute("BEGIN")
            return dict(
                schema_version=2,
                scenario=scenario,
                spacecraft=[
                    json.loads(r[0]) for r in conn.execute("SELECT payload FROM spacecraft ORDER BY id")
                ],
                requests=[self._request(r) for r in conn.execute("SELECT * FROM requests ORDER BY id")],
            )

    def create_job(self, kind, request, snapshot, exclusive=True):
        job_id = uuid.uuid4().hex
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if (
                exclusive
                and conn.execute(
                    "SELECT 1 FROM work_jobs WHERE status IN ('queued','running') LIMIT 1"
                ).fetchone()
            ):
                raise DomainError("A job is already running. Wait or cancel it first.", 409)
            conn.execute(
                "INSERT INTO work_jobs(id,kind,status,created,request,snapshot) VALUES(?,?,?,?,?,?)",
                (job_id, kind, "queued", datetime.now(UTC).isoformat(), encode(request), encode(snapshot)),
            )
        return dict(id=job_id, status="queued")

    def get_job(self, job_id, include_snapshot=True):
        with self.connection() as conn:
            fields = (
                "*"
                if include_snapshot
                else "id,kind,status,created,request,result,error,progress,message,cancel"
            )
            row = conn.execute("SELECT " + fields + " FROM work_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise DomainError("Job not found", 404)
            data = dict(row)
            for key in ("request", "snapshot", "result"):
                if key in data:
                    data[key] = json.loads(data[key]) if data[key] else None
            return data

    def list_jobs(self, limit=30):
        with self.connection() as conn:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT id,kind,status,created,progress,message,error FROM work_jobs ORDER BY created DESC LIMIT ?",
                    (limit,),
                )
            ]

    def update_job(self, job_id, **changes):
        allowed = {"status", "result", "error", "progress", "message", "cancel"}
        if not changes or not changes.keys() <= allowed:
            raise ValueError("Invalid job update")
        values = [encode(v) if k == "result" else v for k, v in changes.items()]
        with self.connection() as conn:
            conn.execute(
                "UPDATE work_jobs SET " + ",".join(k + "=?" for k in changes) + " WHERE id=?",
                (*values, job_id),
            )

    def cancel_job(self, job_id):
        self.get_job(job_id)
        with self.connection() as conn:
            conn.execute(
                "UPDATE work_jobs SET cancel=1 WHERE id=? AND status IN ('queued','running')", (job_id,)
            )
        return dict(status="cancellation_requested")

    def job_cancelled(self, job_id):
        with self.connection() as conn:
            row = conn.execute("SELECT cancel FROM work_jobs WHERE id=?", (job_id,)).fetchone()
            return row is None or bool(row[0])

    def save_plan(self, solved, snapshot):
        result = solved.result.model_dump(mode="json")
        instructions, decisions = result.pop("instructions"), result.pop("decisions")
        requests = {r["id"]: r for r in snapshot["requests"]}
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO plans VALUES(?,?,?,?)",
                (result["id"], datetime.now(UTC).isoformat(), encode(result), encode(snapshot)),
            )
            conn.executemany(
                "INSERT INTO instructions VALUES(?,?,?,?,?,?)",
                [
                    (result["id"], r["id"], r["request_id"], r["spacecraft_id"], r["start"], encode(r))
                    for r in instructions
                ],
            )
            conn.executemany(
                "INSERT INTO decisions VALUES(?,?,?,?,?,?)",
                [
                    (
                        result["id"],
                        d["request_id"],
                        d["status"],
                        d["reason_code"],
                        encode(d),
                        encode(requests[d["request_id"]]),
                    )
                    for d in decisions
                ],
            )
            conn.executemany(
                "INSERT INTO artifacts VALUES(?,?,?)",
                [
                    (result["id"], "positions.bin", solved.positions),
                    (result["id"], "targets.bin", solved.targets),
                ],
            )

    def list_plans(self, limit=30):
        with self.connection() as conn:
            return [
                dict(created=r["created"], **json.loads(r["metadata"]))
                for r in conn.execute(
                    "SELECT created,metadata FROM plans ORDER BY created DESC LIMIT ?", (limit,)
                )
            ]

    def get_plan(self, plan_id):
        with self.connection() as conn:
            row = conn.execute("SELECT metadata FROM plans WHERE id=?", (plan_id,)).fetchone()
            if row is None:
                raise DomainError("Plan not found", 404)
            return json.loads(row[0])

    def plan_snapshot(self, plan_id):
        with self.connection() as conn:
            row = conn.execute("SELECT snapshot FROM plans WHERE id=?", (plan_id,)).fetchone()
            if row is None:
                raise DomainError("Plan not found", 404)
            return json.loads(row[0])

    def plan_decisions(self, plan_id, status=None, reason=None, offset=0, limit=50):
        self.get_plan(plan_id)
        where, params = "plan_id=?", [plan_id]
        for field, value in [("status", status), ("reason", reason)]:
            if value:
                where += f" AND {field}=?"
                params.append(value)
        with self.connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM decisions WHERE " + where, params).fetchone()[0]
            return dict(
                total=total,
                items=[
                    json.loads(r[0])
                    for r in conn.execute(
                        "SELECT payload FROM decisions WHERE "
                        + where
                        + " ORDER BY request_id LIMIT ? OFFSET ?",
                        (*params, limit, offset),
                    )
                ],
            )

    def decision(self, plan_id, request_id):
        with self.connection() as conn:
            row = conn.execute(
                "SELECT payload,request FROM decisions WHERE plan_id=? AND request_id=?",
                (plan_id, request_id),
            ).fetchone()
            if row is None:
                raise DomainError("Request not found in this plan", 404)
            return dict(decision=json.loads(row[0]), request=json.loads(row[1]))

    def plan_instructions(self, plan_id, request_id=None, spacecraft_id=None, offset=0, limit=100):
        self.get_plan(plan_id)
        where, params = "plan_id=?", [plan_id]
        for field, value in [("request_id", request_id), ("spacecraft_id", spacecraft_id)]:
            if value is not None:
                where += f" AND {field}=?"
                params.append(value)
        with self.connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM instructions WHERE " + where, params).fetchone()[0]
            return dict(
                total=total,
                items=[
                    json.loads(r[0])
                    for r in conn.execute(
                        "SELECT payload FROM instructions WHERE "
                        + where
                        + " ORDER BY start,id LIMIT ? OFFSET ?",
                        (*params, limit, offset),
                    )
                ],
            )

    def artifact(self, plan_id, name):
        with self.connection() as conn:
            row = conn.execute(
                "SELECT data FROM artifacts WHERE plan_id=? AND name=?", (plan_id, name)
            ).fetchone()
            if row is None:
                raise DomainError("Artifact not found", 404)
            return bytes(row[0])

    def overview(self):
        with self.connection() as conn:
            counts = {
                name: conn.execute("SELECT COUNT(*) FROM " + name).fetchone()[0]
                for name in ("requests", "spacecraft", "plans", "instructions", "decisions", "work_jobs")
            }
            legacy = bool(conn.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_jobs_v1'").fetchone())
            return dict(
                adapter="sqlite",
                schema_version=2,
                counts=counts,
                size_bytes=self.path.stat().st_size,
                legacy_archive=legacy,
                legacy_note="Original v1 catalogs and jobs preserved in legacy tables, job files, and data/backups/before-v2.sqlite."
                if legacy
                else None,
            )
