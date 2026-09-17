'use client';
import { useState } from 'react';
import { api, elapsed, type Job, type Run } from '@/lib/orbit-api';
import { Choice, Numeric, Toggle, type Act } from './controls';

type Edit = {
  action: string;
  collection_id?: string;
  request_id?: number;
  start_seconds?: number;
  spacecraft_ids?: string[];
};
export default function WhatIfPanel({
  plan,
  setJob,
  working,
  job,
  act,
  load,
}: {
  plan: Run;
  setJob: (job: Job) => void;
  working: boolean;
  job: Job | null;
  act: Act;
  load: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(
    `${plan.scenario.name.slice(0, 100)} · what-if`,
  );
  const [mode, setMode] = useState('edit'),
    [action, setAction] = useState('move');
  const groups = [
    ...new Map(plan.instructions.map((i) => [i.collection_id, i])).values(),
  ];
  const [collection, setCollection] = useState(groups[0]?.collection_id ?? '');
  const [requestId, setRequestId] = useState(groups[0]?.request_id ?? 1),
    [start, setStart] = useState(0);
  const [spacecraft, setSpacecraft] = useState(''),
    [edits, setEdits] = useState<Edit[]>([]);
  const [advanced, setAdvanced] = useState('{}'),
    [refreshWeather, setRefreshWeather] = useState(false);
  const run = (save: boolean) =>
    void act(async () => {
      const extra = JSON.parse(advanced);
      if (!extra || typeof extra !== 'object' || Array.isArray(extra))
        throw new Error('Advanced changes must be a JSON object');
      setJob(
        await api<Job>(
          `/plans/${plan.id}/whatif`,
          {
            ...extra,
            name,
            mode,
            collections: mode === 'reschedule' ? [] : edits,
            refresh_weather_snapshot: refreshWeather,
            save,
          },
          'POST',
        ),
      );
    });
  return (
    <section>
      <span className="eyebrow">WHAT-IF PLANNING</span>
      <h2>Try a different plan</h2>
      <p className="hint">
        Changes apply together to a copy. Invalid changes report a reason and
        save nothing.
      </p>
      <label className="field">
        <span>Variant name</span>
        <input
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <Choice
        label="Planning mode"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'edit', label: 'Keep collections; apply my edits' },
          {
            value: 'fill',
            label: 'Keep collections; schedule remaining requests',
          },
          { value: 'reschedule', label: 'Rearrange the entire plan' },
        ]}
      />
      {mode !== 'reschedule' && (
        <>
          <Choice
            label="Collection change"
            value={action}
            onChange={setAction}
            items={['move', 'add', 'remove'].map((value) => ({
              value,
              label: `${value[0].toUpperCase()}${value.slice(1)} collection`,
            }))}
          />
          {action !== 'add' ? (
            <Choice
              label="Collection"
              value={collection}
              onChange={(id) => {
                setCollection(id);
                const item = groups.find((g) => g.collection_id === id);
                if (item) {
                  setStart(item.start);
                  setRequestId(item.request_id);
                }
              }}
              items={groups.map((i) => ({
                value: i.collection_id,
                label: `Request ${i.request_id} · ${elapsed(i.start)} · ${i.collection_id}`,
              }))}
            />
          ) : (
            <Numeric
              label="Request ID from this plan"
              value={requestId}
              min={1}
              max={2147483647}
              onChange={setRequestId}
            />
          )}
          {action !== 'remove' && (
            <>
              <Numeric
                label="Start offset (seconds)"
                value={start}
                min={0}
                max={plan.scenario.duration_seconds}
                onChange={setStart}
              />
              <label className="field">
                <span>
                  Spacecraft IDs, comma separated{' '}
                  {action === 'move' ? '(blank keeps participants)' : ''}
                </span>
                <input
                  value={spacecraft}
                  onChange={(e) => setSpacecraft(e.target.value)}
                  placeholder={plan.satellites[0]?.id}
                />
              </label>
            </>
          )}
          <button
            className="quiet"
            disabled={action !== 'add' && !collection}
            onClick={() => {
              const participants = spacecraft
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              setEdits([
                ...edits,
                {
                  action,
                  ...(action === 'add'
                    ? { request_id: requestId }
                    : { collection_id: collection }),
                  ...(action === 'remove'
                    ? {}
                    : {
                        start_seconds: start,
                        ...(participants.length
                          ? { spacecraft_ids: participants }
                          : {}),
                      }),
                },
              ]);
            }}
          >
            Queue change
          </button>
          {edits.map((edit, index) => (
            <div className="inline-controls" key={index}>
              <small>
                {edit.action} ·{' '}
                {edit.collection_id ?? `request ${edit.request_id}`}{' '}
                {edit.start_seconds !== undefined
                  ? `at ${edit.start_seconds}s`
                  : ''}
              </small>
              <button
                className="quiet"
                onClick={() => setEdits(edits.filter((_, i) => i !== index))}
              >
                Remove edit
              </button>
            </div>
          ))}
        </>
      )}
      <Toggle
        label="Use latest cached weather for this variant"
        checked={refreshWeather}
        onChange={setRefreshWeather}
      />
      <details>
        <summary>Request, fleet, and scenario changes (JSON)</summary>
        <p className="hint">
          Use add_requests, request_changes (complete records with IDs),
          remove_request_ids, spacecraft_changes, remove_spacecraft_ids, or
          scenario. Removing a spacecraft removes its entire synchronized
          collections. These changes never edit the catalog.
        </p>
        <textarea
          className="import-text"
          aria-label="Advanced what-if changes"
          rows={8}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
      </details>
      <div className="inline-controls">
        <button className="quiet" disabled={working} onClick={() => run(false)}>
          Validate & compare
        </button>
        <button
          className="primary"
          disabled={working}
          onClick={() => run(true)}
        >
          Save valid variant
        </button>
      </div>
      {job?.kind === 'whatif' &&
        job.status === 'completed' &&
        !job.result?.plan_id && (
          <p className="hint">
            Preview passed validation. Added{' '}
            {job.result?.comparison?.added_collections.length}, removed{' '}
            {job.result?.comparison?.removed_collections.length}, rearranged{' '}
            {job.result?.comparison?.rearranged_collections.length} collections.
            No plan was saved.
          </p>
        )}
      {plan.parent_plan_id && (
        <div className="hint">
          <p>
            This is a variant: {plan.changes?.added_collections.length} added,{' '}
            {plan.changes?.removed_collections.length} removed,{' '}
            {plan.changes?.rearranged_collections.length} rearranged
            collections.
          </p>
          <button
            className="quiet"
            onClick={() => void act(() => load(plan.parent_plan_id!))}
          >
            Open original plan
          </button>
        </div>
      )}
    </section>
  );
}
