import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackController } from '../lib/visualization/playback.ts';
import { sceneFromPlan } from '../lib/visualization/from-plan.ts';

const state = {
  playing: false,
  speed: 1,
  selected: 0,
  options: {
    targets: true,
    lines: true,
    cone: true,
    horizon: true,
    feasibleOnly: false,
  },
};
function fixture() {
  return {
    planId: 'plan-a',
    targets: new Float64Array([1, 6378137, 0, 0, 1, 1]),
    spacecraft: [{ id: 'sat-a', name: 'Satellite A', maxOffNadirDeg: 45 }],
    timeline: {
      startUnixMs: Date.parse('2026-09-11T12:00:00Z'),
      durationSeconds: 25,
      sampleStepSeconds: 10,
      sampleCount: 4,
      positions: new Float64Array([
        0, 0, 0, 10, 20, 30, 20, 40, 60, 25, 50, 75,
      ]),
      instructions: [
        { id: 'collect', requestId: 1, spacecraftIndex: 0, start: 5, end: 15 },
      ],
    },
  };
}
function fakeViewer() {
  const calls = { scenes: [], frames: [], destroyed: 0, home: 0 };
  const adapter = {
    setScene: (scene) => calls.scenes.push(scene),
    render: (frame) =>
      calls.frames.push({
        ...frame,
        spacecraftPositions: [...frame.spacecraftPositions],
      }),
    home: () => {
      calls.home++;
    },
    destroy: () => {
      calls.destroyed++;
    },
  };
  return { calls, adapter };
}

test('a viewer without Cesium receives interpolated plan frames, seeks and collections', () => {
  const { calls, adapter } = fakeViewer();
  const controller = createPlaybackController(adapter);
  const scene = fixture();
  controller.setScene(scene);
  controller.seek(12.5);
  let frame = controller.tick(0, state);
  const scratch = frame.spacecraftPositions;
  assert.deepEqual([...scratch], [12.5, 25, 37.5]);
  assert.equal(frame.active[0].id, 'collect');
  assert.equal(frame.unixMs, scene.timeline.startUnixMs + 12500);
  controller.seek(22.5);
  frame = controller.tick(0, state);
  assert.equal(
    frame.spacecraftPositions,
    scratch,
    'reuse the per-frame position buffer',
  );
  assert.deepEqual([...frame.spacecraftPositions], [22.5, 45, 67.5]);
  assert.equal(frame.active.length, 0);
  controller.seek(999);
  assert.equal(controller.tick(0, state).seconds, 25);
  controller.seek(-10);
  assert.equal(controller.tick(0, state).seconds, 0);
  controller.seek(5);
  assert.equal(
    controller.tick(0, state).active.length,
    1,
    'reverse seek restores active collection',
  );
  controller.seek(15);
  assert.equal(
    controller.tick(0, state).active.length,
    0,
    'collection end is exclusive',
  );
  const renders = calls.frames.length;
  controller.tick(10, state);
  assert.equal(
    calls.frames.length,
    renders,
    'paused unchanged data does not rebuild a frame',
  );
  controller.invalidate();
  controller.tick(0, state);
  assert.equal(calls.frames.length, renders + 1);
  controller.home();
  controller.destroy();
  controller.destroy();
  assert.equal(calls.home, 1);
  assert.equal(calls.destroyed, 1);
});

test('playback clamps elapsed time, stops at the endpoint, and clears stale plan state', () => {
  const { adapter } = fakeViewer();
  const controller = createPlaybackController(adapter);
  controller.setScene(fixture());
  assert.equal(
    controller.tick(10, { ...state, playing: true, speed: 60 }).seconds,
    15,
  );
  assert.equal(
    controller.tick(1, { ...state, playing: true, speed: 60 }).seconds,
    25,
  );
  controller.setScene(sceneFromPlan(null, null));
  const frame = controller.tick(0, state);
  assert.equal(frame.seconds, 0);
  assert.equal(frame.unixMs, null);
  assert.equal(frame.active.length, 0);
  assert.equal(frame.spacecraftPositions.length, 0);
  const broken = fixture();
  broken.timeline.positions = new Float64Array(3);
  assert.throws(() => controller.setScene(broken), /ephemeris/);
});

test('REST projection preserves shared buffers and removes scheduler details from rendering', () => {
  const catalog = new Float64Array([7, 1, 2, 3, 1, 8, 4, 5, 6, 0]);
  assert.deepEqual(
    [...sceneFromPlan(null, catalog).targets],
    [7, 1, 2, 3, 1, 0, 8, 4, 5, 6, 1, 0],
  );
  const positions = new Float64Array(12),
    targets = new Float64Array(6);
  const scene = sceneFromPlan(
    {
      positions,
      targets,
      run: {
        id: 'saved-plan',
        target_stride: 6,
        sample_count: 4,
        sample_step: 10,
        scenario: {
          start: '2026-09-11T12:00:00Z',
          duration_seconds: 25,
          constraints: { max_off_nadir_deg: 30 },
        },
        satellites: [
          {
            id: 's',
            name: 'S',
            max_off_nadir_deg: 45,
            battery_capacity_wh: 400,
          },
        ],
        instructions: [
          {
            id: 'i',
            request_id: 7,
            satellite_index: 0,
            start: 0,
            end: 10,
            energy_wh: 5,
            sensor: 'infrared',
          },
        ],
      },
    },
    catalog,
  );
  assert.equal(scene.targets, targets);
  assert.equal(scene.timeline.positions, positions);
  assert.equal(scene.spacecraft[0].maxOffNadirDeg, 30);
  assert.equal('battery_capacity_wh' in scene.spacecraft[0], false);
  assert.equal('energy_wh' in scene.timeline.instructions[0], false);
  assert.equal(scene.timeline.instructions[0].sensor, 'infrared');
});
