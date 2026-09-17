'use client';
import type { Scenario } from '@/lib/orbit-api';
import { Numeric, Toggle, Choice } from './controls';

export default function SchedulePanel({
  scenario,
  onChange,
  submit,
  disabled,
  schedulers,
}: {
  scenario: Scenario;
  onChange: (s: Scenario) => void;
  submit: () => void;
  disabled: boolean;
  schedulers: string[];
}) {
  const c = scenario.constraints;
  const rule = (key: keyof typeof c, value: number | boolean) =>
    onChange({ ...scenario, constraints: { ...c, [key]: value } });
  return (
    <>
      <section>
        <span className="eyebrow">01 / PLANNING WINDOW</span>
        <h2>Turn requests into collections</h2>
        <label className="field">
          <span>Plan name</span>
          <input
            value={scenario.name}
            maxLength={120}
            onChange={(e) => onChange({ ...scenario, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Start time · UTC</span>
          <input
            type="datetime-local"
            value={scenario.start.slice(0, 16)}
            onChange={(e) =>
              e.target.value &&
              onChange({ ...scenario, start: e.target.value + ':00Z' })
            }
          />
        </label>
        <Numeric
          label="Timeframe (minutes)"
          value={scenario.duration_seconds / 60}
          min={1}
          max={1440}
          onChange={(v) => onChange({ ...scenario, duration_seconds: v * 60 })}
        />
        <button
          className="quiet"
          onClick={() =>
            onChange({
              ...scenario,
              start: new Date().toISOString().slice(0, 16) + ':00Z',
            })
          }
        >
          Use current UTC time
        </button>
        <Toggle
          label="Affected by weather"
          checked={c.affected_by_weather === true}
          onChange={(v) => rule('affected_by_weather', v)}
        />
        {c.affected_by_weather && (
          <>
            <Numeric
              label="Maximum cloud cover (%)"
              value={c.max_cloud_cover_pct}
              min={0}
              max={100}
              onChange={(v) => rule('max_cloud_cover_pct', v)}
            />
            <p className="hint">
              Cloud cover limits optical and infrared collections; stricter
              request limits apply. Radar is unaffected unless its request has a
              weather limit. Refresh the forecast in Weather first. Missing
              weather prevents affected collections.
            </p>
          </>
        )}
        <div className="field">
          <span>Scheduling strategy</span>
          <Choice
            label="Scheduling strategy"
            value={scenario.scheduler}
            onChange={(v) => onChange({ ...scenario, scheduler: v })}
            items={schedulers.map((s) => ({
              value: s,
              label:
                s === 'priority-greedy'
                  ? 'Priority first'
                  : s === 'earliest-deadline'
                    ? 'Earliest deadline'
                    : s,
            }))}
          />
        </div>
        <button
          className="primary full"
          disabled={disabled || !scenario.name.trim()}
          onClick={submit}
        >
          Build plan →
        </button>
        <p className="hint">
          Uses a snapshot of the current fleet and requests. Each result
          includes collection commands and an explanation for every request.
        </p>
      </section>
      <section>
        <span className="eyebrow">02 / FLEET GUARDRAILS</span>
        <h2>Shared constraints</h2>
        <div className="field-pair">
          <Numeric
            label="Targets at once / sat"
            value={c.capacity_per_satellite}
            min={1}
            max={8}
            onChange={(v) => rule('capacity_per_satellite', v)}
          />
          <Numeric
            label="Cooldown (s)"
            value={c.cooldown_seconds}
            min={0}
            max={3600}
            onChange={(v) => rule('cooldown_seconds', v)}
          />
        </div>
        <Toggle
          label="Require daylight for every request"
          checked={c.daylight_only}
          onChange={(v) => rule('daylight_only', v)}
        />
        <Toggle
          label="Require daylight for optical collections"
          checked={c.optical_daylight_only}
          onChange={(v) => rule('optical_daylight_only', v)}
        />
        <p className="hint">
          {c.optical_daylight_only
            ? 'Optical collections require the sun above the target horizon, even if a request permits nighttime.'
            : 'Optical night collections are allowed when individual requests permit them.'}{' '}
          Infrared and radar can operate at night unless another daylight rule
          applies.
        </p>
        <div className="field-pair">
          <Numeric
            label="Min elevation (°)"
            value={c.min_elevation_deg}
            min={0}
            max={90}
            onChange={(v) => rule('min_elevation_deg', v)}
          />
          <Numeric
            label="Max off-nadir (°)"
            value={c.max_off_nadir_deg}
            min={0}
            max={85}
            onChange={(v) => rule('max_off_nadir_deg', v)}
          />
        </div>
        {c.daylight_only && (
          <Numeric
            label="Min sun elevation (°)"
            value={c.min_sun_elevation_deg}
            min={-18}
            max={90}
            onChange={(v) => rule('min_sun_elevation_deg', v)}
          />
        )}
        <p className="hint">
          The stricter of request, spacecraft, and shared limits applies.
          Battery reserve and storage capacity always apply.
        </p>
      </section>
      <section>
        <span className="eyebrow">03 / SEARCH RESOLUTION</span>
        <div className="field-pair">
          <Numeric
            label="Candidate starts (s)"
            value={c.step_seconds}
            min={5}
            max={300}
            onChange={(v) => rule('step_seconds', v)}
          />
          <Numeric
            label="Dwell validation (s)"
            value={c.validation_seconds}
            min={1}
            max={30}
            onChange={(v) => rule('validation_seconds', v)}
          />
        </div>
        <Numeric
          label="Playback ephemeris step (s)"
          value={c.ephemeris_step_seconds}
          min={1}
          max={60}
          onChange={(v) => rule('ephemeris_step_seconds', v)}
        />
        <p className="hint">
          Finer steps can find shorter opportunities and cost more compute.
          Visibility is checked through the entire collection at the validation
          step, including its end.
        </p>
      </section>
    </>
  );
}
