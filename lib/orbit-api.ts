export type Constraints = {
  daylight_only: boolean;
  min_sun_elevation_deg: number;
  min_elevation_deg: number;
  max_off_nadir_deg: number;
  capacity_per_satellite: number;
  observe_target_once: boolean;
  dwell_seconds: number;
  cooldown_seconds: number;
  step_seconds: number;
  validation_seconds: number;
};
export type Target = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  priority: number;
  enabled: boolean;
};
export type Satellite = {
  id: string;
  name: string;
  kind: 'demo' | 'tle';
  epoch: number;
};
export type Observation = {
  satellite_index: number;
  target_id: number;
  start: number;
  end: number;
  priority: number;
};
export type Run = {
  id: string;
  scenario: {
    start: string;
    duration_seconds: number;
    constraints: Constraints;
  };
  satellites: Satellite[];
  events: Observation[];
  sample_step: number;
  sample_count: number;
  target_stride: number;
  counts: {
    targets: number;
    feasible: number;
    scheduled: number;
    inaccessible: number;
    unassigned: number;
    observations: number;
    candidates: number;
  };
  elapsed_seconds: number;
  accuracy: string;
};
export type Playback = {
  run: Run;
  positions: Float64Array;
  targets: Float64Array;
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  created: string;
  message?: string;
  progress?: number;
  error?: string;
  result?:
    | Run
    | {
        accepted: number;
        attempted: number;
        rejected: number;
        complete: boolean;
        note: string;
      };
};
export const defaults: Constraints = {
  daylight_only: true,
  min_sun_elevation_deg: 0,
  min_elevation_deg: 10,
  max_off_nadir_deg: 45,
  capacity_per_satellite: 1,
  observe_target_once: true,
  dwell_seconds: 30,
  cooldown_seconds: 10,
  step_seconds: 30,
  validation_seconds: 5,
};
export async function api<T>(
  path: string,
  body?: unknown,
  method = 'GET',
): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const err = (await response.json()) as { detail: unknown };
      message =
        typeof err.detail === 'string'
          ? err.detail
          : JSON.stringify(err.detail);
    } catch {}
    throw new Error(message);
  }
  return response.json();
}
export async function binary(path: string) {
  const r = await fetch('/api' + path);
  if (!r.ok) throw new Error(`Could not load globe data (${r.status})`);
  return new Float64Array(await r.arrayBuffer());
}
