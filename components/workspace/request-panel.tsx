'use client';
import { useEffect, useState } from 'react';
import {
  api,
  requestDefaults,
  number,
  type CollectionRequest,
  type Target,
  type Page,
  type Scenario,
  type Job,
} from '@/lib/orbit-api';
import { Numeric, Toggle, Choice, Pager, type Act } from './controls';

const numericFields: [keyof CollectionRequest, string, number, number][] = [
  ['latitude', 'Latitude (°)', -90, 90],
  ['longitude', 'Longitude (°)', -180, 180],
  ['priority', 'Priority', 1, 100],
  ['duration_seconds', 'Duration (s)', 5, 600],
  ['energy_wh', 'Energy / sat (Wh)', 0, 10000],
  ['data_mb', 'Data / sat (MB)', 0, 100000],
  ['satellites_required', 'Simultaneous sats', 1, 8],
  ['collections_required', 'Collections', 1, 20],
  ['revisit_seconds', 'Gap between collections (s)', 0, 86400],
  ['window_start_seconds', 'Window starts at (s)', 0, 86400],
  ['min_elevation_deg', 'Min elevation (°)', 0, 90],
  ['min_off_nadir_deg', 'Min off-nadir (°)', 0, 85],
  ['max_off_nadir_deg', 'Max off-nadir (°)', 0, 85],
  ['min_sun_elevation_deg', 'Min sun elevation (°)', -18, 90],
];
export default function RequestPanel({
  revision,
  act,
  changed,
  scenario,
  setJob,
  working,
}: {
  revision: number;
  act: Act;
  changed: () => Promise<void>;
  scenario: Scenario;
  setJob: (j: Job) => void;
  working: boolean;
}) {
  const [list, setList] = useState<Page<Target>>({ items: [], total: 0 });
  const [offset, setOffset] = useState(0),
    [query, setQuery] = useState('');
  const [editor, setEditor] = useState<CollectionRequest | null>(null),
    [editId, setEditId] = useState<number | null>(null);
  const [text, setText] = useState(''),
    [format, setFormat] = useState('csv');
  const [count, setCount] = useState(10000),
    [seed, setSeed] = useState(42),
    [random, setRandom] = useState(true);
  const [replace, setReplace] = useState(true);
  const [randomWeather, setRandomWeather] = useState(false);
  const [bounds, setBounds] = useState({
    south: -60,
    north: 70,
    west: -180,
    east: 180,
  });
  const [localRevision, setLocalRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    const timer = setTimeout(
      () =>
        void act(async () => {
          const result = await api<Page<Target>>(
            `/requests?offset=${offset}&limit=25&q=${encodeURIComponent(query)}`,
          );
          if (!stopped) setList(result);
        }),
      180,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [offset, query, revision, localRevision, act]);
  const refresh = async () => {
    setLocalRevision((v) => v + 1);
    await changed();
  };
  return (
    <>
      <section>
        <span className="eyebrow">REQUEST CATALOG</span>
        <h2>{number(list.total)} targeting requests</h2>
        <p className="hint">
          A target is a location. Its request defines what to collect, when, and
          with how many spacecraft.
        </p>
        <div className="inline-controls">
          <button
            className="quiet"
            onClick={() => {
              setEditor({ ...requestDefaults });
              setEditId(null);
            }}
          >
            + Add request
          </button>
          <a className="text-link" href="/api/requests/export" download>
            Export CSV ↗
          </a>
        </div>
        <button
          className="quiet full"
          disabled={working}
          onClick={() => {
            if (
              window.confirm(
                'Clear every request from the current catalog? Saved plans keep their snapshots.',
              )
            )
              void act(async () => {
                await api('/requests', undefined, 'DELETE');
                setEditor(null);
                setEditId(null);
                setOffset(0);
                setQuery('');
                await refresh();
              });
          }}
        >
          Clear all requests
        </button>
        {editor && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(
                  editId ? `/requests/${editId}` : '/requests',
                  editor,
                  editId ? 'PUT' : 'POST',
                );
                setEditor(null);
                await refresh();
              });
            }}
          >
            <label className="field">
              <span>Name</span>
              <input
                value={editor.name}
                required
                maxLength={120}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <div className="field-pair">
              {numericFields.map(([key, label, min, max]) => (
                <Numeric
                  key={key}
                  label={label}
                  value={Number(editor[key])}
                  min={min}
                  max={max}
                  step={
                    ['latitude', 'longitude', 'energy_wh', 'data_mb'].includes(
                      key,
                    )
                      ? 0.001
                      : 1
                  }
                  onChange={(value) => setEditor({ ...editor, [key]: value })}
                />
              ))}
            </div>
            <label className="field">
              <span>Window ends at (s) · blank = plan end</span>
              <input
                type="number"
                min={1}
                max={86400}
                value={editor.window_end_seconds ?? ''}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    window_end_seconds:
                      e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
            <Choice
              label="Sensor"
              value={editor.sensor}
              onChange={(v) =>
                setEditor({
                  ...editor,
                  sensor: v as 'optical' | 'infrared' | 'radar',
                })
              }
              items={[
                { value: 'optical', label: 'Optical sensor' },
                { value: 'infrared', label: 'Infrared sensor' },
                { value: 'radar', label: 'Radar sensor' },
              ]}
            />
            <Toggle
              label="Daylight only"
              checked={editor.daylight_only}
              onChange={(v) => setEditor({ ...editor, daylight_only: v })}
            />
            <Toggle
              label="Request enabled"
              checked={editor.enabled}
              onChange={(v) => setEditor({ ...editor, enabled: v })}
            />
            <fieldset>
              <legend>Weather requirements · blank means unrestricted</legend>
              {(
                [
                  ['max_cloud_cover_pct', 'Maximum cloud cover (%)', 100],
                  [
                    'max_precipitation_mm',
                    'Maximum hourly precipitation (mm)',
                    1000,
                  ],
                  ['max_wind_speed_mps', 'Maximum wind at 10 m (m/s)', 200],
                ] as const
              ).map(([key, label, max]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={max}
                    step="any"
                    value={editor[key] ?? ''}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        [key]:
                          e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </fieldset>
            <div className="inline-controls">
              <button className="primary" type="submit">
                Save request
              </button>
              <button
                className="quiet"
                type="button"
                onClick={() => setEditor(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <label className="field">
          <span>Search requests</span>
          <input
            value={query}
            placeholder="Find by name…"
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <div className="catalog-list">
          {list.items.map((target) => (
            <article
              key={target.id}
              className={target.enabled ? '' : 'disabled-target'}
            >
              <button
                className="catalog-name"
                onClick={() => {
                  const { id, ...record } = target;
                  setEditor(record);
                  setEditId(id);
                }}
              >
                <strong>{target.name}</strong>
                <small>
                  {target.duration_seconds}s · {target.satellites_required} sat
                  · {target.energy_wh} Wh · P{target.priority}
                </small>
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${target.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete request “${target.name}” from the catalog? Saved plans remain available.`,
                    )
                  )
                    void act(async () => {
                      await api(`/requests/${target.id}`, undefined, 'DELETE');
                      await refresh();
                    });
                }}
              >
                ×
              </button>
            </article>
          ))}
        </div>
        <Pager offset={offset} total={list.total} onChange={setOffset} />
      </section>
      <section>
        <span className="eyebrow">BULK GENERATION</span>
        <h2>Fill the globe</h2>
        <div className="field-pair">
          <Numeric
            label="Requests to generate"
            value={count}
            min={1}
            max={100000}
            onChange={setCount}
          />
          <Numeric
            label="Random seed"
            value={seed}
            min={0}
            max={4294967295}
            onChange={setSeed}
          />
        </div>
        <Toggle
          label="Randomize collection parameters"
          checked={random}
          onChange={setRandom}
        />
        <Toggle
          label="Include random weather requirements"
          checked={randomWeather}
          onChange={setRandomWeather}
        />
        {randomWeather && (
          <p className="hint">
            Refresh weather before scheduling. Requests with missing weather
            will remain unplanned.
          </p>
        )}
        <Toggle
          label="Replace current request catalog"
          checked={replace}
          onChange={setReplace}
        />
        <p className="hint">
          Randomizes time on target (10–120 seconds), priority, energy, data
          volume, sensor, simultaneous spacecraft, repeat collections, revisit
          gaps, time windows, pointing angles, and sunlight requirements.
        </p>
        <details>
          <summary>Geographic bounds</summary>
          <div className="field-pair">
            {(['south', 'north', 'west', 'east'] as const).map((key) => (
              <Numeric
                key={key}
                label={key}
                value={bounds[key]}
                min={key === 'south' || key === 'north' ? -90 : -180}
                max={key === 'south' || key === 'north' ? 90 : 180}
                onChange={(v) => setBounds({ ...bounds, [key]: v })}
              />
            ))}
          </div>
        </details>
        <button
          className="primary full"
          disabled={working}
          onClick={() =>
            void act(async () => {
              if (
                replace &&
                !window.confirm(
                  `Replace the current catalog with ${number(count)} generated requests? Saved plans keep their snapshots.`,
                )
              )
                return;
              setJob(
                await api<Job>(
                  '/jobs/generate',
                  {
                    ...scenario,
                    ...bounds,
                    count,
                    seed,
                    randomize_parameters: random,
                    randomize_weather: randomWeather,
                    replace_existing: replace,
                  },
                  'POST',
                ),
              );
            })
          }
        >
          {replace ? 'Replace with' : 'Add'} {number(count)} random requests
        </button>
        <p className="hint">
          Creates the full requested count. The timeframe sets the range for
          random request windows; visibility, resources, and allocation are
          evaluated only when you build a plan.
        </p>
      </section>
      <section>
        <h2>Import requests in bulk</h2>
        <Choice
          label="Import format"
          value={format}
          onChange={setFormat}
          items={[
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON array' },
          ]}
        />
        <label className="file-button full">
          Choose file
          <input
            type="file"
            accept=".csv,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void act(async () => {
                  setText(await file.text());
                  setFormat(file.name.endsWith('.json') ? 'json' : 'csv');
                });
            }}
          />
        </label>
        <textarea
          aria-label="Bulk request data"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            'name,latitude,longitude,duration_seconds,energy_wh,satellites_required\nDenver,39.74,-104.99,30,5,1'
          }
        />
        <p className="hint">
          Only name, latitude, and longitude are required. Export CSV for the
          complete parameter template. An invalid row rejects the entire batch.
        </p>
        <button
          className="quiet full"
          disabled={!text.trim()}
          onClick={() =>
            void act(async () => {
              await api('/requests/import', { text, format }, 'POST');
              setText('');
              await refresh();
            })
          }
        >
          Import batch
        </button>
      </section>
    </>
  );
}
