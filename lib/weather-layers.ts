import type { WeatherData } from './orbit-api';
import type { VisualizationLayer } from './visualization/contracts';

export function weatherLayers(
  data: WeatherData,
  start: string,
  followPlayback = true,
): VisualizationLayer[] {
  return (
    [
      ['cloud_cover_pct', 'Cloud cover', '%', '#e9f2ff', 100],
      [
        'precipitation_mm',
        'Precipitation · preceding hour',
        'mm',
        '#379cff',
        10,
      ],
      ['wind_speed_mps', 'Wind at 10 m', 'm/s', '#ffa64f', 25],
    ] as const
  ).map(([field, label, unit, color, maximum], i) => ({
    id: `weather:${field}`,
    label,
    kind: 'scalar-grid',
    visible: i === 0,
    opacity: 0.65,
    attribution:
      data.attribution ?? 'Open-Meteo.com (CC BY 4.0) · hourly model weather',
    color,
    unit,
    maximum,
    defaultTimeUnixMs: Date.parse(start),
    followPlayback,
    cells: Object.values(data.cells).map((cell) => ({
      latitude: cell.latitude,
      longitude: cell.longitude,
      sizeDegrees: cell.grid_degrees,
      times: cell.times.map((v) => v * 1000),
      values: cell[field],
    })),
  }));
}
