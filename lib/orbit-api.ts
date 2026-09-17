export type Constraints = {
  optical_daylight_only: boolean;
  affected_by_weather: boolean;
  max_cloud_cover_pct: number;
  daylight_only: boolean;
  min_sun_elevation_deg: number;
  min_elevation_deg: number;
  max_off_nadir_deg: number;
  capacity_per_satellite: number;
  cooldown_seconds: number;
  step_seconds: number;
  validation_seconds: number;
  ephemeris_step_seconds: number;
};
export type CollectionRequest = {
  name: string;
  latitude: number;
  longitude: number;
  priority: number;
  enabled: boolean;
  duration_seconds: number;
  energy_wh: number;
  data_mb: number;
  satellites_required: number;
  collections_required: number;
  revisit_seconds: number;
  window_start_seconds: number;
  window_end_seconds: number | null;
  min_elevation_deg: number;
  min_off_nadir_deg: number;
  max_off_nadir_deg: number;
  daylight_only: boolean;
  min_sun_elevation_deg: number;
  sensor: 'optical' | 'infrared' | 'radar';
  max_cloud_cover_pct?: number | null;
  max_precipitation_mm?: number | null;
  max_wind_speed_mps?: number | null;
};
export type Target = CollectionRequest & { id: number };
export type Satellite = {
  id: string;
  name: string;
  kind: 'demo' | 'tle' | 'sampled';
  enabled: boolean;
  epoch: number;
  altitude_km: number;
  inclination_deg: number;
  raan: number;
  phase: number;
  argument_of_perigee: number;
  eccentricity: number;
  orbit_class: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'custom';
  line1: string | null;
  line2: string | null;
  samples: { time: string; x: number; y: number; z: number }[];
  battery_capacity_wh: number;
  initial_battery_wh: number;
  battery_reserve_wh: number;
  storage_capacity_mb: number;
  initial_storage_mb: number;
  capacity: number;
  max_off_nadir_deg: number;
  sensors: ('optical' | 'infrared' | 'radar')[];
};
export type Observation = {
  id: string;
  sensor: string;
  collection_id: string;
  request_id: number;
  spacecraft_id: string;
  satellite_index: number;
  start: number;
  end: number;
  priority: number;
  energy_wh: number;
  data_mb: number;
  battery_before_wh: number;
  battery_after_wh: number;
  storage_after_mb: number;
};
export type Scenario = {
  name: string;
  start: string;
  duration_seconds: number;
  constraints: Constraints;
  scheduler: string;
  ephemeris_provider: string;
};
export type Run = {
  id: string;
  created?: string;
  scenario: Scenario;
  satellites: Satellite[];
  instructions: Observation[];
  sample_step: number;
  sample_count: number;
  target_stride: number;
  counts: Record<string, number>;
  elapsed_seconds: number;
  accuracy: string;
  validation: { passed: boolean; geometry_samples: number };
  reasons?: Record<string, number>;
  parent_plan_id?: string | null;
  changes?: {
    added_collections: string[];
    removed_collections: string[];
    rearranged_collections: string[];
    retained_collections: number;
    count_delta: Record<string, number>;
  };
  weather_summary?: {
    required_requests: number;
    cached_cells: number;
    attribution: string;
  };
};
export type Playback = {
  run: Run;
  positions: Float64Array;
  targets: Float64Array;
};
export type Decision = {
  request_id: number;
  name: string;
  status: 'planned' | 'partial' | 'unplanned' | 'disabled';
  reason_code: string;
  explanation: string;
  collections_requested: number;
  collections_planned: number;
  evidence: Record<string, number | string | string[]>;
};
export type Explanation = {
  request: Target;
  decision: Decision;
  collections: Observation[];
  scope: string;
};
export type Page<T> = { items: T[]; total: number };
export type Job = {
  id: string;
  kind: string;
  status: string;
  created?: string;
  message?: string;
  progress?: number;
  error?: string;
  result?: {
    plan_id?: string;
    accepted?: number;
    generated?: number;
    attempted?: number;
    complete?: boolean;
    note?: string;
    elapsed_seconds?: number;
    validation?: { passed: boolean };
    comparison?: Run['changes'];
    fetched?: number;
    remaining?: number;
  };
};
export type Database = {
  adapter: string;
  schema_version: number;
  counts: Record<string, number>;
  size_bytes: number;
  legacy_note: string | null;
};
export type WeatherData = {
  captured_at: number;
  attribution?: string;
  cells: Record<
    string,
    {
      latitude: number;
      longitude: number;
      grid_degrees: number;
      fetched_at: number;
      expires_at: number;
      times: number[];
      cloud_cover_pct: (number | null)[];
      precipitation_mm: (number | null)[];
      wind_speed_mps: (number | null)[];
    }
  >;
};
export const defaults: Constraints = {
  optical_daylight_only: true,
  affected_by_weather: false,
  max_cloud_cover_pct: 50,
  daylight_only: false,
  min_sun_elevation_deg: 0,
  min_elevation_deg: 0,
  max_off_nadir_deg: 85,
  capacity_per_satellite: 1,
  cooldown_seconds: 10,
  step_seconds: 30,
  validation_seconds: 5,
  ephemeris_step_seconds: 10,
};
export const requestDefaults: CollectionRequest = {
  name: '',
  latitude: 0,
  longitude: 0,
  priority: 50,
  enabled: true,
  duration_seconds: 30,
  energy_wh: 5,
  data_mb: 50,
  satellites_required: 1,
  collections_required: 1,
  revisit_seconds: 60,
  window_start_seconds: 0,
  window_end_seconds: null,
  min_elevation_deg: 10,
  min_off_nadir_deg: 0,
  max_off_nadir_deg: 45,
  daylight_only: true,
  min_sun_elevation_deg: 0,
  sensor: 'optical',
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
      const err = await response.json();
      message =
        typeof err.detail === 'string'
          ? err.detail
          : JSON.stringify(err.detail);
    } catch {
      /* Keep HTTP error. */
    }
    throw new Error(message);
  }
  return response.json();
}
export async function binary(path: string) {
  const response = await fetch('/api' + path);
  if (!response.ok)
    throw new Error(`Could not load globe data (${response.status})`);
  return new Float64Array(await response.arrayBuffer());
}
export const number = (value: number = 0) => value.toLocaleString();
export const elapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
