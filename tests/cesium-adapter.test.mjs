import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { attachCesiumViewer } from '../lib/visualization/cesium/adapter.ts';

// Exercise real Cesium primitives/geometry without creating a WebGL context.
// These DOM classes are used only for Material's instanceof checks.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
])
  globalThis[name] ??= class {};

function host() {
  const handlers = [];
  class ScreenSpaceEventHandler {
    actions = new Map();
    destroyed = false;
    constructor() {
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const canvas = new EventTarget();
  const primitives = new Cesium.PrimitiveCollection();
  const foreignLayer = primitives.add(new Cesium.PointPrimitiveCollection());
  const clock = {
    currentTime: Cesium.JulianDate.fromIso8601('2000-01-01T00:00:00Z'),
  };
  const initialTime = clock.currentTime;
  let picked;
  let homeCalls = 0;
  const viewer = {
    canvas,
    clock,
    camera: {
      flyTo: () => {
        homeCalls++;
      },
    },
    scene: {
      primitives,
      postRender: new Cesium.Event(),
      requestRender() {},
      pick: () => picked,
    },
    isDestroyed: () => false,
    destroy: () => {
      throw new Error('Must not destroy an externally owned viewer');
    },
  };
  const events = { selected: [], hovers: [], rendered: 0 };
  const callbacks = {
    onSelect: (index) => events.selected.push(index),
    onHover: (pick) => events.hovers.push(pick),
    onRender: () => {
      events.rendered++;
    },
  };
  const adapter = attachCesiumViewer(
    { ...Cesium, ScreenSpaceEventHandler },
    viewer,
    callbacks,
  );
  return {
    adapter,
    events,
    callbacks,
    viewer,
    handlers,
    foreignLayer,
    initialTime,
    pick: (value) => {
      picked = value;
    },
    homeCalls: () => homeCalls,
  };
}
const options = {
  targets: true,
  lines: true,
  cone: true,
  horizon: true,
  feasibleOnly: false,
};
function renderPlan(adapter) {
  const scene = {
    planId: 'saved',
    targets: new Float64Array([42, 6378137, 0, 0, 1, 1]),
    spacecraft: [{ id: 'sat', name: 'Sat', maxOffNadirDeg: 45 }],
    timeline: {
      startUnixMs: 0,
      durationSeconds: 10,
      sampleStepSeconds: 10,
      sampleCount: 2,
      positions: new Float64Array([7000000, 0, 0, 7000000, 0, 0]),
      instructions: [],
    },
  };
  adapter.setScene(scene);
  const frame = {
    seconds: 0,
    unixMs: 0,
    spacecraftPositions: new Float64Array([7000000, 0, 0]),
    active: [{ id: 'i', requestId: 42, spacecraftIndex: 0, start: 0, end: 10 }],
  };
  adapter.render(frame, { options, playing: false, selected: 0, speed: 1 });
  return frame;
}

test('attachment renders solid cones and removes only its own layers/listeners', () => {
  const h = host();
  renderPlan(h.adapter);
  assert.equal(h.viewer.scene.primitives.length, 2);
  assert.equal(h.homeCalls(), 0, 'mounting does not move the host camera');
  assert.equal(
    h.viewer.clock.currentTime,
    h.initialTime,
    'playback leaves the host clock alone',
  );
  const owned = h.viewer.scene.primitives.get(1);
  const cone = owned.get(4);
  assert.equal(cone.appearance.closed, true);
  assert.equal(
    cone.geometryInstances.geometry.primitiveType,
    Cesium.PrimitiveType.TRIANGLES,
  );
  assert.ok(cone.geometryInstances.geometry.indices.length > 0);
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.events.rendered, 1);
  h.adapter.destroy();
  h.adapter.destroy();
  assert.equal(h.viewer.scene.primitives.length, 1);
  assert.equal(h.viewer.scene.primitives.get(0), h.foreignLayer);
  assert.equal(h.foreignLayer.isDestroyed(), false);
  assert.equal(h.handlers[0].destroyed, true);
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
  h.viewer.scene.primitives.destroy();
});

test('picking ignores foreign layers, emits neutral IDs, and clears obsolete collection lines', async () => {
  const h = host();
  const frame = renderPlan(h.adapter);
  const owned = h.viewer.scene.primitives.get(1);
  const actions = h.handlers[0].actions;
  h.pick({ id: { satellite: 9, request: 90 } });
  actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
    position: new Cesium.Cartesian2(),
  });
  assert.deepEqual(h.events.selected, []);
  h.pick({ id: owned.get(1).get(0).id });
  actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
    position: new Cesium.Cartesian2(),
  });
  assert.deepEqual(h.events.selected, [0]);
  h.pick({ id: owned.get(0).get(0).id });
  actions.get(Cesium.ScreenSpaceEventType.MOUSE_MOVE)({
    endPosition: new Cesium.Cartesian2(20, 30),
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.deepEqual(h.events.hovers.at(-1), { requestId: 42, x: 20, y: 30 });
  assert.equal(owned.get(2).get(0).show, true);
  h.adapter.render(
    { ...frame, active: [] },
    { options, playing: false, selected: 0, speed: 1 },
  );
  assert.equal(owned.get(2).get(0).show, false);
  h.adapter.setScene({
    planId: null,
    targets: new Float64Array(),
    spacecraft: [],
    timeline: null,
  });
  assert.equal(owned.length, 4, 'old cone is removed when the plan is cleared');
  assert.equal(owned.get(1).length, 0);
  assert.equal(h.events.hovers.at(-1), null);
  h.adapter.destroy();
  h.viewer.scene.primitives.destroy();
});
