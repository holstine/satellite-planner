import type { Playback } from '../orbit-api';
import type { VisualScene } from './contracts';

/** Application boundary: converts REST artifacts to the public viewer contract. */
export function sceneFromPlan(
  playback: Playback | null,
  catalog: Float64Array | null,
): VisualScene {
  if (!playback) {
    if (catalog && catalog.length % 5 !== 0)
      throw new Error('Invalid catalog point buffer');
    const targets = new Float64Array(((catalog?.length ?? 0) / 5) * 6);
    if (catalog)
      for (
        let source = 0, dest = 0;
        source < catalog.length;
        source += 5, dest += 6
      ) {
        targets.set(catalog.subarray(source, source + 4), dest);
        targets[dest + 4] = 1;
      }
    return { planId: null, targets, spacecraft: [], timeline: null };
  }
  const { run, targets, positions } = playback;
  if (run.target_stride !== 6 || targets.length % 6 !== 0)
    throw new Error('Unsupported plan target buffer');
  return {
    planId: run.id,
    targets,
    spacecraft: run.satellites.map((s) => ({
      id: s.id,
      name: s.name,
      maxOffNadirDeg: Math.min(
        s.max_off_nadir_deg,
        run.scenario.constraints.max_off_nadir_deg,
      ),
    })),
    timeline: {
      startUnixMs: Date.parse(run.scenario.start),
      durationSeconds: run.scenario.duration_seconds,
      sampleStepSeconds: run.sample_step,
      sampleCount: run.sample_count,
      positions,
      instructions: run.instructions.map((i) => ({
        id: i.id,
        requestId: i.request_id,
        spacecraftIndex: i.satellite_index,
        start: i.start,
        end: i.end,
      })),
    },
  };
}
