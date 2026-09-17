'use client';
import { useEffect, useState } from 'react';
import {
  api,
  type Scenario,
  type Run,
  type Job,
  type WeatherData,
} from '@/lib/orbit-api';
import { weatherLayers } from '@/lib/weather-layers';
import type { VisualizationLayer } from '@/lib/visualization/contracts';
import { Numeric, Choice, type Act } from './controls';
import LayerPanel from './layer-panel';

export default function WeatherPanel({
  scenario,
  plan,
  job,
  setJob,
  working,
  act,
  layers,
  onLayers,
}: {
  scenario: Scenario;
  plan: Run | null;
  job: Job | null;
  setJob: (job: Job) => void;
  working: boolean;
  act: Act;
  layers: VisualizationLayer[];
  onLayers: (layers: VisualizationLayer[]) => void;
}) {
  const [data, setData] = useState<WeatherData | null>(null);
  const [source, setSource] = useState(''),
    [maxLocations, setMaxLocations] = useState(500);
  const [usePlan, setUsePlan] = useState(!!plan);
  const contextPlan = usePlan ? plan : null;
  const start = contextPlan?.scenario.start ?? scenario.start;
  // Inspect saved evidence on plan change; loading overlays is an explicit action.
  useEffect(() => {
    let cancelled = false;
    if (contextPlan)
      void api<WeatherData>(`/plans/${contextPlan.id}/weather`)
        .then((value) => {
          if (!cancelled) {
            setData(value);
            setSource('Saved plan weather');
          }
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contextPlan]);
  const cells = Object.values(data?.cells ?? {});
  return (
    <section>
      <span className="eyebrow">WEATHER</span>
      <h2>Plan around real forecasts</h2>
      {plan && (
        <Choice
          label="Weather timeframe and locations"
          value={usePlan ? 'plan' : 'catalog'}
          items={[
            { value: 'plan', label: 'Selected saved plan' },
            {
              value: 'catalog',
              label: 'Current catalog and Schedule timeframe',
            },
          ]}
          onChange={(value) => {
            setUsePlan(value === 'plan');
            setData(null);
            setSource('');
            onLayers(
              layers.filter((layer) => !layer.id.startsWith('weather:')),
            );
          }}
        />
      )}
      <p className="hint">
        {contextPlan
          ? 'Locations and timeframe from the selected plan.'
          : 'Locations from the request catalog and timeframe from Schedule.'}{' '}
        Hourly model weather in 0.25° cells; not live observations.
      </p>
      <p className="hint">
        {start} ·{' '}
        {(
          (contextPlan?.scenario.duration_seconds ??
            scenario.duration_seconds) / 60
        ).toFixed(0)}{' '}
        minutes
      </p>
      <Numeric
        label="Maximum new locations per refresh"
        value={maxLocations}
        min={1}
        max={10000}
        onChange={setMaxLocations}
      />
      <button
        className="primary full"
        disabled={working}
        onClick={() =>
          void act(async () => {
            setJob(
              await api<Job>(
                '/weather/refresh',
                {
                  scenario,
                  plan_id: contextPlan?.id ?? null,
                  max_locations: maxLocations,
                },
                'POST',
              ),
            );
          })
        }
      >
        Refresh forecast cache
      </button>
      <p className="hint">
        Downloads run separately from scheduling. Existing fresh locations are
        reused for one hour; large downloads respect provider rate limits.
      </p>
      {job?.kind === 'weather' && job.status === 'completed' && (
        <p className="hint">
          Fetched {job.result?.fetched} locations. {job.result?.remaining}{' '}
          remaining.
        </p>
      )}
      <div className="inline-controls">
        <button
          className="quiet"
          onClick={() =>
            void act(async () => {
              const value = await api<WeatherData>(
                '/weather/cache',
                { scenario, plan_id: contextPlan?.id ?? null },
                'POST',
              );
              setData(value);
              setSource('Latest fresh cache');
              onLayers([
                ...layers.filter((l) => !l.id.startsWith('weather:')),
                ...weatherLayers(value, start, !!contextPlan),
              ]);
            })
          }
        >
          Show latest cached weather
        </button>
        {contextPlan && (
          <button
            className="quiet"
            onClick={() =>
              void act(async () => {
                const value = await api<WeatherData>(
                  `/plans/${contextPlan.id}/weather`,
                );
                setData(value);
                setSource('Saved plan weather');
                onLayers([
                  ...layers.filter((l) => !l.id.startsWith('weather:')),
                  ...weatherLayers(value, start, !!contextPlan),
                ]);
              })
            }
          >
            Show plan weather
          </button>
        )}
      </div>
      <p className="hint">
        {source || 'No weather loaded'} · {cells.length} cells. Missing or stale
        weather never satisfies a request weather requirement.
      </p>
      {cells.length > 0 && (
        <p className="hint">
          Fetched{' '}
          {new Date(
            Math.min(...cells.map((c) => c.fetched_at)) * 1000,
          ).toISOString()}
          . Hover a colored cell for its value and time. Layers follow plan
          playback; stronger color indicates higher values.
        </p>
      )}
      <a
        className="text-link"
        href="https://open-meteo.com/"
        target="_blank"
        rel="noreferrer"
      >
        Weather data: Open-Meteo · CC BY 4.0
      </a>
      <LayerPanel layers={layers} onChange={onLayers} />
    </section>
  );
}
