'use client';
import { useState } from 'react';
import { api, type Satellite, number } from '@/lib/orbit-api';
import { Choice, Numeric, Toggle, type Act } from './controls';

export default function FleetPanel({
  fleet,
  act,
  changed,
}: {
  fleet: Satellite[];
  act: Act;
  changed: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Satellite | null>(null),
    [text, setText] = useState(''),
    [tle, setTle] = useState('');
  const [count, setCount] = useState(100),
    [altitude, setAltitude] = useState(550),
    [inclination, setInclination] = useState(53),
    [profile, setProfile] = useState<'mixed' | 'leo'>('mixed');
  const [query, setQuery] = useState('');
  const resourceFields: [keyof Satellite, string, number, number][] = [
    ['battery_capacity_wh', 'Battery capacity (Wh)', 1, 10000000],
    ['initial_battery_wh', 'Initial charge (Wh)', 0, 10000000],
    ['battery_reserve_wh', 'Reserve (Wh)', 0, 10000000],
    ['storage_capacity_mb', 'Storage capacity (MB)', 0, 100000000],
    ['initial_storage_mb', 'Initial storage (MB)', 0, 100000000],
    ['capacity', 'Concurrent targets', 1, 8],
    ['max_off_nadir_deg', 'Max off-nadir (°)', 0, 85],
  ];
  return (
    <>
      <section>
        <span className="eyebrow">FLEET MANAGEMENT</span>
        <h2>{number(fleet.length)} spacecraft</h2>
        <p className="hint">
          Ephemeris, sensors, and resource budgets form the spacecraft state
          used by a plan. Saved plans retain their own fleet snapshot.
        </p>
        <label className="field">
          <span>Find spacecraft</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or ID"
          />
        </label>
        <div className="catalog-list fleet-catalog">
          {fleet
            .filter((s) =>
              `${s.name} ${s.id}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((s) => (
              <article key={s.id}>
                <button
                  className="catalog-name"
                  onClick={() => setSelected({ ...s })}
                >
                  <strong>
                    {s.name} {!s.enabled && '· disabled'}
                  </strong>
                  <small>
                    {s.orbit_class} · {s.initial_battery_wh} Wh ·{' '}
                    {s.sensors.join(' / ')}
                  </small>
                </button>
              </article>
            ))}
        </div>
        {selected && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(`/fleet/${selected.id}`, selected, 'PUT');
                await changed();
                setSelected(null);
              });
            }}
          >
            <h3>{selected.name}</h3>
            <label className="field">
              <span>Name</span>
              <input
                value={selected.name}
                required
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <div className="field-pair">
              {resourceFields.map(([key, label, min, max]) => (
                <Numeric
                  key={key}
                  label={label}
                  min={min}
                  max={max}
                  value={Number(selected[key])}
                  onChange={(v) => setSelected({ ...selected, [key]: v })}
                />
              ))}
            </div>
            {selected.kind === 'demo' && (
              <div className="field-pair">
                <Numeric
                  label="Altitude (km)"
                  value={selected.altitude_km}
                  min={200}
                  max={50000}
                  onChange={(v) => setSelected({ ...selected, altitude_km: v })}
                />
                <Numeric
                  label="Inclination (°)"
                  value={selected.inclination_deg}
                  min={0}
                  max={180}
                  onChange={(v) =>
                    setSelected({ ...selected, inclination_deg: v })
                  }
                />
              </div>
            )}
            {(['optical', 'infrared', 'radar'] as const).map((sensor) => (
              <Toggle
                key={sensor}
                label={`${sensor} sensor`}
                checked={selected.sensors.includes(sensor)}
                onChange={(v) =>
                  setSelected({
                    ...selected,
                    sensors: v
                      ? [...selected.sensors, sensor]
                      : selected.sensors.filter((s) => s !== sensor),
                  })
                }
              />
            ))}
            <Toggle
              label="Spacecraft enabled"
              checked={selected.enabled}
              onChange={(v) => setSelected({ ...selected, enabled: v })}
            />
            <div className="inline-controls">
              <button type="submit" className="primary">
                Save spacecraft
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Delete spacecraft"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete ${selected.name} from the current fleet?`,
                    )
                  )
                    void act(async () => {
                      await api(`/fleet/${selected.id}`, undefined, 'DELETE');
                      setSelected(null);
                      await changed();
                    });
                }}
              >
                ×
              </button>
            </div>
          </form>
        )}
      </section>
      <section>
        <h2>Demo constellation</h2>
        <Choice
          label="Synthetic orbit mix"
          value={profile}
          onChange={(value) => setProfile(value as 'mixed' | 'leo')}
          items={[
            {
              value: 'mixed',
              label: 'Mixed: 70% LEO · 15% MEO · 10% GEO · 5% HEO',
            },
            { value: 'leo', label: 'LEO only' },
          ]}
        />
        <div className="field-pair">
          <Numeric
            label="Spacecraft"
            min={1}
            max={1000}
            value={count}
            onChange={setCount}
          />
          <Numeric
            label="Altitude (km)"
            value={altitude}
            min={200}
            max={2000}
            onChange={setAltitude}
          />
        </div>
        <Numeric
          label="Inclination (°)"
          value={inclination}
          min={0}
          max={180}
          onChange={setInclination}
        />
        <button
          className="quiet full"
          onClick={() => {
            if (
              window.confirm(
                `Replace the current fleet with ${count} synthetic spacecraft?`,
              )
            )
              void act(async () => {
                await api(
                  '/fleet/demo',
                  {
                    count,
                    profile,
                    altitude_km: altitude,
                    inclination_deg: inclination,
                  },
                  'PUT',
                );
                await changed();
              });
          }}
        >
          Replace with demo fleet
        </button>
      </section>
      <section>
        <h2>Import ephemeris</h2>
        <details>
          <summary>TLE constellation</summary>
          <textarea
            rows={5}
            aria-label="TLE pairs"
            value={tle}
            onChange={(e) => setTle(e.target.value)}
            placeholder="Optional name followed by TLE line 1 and line 2"
          />
          <button
            className="quiet full"
            disabled={!tle.trim()}
            onClick={() => {
              if (
                window.confirm(
                  'Replace the current fleet with these TLE spacecraft?',
                )
              )
                void act(async () => {
                  await api('/fleet/tle', { text: tle }, 'PUT');
                  setTle('');
                  await changed();
                });
            }}
          >
            Replace fleet from TLEs
          </button>
        </details>
        <details>
          <summary>Spacecraft JSON · full state or sampled ECEF</summary>
          <p className="hint">
            Paste one spacecraft object to add or replace its ID. Sampled
            ephemeris uses timestamped x/y/z in Earth-fixed meters and must
            cover the full planning timeframe. All fields are documented in the
            API schema.
          </p>
          <a
            className="text-link"
            href="http://127.0.0.1:8000/docs"
            target="_blank"
            rel="noreferrer"
          >
            Open spacecraft schema ↗
          </a>
          <textarea
            rows={7}
            aria-label="Spacecraft JSON"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              '{"id":"sat-new","name":"New spacecraft","kind":"demo"}'
            }
          />
          <button
            className="quiet full"
            disabled={!text.trim()}
            onClick={() =>
              void act(async () => {
                const record = JSON.parse(text);
                await api(
                  `/fleet/${encodeURIComponent(record.id)}`,
                  record,
                  'PUT',
                );
                setText('');
                await changed();
              })
            }
          >
            Save spacecraft JSON
          </button>
        </details>
      </section>
    </>
  );
}
