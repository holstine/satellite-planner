'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Orbit,
  Play,
  Pause,
  RotateCcw,
  Layers,
  Database as DatabaseIcon,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import OrbitGlobe, { type GlobeHandle, type GlobeOptions } from './orbit-globe';
import SchedulePanel from './workspace/schedule-panel';
import RequestPanel from './workspace/request-panel';
import FleetPanel from './workspace/fleet-panel';
import PlanPanel from './workspace/plan-panel';
import { Choice, Toggle } from './workspace/controls';
import {
  api,
  binary,
  defaults,
  elapsed,
  number,
  type Constraints,
  type Database,
  type Job,
  type Playback,
  type Run,
  type Satellite,
  type Scenario,
} from '@/lib/orbit-api';

export default function Planner() {
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [connected, setConnected] = useState(false);
  const [scenario, setScenario] = useState<Scenario>({
    name: 'Observation plan',
    start: '2026-09-11T12:00:00Z',
    duration_seconds: 3600,
    constraints: defaults,
    scheduler: 'priority-greedy',
    ephemeris_provider: 'hybrid',
  });
  const [fleet, setFleet] = useState<Satellite[]>([]),
    [plans, setPlans] = useState<Run[]>([]),
    [points, setPoints] = useState<Float64Array | null>(null),
    [playback, setPlayback] = useState<Playback | null>(null);
  const [job, setJob] = useState<Job | null>(null),
    [revision, setRevision] = useState(0),
    [database, setDatabase] = useState<Database | null>(null);
  const [schedulers, setSchedulers] = useState([
    'priority-greedy',
    'earliest-deadline',
  ]);
  const [tab, setTab] = useState('schedule'),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(60),
    [selected, setSelected] = useState(0);
  const [seconds, setSeconds] = useState(0),
    [fps, setFps] = useState(0),
    [active, setActive] = useState(0),
    [layers, setLayers] = useState(false);
  const [options, setOptions] = useState<GlobeOptions>({
    targets: true,
    lines: true,
    cone: true,
    horizon: true,
    feasibleOnly: false,
  });
  const handle = useRef<GlobeHandle | null>(null);
  const working = !!job && ['queued', 'running'].includes(job.status);
  const act = useCallback(async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const refresh = useCallback(async () => {
    const [s, p, d, b] = await Promise.all([
      api<Satellite[]>('/fleet'),
      api<Run[]>('/plans'),
      api<Database>('/database'),
      binary('/requests/points'),
    ]);
    setFleet(s);
    setPlans(p);
    setDatabase(d);
    setPoints(b);
    setRevision((v) => v + 1);
    setConnected(true);
  }, []);
  const load = useCallback(async (id: string) => {
    const [run, positions, targets, summary] = await Promise.all([
      api<Run>(`/plans/${id}/playback`),
      binary(`/plans/${id}/files/positions.bin`),
      binary(`/plans/${id}/files/targets.bin`),
      api<Run>(`/plans/${id}`),
    ]);
    setPlayback({
      run: { ...run, reasons: summary.reasons },
      positions,
      targets,
    });
    setPlaying(false);
    setSeconds(0);
    setSelected(0);
  }, []);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        void act(async () => {
          await refresh();
          const [constraints, history, saved, providers] = await Promise.all([
            api<Constraints>('/constraints'),
            api<Job[]>('/jobs'),
            api<Run[]>('/plans'),
            api<{ schedulers: string[] }>('/providers'),
          ]);
          setScenario((s) => ({ ...s, constraints }));
          setSchedulers(providers.schedulers);
          const pending = history.find((j) =>
            ['queued', 'running'].includes(j.status),
          );
          if (pending) setJob(pending);
          if (saved[0]) await load(saved[0].id);
        }),
      0,
    );
    return () => clearTimeout(timer);
  }, [act, refresh, load]);
  const jobId = job?.id,
    jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !['queued', 'running'].includes(jobStatus))
      return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>(`/jobs/${jobId}`);
        if (stopped) return;
        setJob(next);
        if (next.status === 'completed') {
          await refresh();
          if (next.kind === 'schedule') {
            await load(next.id);
            setTab('plan');
            setNotice(
              'Plan saved. Inspect decisions or play through its collections.',
            );
          } else {
            setPlayback(null);
            setPlaying(false);
            setNotice(
              `Created ${number(next.result?.generated ?? next.result?.accepted)} requests. ${next.result?.note ?? ''}`,
            );
          }
        } else if (next.status === 'failed')
          setError(next.error ?? 'Job failed');
        else if (next.status === 'cancelled') setNotice('Job cancelled.');
        else timer = setTimeout(poll, 700);
      } catch (e) {
        if (!stopped) {
          setError(String(e));
          timer = setTimeout(poll, 2000);
        }
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, jobStatus, refresh, load]);
  const seek = (value: number) => {
    handle.current?.seek(value);
    setSeconds(value);
  };
  const displayedFleet = playback?.run.satellites ?? fleet;
  const plan = playback?.run ?? null;
  return (
    <main className="planner">
      <header className="masthead">
        <div className="brand">
          <Orbit size={25} /> ORBIT<span className="brand-light">DESK</span>
        </div>
        <span className="edition">MISSION PLANNING WORKSPACE</span>
        <div className="server-state">
          <i className={connected ? 'live' : ''} />
          {connected ? 'Local server connected' : 'Connecting…'}
        </div>
        <a
          className="api-link"
          href="http://127.0.0.1:8000/docs"
          target="_blank"
          rel="noreferrer"
        >
          API ↗
        </a>
      </header>
      <div className="workbench">
        <aside className="control-panel">
          <div className="panel-heading">
            <span className="eyebrow">OBSERVATION OPERATIONS</span>
            <h1>Plan. Inspect. Iterate.</h1>
          </div>
          <Tabs
            className="workspace-tabs"
            value={tab}
            onValueChange={(value) => setTab(String(value))}
          >
            <TabsList className="main-tabs" aria-label="Workspace modules">
              {['schedule', 'requests', 'fleet', 'plan'].map((t) => (
                <TabsTrigger key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent className="panel-scroll" value="schedule">
              <SchedulePanel
                scenario={scenario}
                onChange={setScenario}
                disabled={working || !connected}
                schedulers={schedulers}
                submit={() =>
                  void act(async () => {
                    await api('/constraints', scenario.constraints, 'PUT');
                    setJob(await api<Job>('/jobs/schedule', scenario, 'POST'));
                    setNotice('');
                  })
                }
              />
            </TabsContent>
            <TabsContent className="panel-scroll" value="requests">
              <RequestPanel
                revision={revision}
                act={act}
                changed={async () => {
                  setPlayback(null);
                  setPlaying(false);
                  await refresh();
                }}
                scenario={scenario}
                setJob={setJob}
                working={working}
              />
            </TabsContent>
            <TabsContent className="panel-scroll" value="fleet">
              <FleetPanel fleet={fleet} act={act} changed={refresh} />
            </TabsContent>
            <TabsContent className="panel-scroll" value="plan">
              <PlanPanel
                key={plan?.id ?? 'none'}
                plans={plans}
                plan={plan}
                load={load}
                act={act}
                seek={seek}
              />
            </TabsContent>
          </Tabs>
          <details className="database-footer">
            <summary>
              <DatabaseIcon size={14} /> SQLite · MCP connected to all modules
            </summary>
            <p className="hint">
              MCP endpoint: <code>http://127.0.0.1:8000/mcp/</code>
              <br />
              Schema {database?.schema_version} ·{' '}
              {number(database?.counts.requests)} requests ·{' '}
              {number(database?.counts.plans)} plans ·{' '}
              {((database?.size_bytes ?? 0) / 1048576).toFixed(1)} MB
            </p>
            {database?.legacy_note && (
              <p className="hint">{database.legacy_note}</p>
            )}
          </details>
        </aside>
        <div className="visual-panel">
          <div className="map-area">
            <OrbitGlobe
              points={points}
              playback={playback}
              playing={playing}
              speed={speed}
              selected={selected}
              options={options}
              handle={handle}
              onSelect={setSelected}
              onTime={(time, frameRate, collections) => {
                setSeconds(time);
                setFps(frameRate);
                setActive(collections);
                if (playback && time >= playback.run.scenario.duration_seconds)
                  setPlaying(false);
              }}
            />
            <div className="map-title">
              <span className="eyebrow">
                {plan ? 'PLAN PLAYBACK' : 'REQUEST CATALOG'}
              </span>
              <h2>
                {plan?.scenario.name ?? 'The next collection starts here.'}
              </h2>
              <span className="map-subtitle">
                {plan
                  ? `${number(plan.counts.targets)} requests · ${number(plan.satellites.length)} spacecraft`
                  : `${number(database?.counts.requests)} targets on the globe · ${fleet.length} spacecraft ready`}
              </span>
            </div>
            <div className="map-tools">
              <button
                className="icon-button"
                aria-label="Reset globe view"
                onClick={() => handle.current?.home()}
              >
                <RotateCcw size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="Toggle map layers"
                aria-expanded={layers}
                onClick={() => setLayers(!layers)}
              >
                <Layers size={18} />
              </button>
            </div>
            {layers && (
              <div className="layers">
                <span className="eyebrow">MAP LAYERS</span>
                {(
                  [
                    ['targets', 'Target points'],
                    ['lines', 'Active collection lines'],
                    ['cone', 'Solid field of regard'],
                    ['horizon', 'Geometric horizon'],
                    ['feasibleOnly', 'Hide inaccessible targets'],
                  ] as const
                ).map(([key, label]) => (
                  <Toggle
                    key={key}
                    label={label}
                    checked={options[key]}
                    onChange={(value) =>
                      setOptions({ ...options, [key]: value })
                    }
                  />
                ))}
              </div>
            )}
            {plan && (
              <div className="satellite-selector">
                <span>SELECTED SPACECRAFT · FIELD OF REGARD</span>
                <Choice
                  label="Selected spacecraft"
                  value={String(selected)}
                  onChange={(v) => setSelected(Number(v))}
                  items={displayedFleet.map((s, i) => ({
                    value: String(i),
                    label: s.name,
                  }))}
                />
              </div>
            )}
            {!database?.counts.requests && (
              <div className="empty-map">
                <Orbit size={30} />
                <h3>Your fleet is ready.</h3>
                <p>
                  Open Requests to generate 10,000 targets with mixed collection
                  parameters, then build a plan.
                </p>
              </div>
            )}
            <div className="map-legend">
              <span>
                <i className="dot green" />
                Has collections
              </span>
              <span>
                <i className="dot amber" />
                Unassigned
              </span>
              <span>
                <i className="dot grey" />
                No sampled access
              </span>
              <span className="fps">{playing ? `${fps} FPS` : 'PAUSED'}</span>
            </div>
          </div>
          <div className="playback">
            <div className="transport">
              <button
                className="play-button"
                disabled={!plan}
                aria-label={playing ? 'Pause playback' : 'Play plan'}
                onClick={() => {
                  if (plan && seconds >= plan.scenario.duration_seconds)
                    seek(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                className="icon-button"
                disabled={!plan}
                aria-label="Rewind plan"
                onClick={() => seek(0)}
              >
                <RotateCcw size={16} />
              </button>
              <Choice
                label="Playback speed"
                value={String(speed)}
                onChange={(v) => setSpeed(Number(v))}
                items={[1, 10, 30, 60, 120].map((v) => ({
                  value: String(v),
                  label: `${v}×`,
                }))}
              />
              <div className="time-display">
                <strong>{elapsed(seconds)}</strong>
                <span>
                  {plan
                    ? new Date(Date.parse(plan.scenario.start) + seconds * 1000)
                        .toISOString()
                        .slice(0, 19)
                        .replace('T', ' ') + ' UTC'
                    : 'Build a plan to begin playback'}
                </span>
              </div>
              <span className="active-count">
                {active} active spacecraft collections
              </span>
            </div>
            <Slider
              aria-label="Plan time"
              min={0}
              max={plan?.scenario.duration_seconds ?? 3600}
              step={1}
              value={[seconds]}
              disabled={!plan}
              onValueChange={(v) => seek(Array.isArray(v) ? v[0] : v)}
            />
            <div className="timeline-labels">
              <span>00:00</span>
              <span>{elapsed(plan?.scenario.duration_seconds ?? 3600)}</span>
            </div>
          </div>
          <div className="results-strip">
            {[
              ['Spacecraft', displayedFleet.length],
              [
                'Requests',
                plan?.counts.targets ?? database?.counts.requests ?? 0,
              ],
              ['Fulfilled', plan?.counts.planned ?? 0],
              ['Collections', plan?.counts.collections ?? 0],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{number(Number(value))}</strong>
              </div>
            ))}
            <div className="compute-stat">
              {plan ? `${plan.elapsed_seconds}s` : 'Ready'}
              <small>
                {plan ? 'Validated solve' : '100 × 10,000 baseline'}
              </small>
            </div>
          </div>
          <div className="run-notes">
            {plan?.accuracy ??
              'Local planning sandbox · WGS84 globe · Hover a target for collection information.'}
          </div>
        </div>
      </div>
      {working && (
        <output className="status-bar">
          <span>{job?.message || 'Job queued…'}</span>
          <Progress value={(job?.progress ?? 0) * 100} />
          <button
            onClick={() =>
              void act(async () => {
                await api(`/jobs/${job!.id}/cancel`, {}, 'POST');
              })
            }
          >
            Cancel job
          </button>
        </output>
      )}
      {(error || notice) && (
        <div
          className={`status-bar ${error ? 'status-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          <span>{error || notice}</span>
          <button
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </main>
  );
}
