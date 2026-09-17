'use client';
import { useEffect, useState } from 'react';
import {
  api,
  elapsed,
  number,
  type Decision,
  type Explanation,
  type Page,
  type Run,
  type Observation,
  type Job,
} from '@/lib/orbit-api';
import { Choice, Pager, type Act } from './controls';
import WhatIfPanel from './whatif-panel';
import { planLabel, planNeedsRebuild } from '@/lib/plan-label';

export function CollectionDetails({ detail }: { detail: Explanation }) {
  return (
    <div className="collection-details">
      <span className={`status-pill ${detail.decision.status}`}>
        {detail.decision.status}
      </span>
      <h3>{detail.request.name}</h3>
      <p>{detail.decision.explanation}</p>
      <div className="detail-grid">
        <span>
          Collections
          <strong>
            {detail.decision.collections_planned} /{' '}
            {detail.decision.collections_requested}
          </strong>
        </span>
        <span>
          Duration<strong>{detail.request.duration_seconds}s</strong>
        </span>
        <span>
          Spacecraft together
          <strong>{detail.request.satellites_required}</strong>
        </span>
        <span>
          Energy / sat<strong>{detail.request.energy_wh} Wh</strong>
        </span>
      </div>
      {detail.collections.length > 0 && (
        <div className="collection-times">
          {detail.collections.slice(0, 8).map((c) => (
            <div key={c.id}>
              <span>{c.spacecraft_id}</span>
              <b>
                {elapsed(c.start)}–{elapsed(c.end)}
              </b>
            </div>
          ))}
          {detail.collections.length > 8 && (
            <small>+ {detail.collections.length - 8} more instructions</small>
          )}
        </div>
      )}
    </div>
  );
}

export default function PlanPanel({
  plans,
  plan,
  load,
  act,
  seek,
  setJob,
  working,
  job,
}: {
  plans: Run[];
  plan: Run | null;
  load: (id: string) => Promise<void>;
  act: Act;
  seek: (seconds: number) => void;
  setJob: (job: Job) => void;
  working: boolean;
  job: Job | null;
}) {
  const [status, setStatus] = useState('all'),
    [reason, setReason] = useState('all'),
    [offset, setOffset] = useState(0);
  const [decisions, setDecisions] = useState<Page<Decision>>({
      items: [],
      total: 0,
    }),
    [detail, setDetail] = useState<Explanation | null>(null);
  const [spacecraft, setSpacecraft] = useState(''),
    [timeline, setTimeline] = useState<
      | (Page<Observation> & {
          remaining_battery_wh: number;
          storage_used_mb: number;
        })
      | null
    >(null),
    [timelineOffset, setTimelineOffset] = useState(0);
  useEffect(() => {
    let stopped = false;
    if (plan)
      void act(async () => {
        const result = await api<Page<Decision>>(
          `/plans/${plan.id}/decisions?offset=${offset}&limit=25${status === 'all' ? '' : `&status=${status}`}${reason === 'all' ? '' : `&reason=${reason}`}`,
        );
        if (!stopped) setDecisions(result);
      });
    return () => {
      stopped = true;
    };
  }, [plan, status, reason, offset, act]);
  useEffect(() => {
    let stopped = false;
    if (plan && spacecraft)
      void act(async () => {
        const result = await api<
          Page<Observation> & {
            remaining_battery_wh: number;
            storage_used_mb: number;
          }
        >(
          `/plans/${plan.id}/spacecraft/${spacecraft}?offset=${timelineOffset}&limit=25`,
        );
        if (!stopped) setTimeline(result);
      });
    return () => {
      stopped = true;
    };
  }, [plan, spacecraft, timelineOffset, act]);
  return (
    <>
      <section>
        <span className="eyebrow">SAVED PLANS</span>
        <h2>Inspect the outcome</h2>
        {plans.length ? (
          <Choice
            label="Saved plan"
            value={plan?.id ?? ''}
            onChange={(id) =>
              void act(async () => {
                setOffset(0);
                setDetail(null);
                setSpacecraft('');
                setTimeline(null);
                await load(id);
              })
            }
            items={plans.map((p) => ({
              value: p.id,
              label: planLabel(p),
            }))}
          />
        ) : (
          <p className="hint">
            Build a plan from the Schedule tab. It will appear here with
            instructions and request decisions.
          </p>
        )}
        {plan && (
          <>
            <div className="plan-summary">
              <strong>{number(plan.counts.planned)} fulfilled</strong>
              <span>
                {number(plan.counts.partial)} partial ·{' '}
                {number(plan.counts.unplanned)} unplanned
              </span>
            </div>
            <p className="hint">
              {plan.elapsed_seconds}s · {plan.scenario.scheduler}
              <br />
              {!planNeedsRebuild(plan)
                ? '✓ Instructions independently validated'
                : 'Rebuild required — current checks were not run'}
            </p>
            <a
              className="text-link"
              href={`/api/plans/${plan.id}/snapshot`}
              target="_blank"
              rel="noreferrer"
            >
              Input snapshot ↗
            </a>
            <a
              className="text-link"
              href={`/api/plans/${plan.id}/playback`}
              target="_blank"
              rel="noreferrer"
            >
              Collection commands ↗
            </a>
          </>
        )}
      </section>
      {plan && (
        <>
          <WhatIfPanel
            plan={plan}
            setJob={setJob}
            working={working}
            job={job}
            act={act}
            load={load}
          />
          <section>
            <h2>Planned & not planned</h2>
            <div className="field-pair">
              <Choice
                label="Request status"
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setOffset(0);
                }}
                items={[
                  'all',
                  'planned',
                  'partial',
                  'unplanned',
                  'disabled',
                ].map((v) => ({
                  value: v,
                  label: v === 'all' ? 'All statuses' : v,
                }))}
              />
              <Choice
                label="Decision reason"
                value={reason}
                onChange={(v) => {
                  setReason(v);
                  setOffset(0);
                }}
                items={[
                  { value: 'all', label: 'All reasons' },
                  ...Object.keys(plan.reasons ?? {}).map((v) => ({
                    value: v,
                    label: v.replaceAll('_', ' '),
                  })),
                ]}
              />
            </div>
            <div className="decision-list">
              {decisions.items.map((d) => (
                <button
                  key={d.request_id}
                  onClick={() =>
                    void act(async () =>
                      setDetail(
                        await api<Explanation>(
                          `/plans/${plan.id}/requests/${d.request_id}`,
                        ),
                      ),
                    )
                  }
                >
                  <span>
                    <strong>{d.name}</strong>
                    <small>{d.reason_code.replaceAll('_', ' ')}</small>
                  </span>
                  <span className={`status-pill ${d.status}`}>
                    {d.collections_planned}/{d.collections_requested}
                  </span>
                </button>
              ))}
            </div>
            <Pager
              offset={offset}
              total={decisions.total}
              onChange={setOffset}
            />
            {detail && (
              <>
                <CollectionDetails detail={detail} />
                <details>
                  <summary>Search evidence</summary>
                  <dl className="evidence">
                    {Object.entries(detail.decision.evidence).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key.replaceAll('_', ' ')}</dt>
                          <dd>
                            {Array.isArray(value) ? value.join(', ') : value}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                  <p className="hint">{detail.scope}</p>
                </details>
              </>
            )}
          </section>
          <section>
            <h2>Spacecraft instructions</h2>
            <Choice
              label="Spacecraft timeline"
              value={spacecraft}
              onChange={(v) => {
                setSpacecraft(v);
                setTimelineOffset(0);
              }}
              items={plan.satellites.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
            />
            {timeline && (
              <>
                <p className="hint">
                  Final charge: {timeline.remaining_battery_wh.toFixed(1)} Wh ·
                  Data stored: {number(timeline.storage_used_mb)} MB
                </p>
                <div className="decision-list">
                  {timeline.items.map((i) => (
                    <button key={i.id} onClick={() => seek(i.start)}>
                      <span>
                        <strong>Request {i.request_id}</strong>
                        <small>
                          {elapsed(i.start)}–{elapsed(i.end)} · {i.energy_wh} Wh
                        </small>
                      </span>
                      <span>Seek ↗</span>
                    </button>
                  ))}
                </div>
                <Pager
                  offset={timelineOffset}
                  total={timeline.total}
                  onChange={setTimelineOffset}
                />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
