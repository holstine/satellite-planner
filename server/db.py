import json
import os
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DATA = Path(os.environ.get('ORBIT_DATA_DIR', Path(__file__).resolve().parents[1] / 'data'))

@contextmanager
def connection():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA / 'orbit.sqlite', timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()

def initialize():
    with connection() as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS targets (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
          longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
          priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 100),
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
          status TEXT NOT NULL, created TEXT NOT NULL, request TEXT NOT NULL, result TEXT, error TEXT);
        ''')
        conn.execute("UPDATE jobs SET status='failed', error='Server restarted during job' WHERE status IN ('queued','running')")

def insert_targets(rows):
    with connection() as conn:
        conn.executemany('INSERT INTO targets(name,latitude,longitude,priority,enabled) VALUES(?,?,?,?,?)',
            [(r['name'], r['latitude'], r['longitude'], r.get('priority', 1), r.get('enabled', True)) for r in rows])
    return len(rows)

def read_targets(enabled=False):
    with connection() as conn:
        return [dict(r) for r in conn.execute('SELECT * FROM targets' + (' WHERE enabled=1' if enabled else '') + ' ORDER BY id')]

def setting(key, default=None):
    with connection() as conn:
        row = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return json.loads(row['value']) if row else default

def save_setting(key, value):
    with connection() as conn:
        conn.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value)))
