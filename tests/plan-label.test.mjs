import assert from 'node:assert/strict';
import test from 'node:test';
import { planLabel } from '../lib/plan-label.ts';

test('plan choices identify creation time in UTC without exposing internal IDs', () => {
  assert.equal(
    planLabel({
      scenario: { name: 'Observation plan (2)' },
      created: '2026-09-16T15:31:02.123-06:00',
      id: 'badc0ffee',
    }),
    'Observation plan (2) · 2026-09-16 21:31:02.123 UTC',
  );
  assert.equal(
    planLabel({ scenario: { name: 'Old plan' }, id: 'badc0ffee' }),
    'Old plan · Creation time unavailable',
  );
});
