import assert from 'node:assert/strict';
import test from 'node:test';
import { indexInstructions, sampleInterval } from '../lib/plan-playback.ts';

test('interval lookup agrees with brute force across starts, ends, and reverse seeks', () => {
  const instructions = Array.from({ length: 10000 }, (_, i) => ({
    id: String(i),
    start: (i * 37) % 3600,
    end: ((i * 37) % 3600) + 5 + (i % 120),
  }));
  const index = indexInstructions(instructions);
  for (const seconds of [0, 1, 29.9, 30, 31, 599, 3000, 3600, 60, 15, 0]) {
    assert.deepEqual(
      index.at(seconds),
      instructions.filter((i) => i.start <= seconds && seconds < i.end),
    );
  }
  const references = [...index.buckets.values()].reduce(
    (n, rows) => n + rows.length,
    0,
  );
  assert.ok(
    references < 40000,
    'index must not expand every collection into per-second references',
  );
});

test('playback interpolation clamps at both ends', () => {
  assert.deepEqual(sampleInterval(15, 10, 7), { index: 1, alpha: 0.5 });
  assert.deepEqual(sampleInterval(65, 10, 7), { index: 5, alpha: 1 });
  assert.deepEqual(sampleInterval(-1, 10, 7), { index: 0, alpha: 0 });
  assert.deepEqual(sampleInterval(62.5, 10, 8, 65), { index: 6, alpha: 0.5 });
  assert.deepEqual(sampleInterval(65, 10, 8, 65), { index: 6, alpha: 1 });
});
