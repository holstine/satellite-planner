import type { Observation } from './orbit-api';

/** Coarse interval index: no per-second expansion and no full-plan frame scan. */
export function indexInstructions(
  instructions: Observation[],
  bucketSeconds = 30,
) {
  const buckets = new Map<number, Observation[]>();
  for (const instruction of instructions) {
    for (
      let bucket = Math.floor(instruction.start / bucketSeconds);
      bucket <= Math.floor((instruction.end - 1) / bucketSeconds);
      bucket++
    ) {
      const list = buckets.get(bucket) ?? [];
      list.push(instruction);
      buckets.set(bucket, list);
    }
  }
  return {
    at(seconds: number) {
      return (buckets.get(Math.floor(seconds / bucketSeconds)) ?? []).filter(
        (i) => i.start <= seconds && seconds < i.end,
      );
    },
    buckets,
  };
}

export function sampleInterval(
  seconds: number,
  step: number,
  count: number,
  endSeconds = (count - 1) * step,
) {
  const index = Math.max(0, Math.min(Math.floor(seconds / step), count - 2));
  const span = Math.min(step, endSeconds - index * step);
  return {
    index,
    alpha: Math.max(0, Math.min(1, (seconds - index * step) / span)),
  };
}
