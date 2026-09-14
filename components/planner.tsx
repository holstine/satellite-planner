'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Satellite as SatelliteIcon,
  Play,
  Pause,
  RotateCcw,
  Crosshair,
  Upload,
  Plus,
  Trash2,
  Pencil,
  Check,
  Download,
  Orbit,
  LoaderCircle,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import OrbitGlobe, { type GlobeOptions, type GlobeHandle } from './orbit-globe';
import {
  api,
  binary,
  defaults,
  type Constraints,
  type Target,
  type Satellite,
  type Job,
  type Playback,
  type Run,
} from '@/lib/orbit-api';

const number = (n: number) => n.toLocaleString();
const initialTarget = {
  name: '',
  latitude: 0,
  longitude: 0,
  priority: 1,
  enabled: true,
};
function Numeric({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        required
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
function Choice({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v !== null && onChange(v)}
      items={items}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem value={i.value} key={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Planner() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [constraints, setConstraints] = useState<Constraints>(defaults);
  const [start, setStart] = useState('2026-09-11T12:00');
  const [duration, setDuration] = useState(60);
  const [fleet, setFleet] = useState<Satellite[]>([]);
  const [fleetCount, setFleetCount] = useState(100);
  const [altitude, setAltitude] = useState(550);
  const [inclination, setInclination] = useState(53);
  const [tle, setTle] = useState('');
  const [points, setPoints] = useState<Float64Array | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Omit<Target, 'id'> & { id?: number }>(
    initialTarget,
  );
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [count, setCount] = useState(10000);
  const [seed, setSeed] = useState(42);
  const [feasible, setFeasible] = useState(true);
  const [bounds, setBounds] = useState({
    south: -60,
    north: 70,
    west: -180,
    east: 180,
  });
  const [importText, setImportText] = useState('');
  const [format, setFormat] = useState('csv');
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [seconds, setSeconds] = useState(0);
  const [fps, setFps] = useState(0);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState(0);
  const [options, setOptions] = useState<GlobeOptions>({
    targets: true,
    lines: true,
    cone: true,
    horizon: true,
    feasibleOnly: false,
  });
  const handle = useRef<GlobeHandle | null>(null);
  const working = busy || !!(job && ['queued', 'running'].includes(job.status));
  const refresh = useCallback(async () => {
    const [t, p, h] = await Promise.all([
      api<{ items: Target[]; total: number }>(
        `/targets?limit=25&offset=${offset}&q=${encodeURIComponent(query)}`,
      ),
      binary('/targets/points'),
      api<Job[]>('/jobs'),
    ]);
    setTargets(t.items);
    setTotal(t.total);
    setPoints(p);
    setHistory(h);
  }, [offset, query]);
  const act = useCallback(async (fn: () => Promise<void>) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      refresh().catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(timer);
  }, [refresh]);
  const loadRun = useCallback(async (id: string) => {
    const [run, positions, targets] = await Promise.all([
      api<Run>(`/jobs/${id}/files/result.json`),
      binary(`/jobs/${id}/files/positions.bin`),
      binary(`/jobs/${id}/files/targets.bin`),
    ]);
    setPlayback({ run, positions, targets });
    setPlaying(false);
    setSeconds(0);
    setSelected(0);
    setConstraints(run.scenario.constraints);
    setStart(new Date(run.scenario.start).toISOString().slice(0, 16));
    setDuration(run.scenario.duration_seconds / 60);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void act(async () => {
        const [c, s, h] = await Promise.all([
          api<Constraints>('/constraints'),
          api<Satellite[]>('/satellites'),
          api<Job[]>('/jobs'),
        ]);
        setConstraints(c);
        setFleet(s);
        setFleetCount(s.length);
        setConnected(true);
        setHistory(h);
        const pending = h.find((j) => ['queued', 'running'].includes(j.status));
        if (pending) setJob(pending);
        const recent = h.find(
          (j) => j.kind === 'schedule' && j.status === 'completed',
        );
        if (recent) await loadRun(recent.id);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [act, loadRun]);
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !['running', 'queued'].includes(jobStatus))
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>(`/jobs/${jobId}`);
        if (stopped) return;
        setJob(next);
        if (next.status === 'completed') {
          if (next.kind === 'schedule') await loadRun(next.id);
          else {
            setPlayback(null);
            setPlaying(false);
            const r = next.result as {
              accepted: number;
              attempted: number;
              complete: boolean;
            };
            setNotice(
              `Added ${number(r.accepted)} targets from ${number(r.attempted)} candidates.${r.complete ? '' : ' Attempt limit reached; widen the region or timeframe.'}`,
            );
          }
          await refresh();
        } else if (next.status === 'failed') {
          setError(next.error || 'Job failed');
          await refresh();
        } else if (next.status === 'cancelled') {
          setNotice('Job cancelled.');
          await refresh();
        } else timer = setTimeout(poll, 800);
      } catch (e) {
        if (!stopped) {
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(poll, 2000);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, jobStatus, loadRun, refresh]);
  const scenario = () => ({
    start: new Date(start + 'Z').toISOString(),
    duration_seconds: Math.round(duration * 60),
    constraints,
  });
  const submit = (kind: 'generate' | 'schedule') =>
    act(async () => {
      const body =
        kind === 'schedule'
          ? scenario()
          : { ...scenario(), count, seed, ...bounds, feasible_only: feasible };
      const result = await api<{ id: string; status: string }>(
        `/jobs/${kind}`,
        body,
        'POST',
      );
      setJob({ ...result, kind, created: new Date().toISOString() });
    });
  const onTime = useCallback(
    (time: number, frameRate: number, connections: number) => {
      setSeconds(time);
      setFps(frameRate);
      setActive(connections);
      if (playback && time >= playback.run.scenario.duration_seconds)
        setPlaying(false);
    },
    [playback],
  );
  const savedConstraints = (key: keyof Constraints, value: number | boolean) =>
    setConstraints((c) => ({ ...c, [key]: value }));
  const shownFleet = playback?.run.satellites ?? fleet;
  const run = playback?.run;
  const catalogCount = points ? points.length / 5 : 0;
  const clock = run
    ? new Date(new Date(run.scenario.start).getTime() + seconds * 1000)
        .toISOString()
        .slice(11, 19)
    : '—';
  const stale =
    run &&
    (JSON.stringify(run.scenario.constraints) !== JSON.stringify(constraints) ||
      new Date(run.scenario.start).getTime() !==
        new Date(start + 'Z').getTime() ||
      run.scenario.duration_seconds !== duration * 60);

  return (
    <main className="planner">
      <header className="masthead">
        <div className="brand">
          <Orbit size={27} />
          <span>
            ORBIT<span className="brand-light">DESK</span>
          </span>
          <span className="edition">LOCAL PLANNER</span>
        </div>
        <div className="server-state">
          <i className={connected ? 'live' : ''} />
          {connected ? 'Server connected' : 'Connecting to server'}
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
            <span className="eyebrow">MISSION WORKSPACE</span>
            <h1>Observation planner</h1>
          </div>
          <Tabs defaultValue="plan" className="workspace-tabs">
            <TabsList className="main-tabs">
              <TabsTrigger value="plan">Plan</TabsTrigger>
              <TabsTrigger value="targets">Targets</TabsTrigger>
              <TabsTrigger value="fleet">Fleet</TabsTrigger>
            </TabsList>
            <TabsContent value="plan" className="panel-scroll">
              <section>
                <div className="section-title">
                  <span>01</span>
                  <h2>Timeframe</h2>
                </div>
                <label className="field">
                  <span>Start time · UTC</span>
                  <input
                    type="datetime-local"
                    required
                    value={start}
                    onChange={(e) => {
                      if (e.target.value) setStart(e.target.value);
                    }}
                  />
                </label>
                <Numeric
                  label="Duration · minutes"
                  value={duration}
                  onChange={setDuration}
                  min={1}
                  max={1440}
                />
              </section>
              <section>
                <div className="section-title">
                  <span>02</span>
                  <h2>Observation rules</h2>
                </div>
                <Toggle
                  label="Daylight targets only"
                  checked={constraints.daylight_only}
                  onChange={(v) => savedConstraints('daylight_only', v)}
                />
                {constraints.daylight_only && (
                  <Numeric
                    label="Minimum sun elevation · °"
                    value={constraints.min_sun_elevation_deg}
                    onChange={(v) =>
                      savedConstraints('min_sun_elevation_deg', v)
                    }
                    min={-18}
                    max={90}
                  />
                )}
                <div className="field-pair">
                  <Numeric
                    label="Min. elevation · °"
                    value={constraints.min_elevation_deg}
                    onChange={(v) => savedConstraints('min_elevation_deg', v)}
                    min={0}
                    max={90}
                  />
                  <Numeric
                    label="Off-nadir limit · °"
                    value={constraints.max_off_nadir_deg}
                    onChange={(v) => savedConstraints('max_off_nadir_deg', v)}
                    min={0}
                    max={85}
                  />
                </div>
                <Numeric
                  label="Targets at once per satellite"
                  value={constraints.capacity_per_satellite}
                  onChange={(v) =>
                    savedConstraints('capacity_per_satellite', v)
                  }
                  min={1}
                  max={8}
                />
                <div className="field-pair">
                  <Numeric
                    label="Dwell · seconds"
                    value={constraints.dwell_seconds}
                    onChange={(v) => savedConstraints('dwell_seconds', v)}
                    min={5}
                    max={600}
                  />
                  <Numeric
                    label="Cooldown · seconds"
                    value={constraints.cooldown_seconds}
                    onChange={(v) => savedConstraints('cooldown_seconds', v)}
                    min={0}
                    max={3600}
                  />
                </div>
                <Toggle
                  label="Observe each target once"
                  checked={constraints.observe_target_once}
                  onChange={(v) => savedConstraints('observe_target_once', v)}
                />
                <details>
                  <summary>Scheduling resolution</summary>
                  <Numeric
                    label="Candidate start spacing · seconds"
                    value={constraints.step_seconds}
                    onChange={(v) => savedConstraints('step_seconds', v)}
                    min={5}
                    max={300}
                  />
                  <Numeric
                    label="Check interval during dwell · seconds"
                    value={constraints.validation_seconds}
                    onChange={(v) => savedConstraints('validation_seconds', v)}
                    min={1}
                    max={30}
                  />
                  <p className="hint">
                    Smaller intervals find more opportunities and cost more
                    compute. Feasibility is sampled across the full dwell.
                  </p>
                </details>
                <button
                  className="quiet full"
                  disabled={working}
                  onClick={() =>
                    void act(async () => {
                      await api('/constraints', constraints, 'PUT');
                      setNotice('Default constraints saved.');
                    })
                  }
                >
                  <Check size={15} /> Save as defaults
                </button>
              </section>
              <section>
                <div className="section-title">
                  <span>03</span>
                  <h2>Build schedule</h2>
                </div>
                <p className="hint">
                  Priority-first assignments with satellite capacity and
                  cooldown enforced. Higher target priority wins.
                </p>
                <button
                  className="primary full"
                  disabled={working || !connected || !catalogCount}
                  onClick={() => submit('schedule')}
                >
                  <Play size={16} /> Compute schedule
                </button>
                {!catalogCount && (
                  <p className="hint">
                    Add or generate targets in the Targets tab.
                  </p>
                )}
              </section>
              {history.some(
                (j) => j.kind === 'schedule' && j.status === 'completed',
              ) && (
                <section>
                  <h2>Saved runs</h2>
                  {history
                    .filter(
                      (j) => j.kind === 'schedule' && j.status === 'completed',
                    )
                    .slice(0, 5)
                    .map((j) => (
                      <button
                        className="history-row"
                        key={j.id}
                        disabled={busy}
                        onClick={() => act(() => loadRun(j.id))}
                      >
                        <span>{new Date(j.created).toLocaleString()}</span>
                        <span>Load ↗</span>
                      </button>
                    ))}
                </section>
              )}
            </TabsContent>
            <TabsContent value="targets" className="panel-scroll">
              <section>
                <div className="section-title">
                  <Crosshair size={17} />
                  <h2>Generate random targets</h2>
                </div>
                <div className="field-pair">
                  <Numeric
                    label="Number to add"
                    value={count}
                    onChange={setCount}
                    min={1}
                    max={100000}
                  />
                  <Numeric
                    label="Random seed"
                    value={seed}
                    onChange={setSeed}
                    min={0}
                  />
                </div>
                <Toggle
                  label="Keep observable targets only"
                  checked={feasible}
                  onChange={setFeasible}
                />
                <p className="hint">
                  Uses the current timeframe and rules. Observable targets may
                  still compete for schedule capacity.
                </p>
                <details>
                  <summary>Geographic bounds</summary>
                  <div className="field-pair">
                    {Object.entries(bounds).map(([key, value]) => (
                      <Numeric
                        key={key}
                        label={key + ' · °'}
                        value={value}
                        onChange={(v) => setBounds((b) => ({ ...b, [key]: v }))}
                        min={key === 'south' || key === 'north' ? -90 : -180}
                        max={key === 'south' || key === 'north' ? 90 : 180}
                      />
                    ))}
                  </div>
                  <p className="hint">
                    West greater than east crosses the date line. Coordinates
                    may include ocean.
                  </p>
                </details>
                <button
                  className="primary full"
                  disabled={working || !connected}
                  onClick={() => submit('generate')}
                >
                  <Plus size={16} /> Generate & add
                </button>
              </section>
              <section>
                <h2>Bulk import</h2>
                <div className="inline-controls">
                  <Choice
                    label="Import format"
                    value={format}
                    onChange={setFormat}
                    items={[
                      { value: 'csv', label: 'CSV' },
                      { value: 'json', label: 'JSON' },
                    ]}
                  />
                  <label className="file-button">
                    <Upload size={15} /> Open file
                    <input
                      type="file"
                      accept=".csv,.json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          void act(async () => {
                            if (file.size > 20000000)
                              throw new Error('File limit is 20 MB');
                            setImportText(await file.text());
                            setFormat(
                              file.name.endsWith('.json') ? 'json' : 'csv',
                            );
                          });
                      }}
                    />
                  </label>
                </div>
                <textarea
                  aria-label="Bulk targets"
                  rows={5}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={
                    'name,latitude,longitude,priority\nDenver,39.74,-104.99,10'
                  }
                />
                <p className="hint">
                  Fields: name, latitude, longitude; optional priority (1–100),
                  enabled. Import is all-or-nothing.
                </p>
                <button
                  className="quiet full"
                  disabled={working || !importText.trim()}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ inserted: number }>(
                        '/targets/import',
                        { text: importText, format },
                        'POST',
                      );
                      setImportText('');
                      setNotice(`Imported ${number(r.inserted)} targets.`);
                      await refresh();
                    })
                  }
                >
                  <Upload size={15} /> Import targets
                </button>
              </section>
              <section>
                <h2>
                  {editor.id ? 'Edit target #' + editor.id : 'Add target'}
                </h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const { id, ...body } = editor;
                      await api(
                        id ? `/targets/${id}` : '/targets',
                        body,
                        id ? 'PUT' : 'POST',
                      );
                      setEditor(initialTarget);
                      await refresh();
                      setNotice(id ? 'Target updated.' : 'Target added.');
                    });
                  }}
                >
                  <label className="field">
                    <span>Name</span>
                    <input
                      required
                      maxLength={120}
                      value={editor.name}
                      onChange={(e) =>
                        setEditor((t) => ({ ...t, name: e.target.value }))
                      }
                    />
                  </label>
                  <div className="field-pair">
                    <Numeric
                      label="Latitude · °"
                      value={editor.latitude}
                      step={0.00001}
                      min={-90}
                      max={90}
                      onChange={(v) =>
                        setEditor((t) => ({ ...t, latitude: v }))
                      }
                    />
                    <Numeric
                      label="Longitude · °"
                      value={editor.longitude}
                      step={0.00001}
                      min={-180}
                      max={180}
                      onChange={(v) =>
                        setEditor((t) => ({ ...t, longitude: v }))
                      }
                    />
                  </div>
                  <Numeric
                    label="Priority"
                    value={editor.priority}
                    min={1}
                    max={100}
                    onChange={(v) => setEditor((t) => ({ ...t, priority: v }))}
                  />
                  <Toggle
                    label="Enabled for scheduling"
                    checked={!!editor.enabled}
                    onChange={(v) => setEditor((t) => ({ ...t, enabled: v }))}
                  />
                  <div className="inline-controls">
                    <button className="quiet" type="submit" disabled={working}>
                      <Check size={15} /> Save target
                    </button>
                    {editor.id && (
                      <button
                        className="quiet"
                        type="button"
                        onClick={() => setEditor(initialTarget)}
                      >
                        Cancel edit
                      </button>
                    )}
                  </div>
                </form>
              </section>
              <section>
                <div className="section-title">
                  <h2>{number(total)} targets</h2>
                  <a
                    className="text-link"
                    href="http://127.0.0.1:8000/api/targets/export"
                  >
                    <Download size={15} /> CSV
                  </a>
                </div>
                <input
                  aria-label="Search targets"
                  placeholder="Search names…"
                  value={query}
                  onChange={(e) => {
                    setOffset(0);
                    setQuery(e.target.value);
                  }}
                />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {targets.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>
                          <span className={t.enabled ? '' : 'disabled-target'}>
                            {t.name}
                          </span>
                          <small>
                            {t.latitude.toFixed(2)}, {t.longitude.toFixed(2)}
                          </small>
                        </TableCell>
                        <TableCell>{t.priority}</TableCell>
                        <TableCell>
                          <div className="inline-controls">
                            <button
                              className="icon-button"
                              aria-label={`Edit ${t.name}`}
                              onClick={() =>
                                setEditor({ ...t, enabled: !!t.enabled })
                              }
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Delete ${t.name}`}
                              onClick={() => setDeleteId(t.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="pagination">
                  <button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 25))}
                  >
                    Previous
                  </button>
                  <span>
                    {total ? offset + 1 : 0}–{Math.min(total, offset + 25)}
                  </span>
                  <button
                    disabled={offset + 25 >= total}
                    onClick={() => setOffset(offset + 25)}
                  >
                    Next
                  </button>
                </div>
              </section>
            </TabsContent>
            <TabsContent value="fleet" className="panel-scroll">
              <section>
                <div className="section-title">
                  <SatelliteIcon size={18} />
                  <h2>{number(fleet.length)} satellites</h2>
                </div>
                <p className="hint">
                  The synthetic constellation is for performance and workflow
                  testing. Import TLEs to use real orbital elements.
                </p>
                <Numeric
                  label="Synthetic satellites"
                  value={fleetCount}
                  min={1}
                  max={1000}
                  onChange={setFleetCount}
                />
                <div className="field-pair">
                  <Numeric
                    label="Altitude · km"
                    value={altitude}
                    min={200}
                    max={2000}
                    onChange={setAltitude}
                  />
                  <Numeric
                    label="Inclination · °"
                    value={inclination}
                    min={0}
                    max={180}
                    onChange={setInclination}
                  />
                </div>
                <button
                  className="quiet full"
                  disabled={working}
                  onClick={() =>
                    void act(async () => {
                      setFleet(
                        await api<Satellite[]>(
                          '/satellites/demo',
                          {
                            count: fleetCount,
                            altitude_km: altitude,
                            inclination_deg: inclination,
                          },
                          'PUT',
                        ),
                      );
                      setNotice(
                        'Synthetic constellation replaced. Compute a new schedule to use it.',
                      );
                    })
                  }
                >
                  Replace with synthetic fleet
                </button>
              </section>
              <section>
                <h2>Import TLE constellation</h2>
                <textarea
                  rows={8}
                  aria-label="TLE constellation"
                  value={tle}
                  onChange={(e) => setTle(e.target.value)}
                  placeholder="Satellite name followed by TLE line 1 and line 2…"
                />
                <label className="file-button">
                  <Upload size={15} /> Open TLE file
                  <input
                    type="file"
                    accept=".txt,.tle"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        void act(async () => {
                          if (f.size > 1000000)
                            throw new Error('TLE limit is 1 MB');
                          setTle(await f.text());
                        });
                    }}
                  />
                </label>
                <button
                  className="primary full"
                  disabled={working || !tle.trim()}
                  onClick={() =>
                    void act(async () => {
                      const f = await api<Satellite[]>(
                        '/satellites/tle',
                        { text: tle },
                        'PUT',
                      );
                      setFleet(f);
                      setFleetCount(f.length);
                      setNotice(
                        `Imported ${f.length} satellites. Compute a new schedule to use them.`,
                      );
                    })
                  }
                >
                  Replace fleet with TLEs
                </button>
                <p className="hint">
                  SGP4 propagation. Use elements close to the scenario date; old
                  TLEs reduce accuracy.
                </p>
              </section>
              <section className="fleet-list">
                {fleet.slice(0, 100).map((s) => (
                  <div key={s.id}>
                    <span>{s.name}</span>
                    <span className="badge">{s.kind.toUpperCase()}</span>
                  </div>
                ))}
                {fleet.length > 100 && (
                  <p className="hint">
                    Showing first 100 of {number(fleet.length)}.
                  </p>
                )}
              </section>
            </TabsContent>
          </Tabs>
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
              onTime={onTime}
              onSelect={setSelected}
              handle={handle}
            />
            <div className="map-title">
              <span className="eyebrow">EARTH FIXED · WGS84</span>
              <h2>{run ? 'Observation playback' : 'Target workspace'}</h2>
              <span className="map-subtitle">
                {run
                  ? `${number(run.satellites.length)} satellites · ${run.satellites.every((s) => s.kind === 'demo') ? 'synthetic orbits' : 'SGP4 / imported orbits'}`
                  : 'Generate targets, then compute a schedule'}
              </span>
            </div>
            <div className="map-tools">
              {run && (
                <button
                  className="quiet"
                  onClick={() => {
                    setPlayback(null);
                    setPlaying(false);
                    setActive(0);
                  }}
                >
                  Current targets
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Reset globe view"
                onClick={() => handle.current?.home()}
              >
                <RotateCcw size={18} />
              </button>
            </div>
            <div className="layers">
              <span className="eyebrow">DISPLAY</span>
              {(
                [
                  ['targets', 'Targets'],
                  ['lines', 'Observation lines'],
                  ['cone', 'Selected field of regard'],
                  ['horizon', 'Selected horizon'],
                  ['feasibleOnly', 'Hide inaccessible targets'],
                ] as const
              )
                .filter(([key]) => !!run || key === 'targets')
                .map(([key, label]) => (
                  <Toggle
                    key={key}
                    label={label}
                    checked={options[key]}
                    onChange={(v) => setOptions((o) => ({ ...o, [key]: v }))}
                  />
                ))}
            </div>
            {run && (
              <div className="satellite-selector">
                <Choice
                  label="Selected satellite"
                  value={String(selected)}
                  onChange={(v) => setSelected(Number(v))}
                  items={shownFleet.map((s, i) => ({
                    value: String(i),
                    label: s.name,
                  }))}
                />
                <span>Detail geometry for selected satellite</span>
              </div>
            )}
            <div className="map-legend">
              {run && (
                <span>
                  <i className="dot green" />
                  Scheduled
                </span>
              )}
              <span>
                <i className="dot amber" />
                {run ? 'Observable' : 'Current targets · not assessed'}
              </span>
              {run && (
                <span>
                  <i className="dot grey" />
                  Inaccessible
                </span>
              )}
              <span className="fps">{playing ? `${fps} FPS` : 'PAUSED'}</span>
            </div>
            {!run && catalogCount === 0 && (
              <div className="empty-map">
                <Crosshair size={24} />
                <h3>Start with your targets</h3>
                <p>
                  Use the Targets tab to generate 10,000 observable locations or
                  import your own dataset.
                </p>
              </div>
            )}
          </div>
          <div className="playback">
            <div className="transport">
              <button
                className="play-button"
                aria-label={playing ? 'Pause playback' : 'Play playback'}
                disabled={!run}
                onClick={() => {
                  if (run && seconds >= run.scenario.duration_seconds)
                    handle.current?.seek(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                className="icon-button"
                aria-label="Restart playback"
                disabled={!run}
                onClick={() => {
                  handle.current?.seek(0);
                  setSeconds(0);
                }}
              >
                <RotateCcw size={16} />
              </button>
              <Choice
                label="Playback speed"
                value={String(speed)}
                onChange={(v) => setSpeed(Number(v))}
                items={[1, 10, 60, 300, 1000].map((v) => ({
                  value: String(v),
                  label: v + '×',
                }))}
              />
              <div className="time-display">
                <strong>{clock}</strong>
                <span>
                  UTC ·{' '}
                  {run ? run.scenario.start.slice(0, 10) : 'No schedule loaded'}
                </span>
              </div>
              <span className="active-count">{active} active observations</span>
            </div>
            <Slider
              aria-label="Playback time"
              value={[seconds]}
              min={0}
              max={run?.scenario.duration_seconds ?? 3600}
              step={1}
              disabled={!run}
              onValueChange={(v) => {
                const time = Array.isArray(v) ? v[0] : v;
                handle.current?.seek(time);
                setSeconds(time);
              }}
            />
            <div className="timeline-labels">
              <span>+00:00</span>
              <span>
                {run
                  ? `${Math.floor(run.scenario.duration_seconds / 60)} min`
                  : '60 min'}
              </span>
            </div>
          </div>
          <div className="results-strip">
            {[
              ['TARGETS', run?.counts.targets ?? catalogCount],
              ['OBSERVABLE', run?.counts.feasible],
              ['SCHEDULED', run?.counts.scheduled],
              ['UNASSIGNED', run?.counts.unassigned],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>
                  {typeof value === 'number' ? number(value) : '—'}
                </strong>
              </div>
            ))}
            <div className="compute-stat">
              <span>
                {run
                  ? `${run.elapsed_seconds.toFixed(2)} s compute`
                  : 'Ready to compute'}
              </span>
              <small>
                {run
                  ? 'Priority-first · sampled access'
                  : '100 satellites / 10,000 targets'}
              </small>
            </div>
          </div>
          {run && (
            <div className="run-notes">
              {stale
                ? 'Rules or timeframe changed. Playback shows the saved run. '
                : ''}
              Run snapshots keep their original targets and fleet. Geometry and
              daylight checks are sampled; terrain, weather, and attitude slew
              are not modeled.{' '}
              <a
                href={`/api/jobs/${run.id}/files/result.json`}
                target="_blank"
                rel="noreferrer"
              >
                Export schedule ↗
              </a>
            </div>
          )}
        </div>
      </div>
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this target?</AlertDialogTitle>
            <AlertDialogDescription>
              The target will be removed from the current catalog. Saved runs
              retain their original snapshot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep target</AlertDialogCancel>
            <AlertDialogAction
              disabled={working}
              onClick={() =>
                act(async () => {
                  await api(`/targets/${deleteId}`, undefined, 'DELETE');
                  setDeleteId(null);
                  await refresh();
                })
              }
            >
              Delete target
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {(working || error || notice || job?.status === 'cancelled') && (
        <div
          className={'status-bar ' + (error ? 'status-error' : '')}
          role={error ? 'alert' : 'status'}
        >
          {working ? (
            <>
              <LoaderCircle className="spin" size={17} />
              <span>
                {job && ['queued', 'running'].includes(job.status)
                  ? job.message || 'Preparing background job…'
                  : 'Working…'}
              </span>
              {job && ['queued', 'running'].includes(job.status) && (
                <>
                  <Progress
                    aria-label="Job progress"
                    value={(job.progress ?? 0) * 100}
                  />
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api(`/jobs/${job.id}/cancel`, {}, 'POST');
                      })
                    }
                  >
                    Cancel job
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <span>{error || notice || 'Job cancelled'}</span>
              <button
                aria-label="Dismiss message"
                onClick={() => {
                  setError('');
                  setNotice('');
                  if (job?.status === 'cancelled') setJob(null);
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
      )}
    </main>
  );
}
