import type { Run } from './orbit-api';

export function planNeedsRebuild(plan: Run): boolean {
  return (
    !plan.validation?.passed ||
    typeof plan.scenario.constraints.optical_daylight_only !== 'boolean' ||
    typeof plan.scenario.constraints.affected_by_weather !== 'boolean'
  );
}

export function planLabel(plan: Pick<Run, 'scenario' | 'created'>): string {
  const stamp = plan.created ? new Date(plan.created) : null;
  const time =
    stamp && Number.isFinite(stamp.getTime())
      ? stamp.toISOString().replace('T', ' ').replace('Z', ' UTC')
      : 'Creation time unavailable';
  return `${plan.scenario.name} · ${time}`;
}
