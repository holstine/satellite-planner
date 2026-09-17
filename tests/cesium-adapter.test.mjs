import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { attachCesiumViewer } from '../lib/visualization/cesium/adapter.ts';
import { createLayers } from '../lib/visualization/cesium/layers.ts';
import { createBasemap } from '../lib/visualization/cesium/basemap.ts';
import { basemaps, resolveBasemap } from '../lib/basemaps.ts';

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

test('basemap switches preserve overlays and ignore late asynchronous loads', async () => {
  const items = [{ id: 'host-overlay' }];
  const viewer = {
    isDestroyed: () => false,
    scene: { requestRender() {} },
    imageryLayers: {
      addImageryProvider(provider, index) {
        const item = { provider };
        items.splice(index, 0, item);
        return item;
      },
      remove(item) {
        items.splice(items.indexOf(item), 1);
      },
    },
  };
  let finishOffline;
  const c = {
    ...Cesium,
    TileMapServiceImageryProvider: {
      fromUrl: () =>
        new Promise((resolve) => {
          finishOffline = resolve;
        }),
    },
    UrlTemplateImageryProvider: class {
      constructor(options) {
        this.options = options;
        this.errorEvent = new Cesium.Event();
      }
    },
  };
  const manager = createBasemap(c, viewer);
  manager.update(resolveBasemap('natural-earth'));
  manager.update(resolveBasemap('esri-imagery'));
  await Promise.resolve();
  const imagery = items[0];
  assert.ok(imagery.provider.options.url.includes('World_Imagery'));
  finishOffline({ errorEvent: new Cesium.Event() });
  await Promise.resolve();
  assert.equal(items[0], imagery);
  manager.update(resolveBasemap('osm'));
  await Promise.resolve();
  assert.ok(items[0].provider.options.url.includes('openstreetmap'));
  assert.equal(items.length, 2);
  manager.destroy();
  assert.deepEqual(items, [{ id: 'host-overlay' }]);
  assert.equal(resolveBasemap('removed-map').id, 'natural-earth');
  assert.ok(
    basemaps.every(
      (map) => !map.keyParameter && !/[?&](key|token)=/.test(map.url ?? ''),
    ),
  );
});

test('weather layers follow time, skip missing data, reuse geometry and preserve foreign layers', () => {
  const h = host();
  const manager = createLayers(Cesium, h.viewer, {});
  const spec = {
    id: 'weather',
    kind: 'scalar-grid',
    label: 'Cloud cover',
    visible: true,
    opacity: 0.5,
    attribution: 'Test provider',
    unit: '%',
    maximum: 100,
    color: '#ffffff',
    defaultTimeUnixMs: 0,
    cells: [
      {
        latitude: 0.125,
        longitude: 0.125,
        sizeDegrees: 0.25,
        times: [0, 3600000, 7200000],
        values: [20, 80, null],
      },
    ],
  };
  const layers = [spec];
  manager.update(layers, 0);
  const first = h.viewer.scene.primitives.get(2);
  assert.equal(first.geometryInstances[0].id.layer.value, 20);
  manager.update(layers, 15000);
  assert.equal(
    h.viewer.scene.primitives.get(2),
    first,
    'no mesh rebuild within the hour',
  );
  manager.update(layers, 3600000);
  assert.equal(first.isDestroyed(), true);
  assert.equal(
    h.viewer.scene.primitives.get(2).geometryInstances[0].id.layer.value,
    80,
  );
  manager.update(layers, 7200000);
  assert.equal(
    h.viewer.scene.primitives.length,
    2,
    'missing weather has no fabricated tile',
  );
  manager.update([{ ...spec, followPlayback: false }], 7200000);
  assert.equal(
    h.viewer.scene.primitives.get(2).geometryInstances[0].id.layer.value,
    20,
    'catalog forecast can use its own timeframe',
  );
  manager.destroy();
  assert.equal(h.viewer.scene.primitives.get(0), h.foreignLayer);
  assert.equal(h.foreignLayer.isDestroyed(), false);
  h.adapter.destroy();
  h.viewer.scene.primitives.destroy();
});

test('imagery layer updates and removal preserve host imagery', () => {
  const items = [{ id: 'foreign' }];
  const viewer = {
    isDestroyed: () => false,
    scene: { primitives: new Cesium.PrimitiveCollection() },
    imageryLayers: {
      addImageryProvider(provider) {
        const item = { provider, show: true, alpha: 1 };
        items.push(item);
        return item;
      },
      remove(item) {
        items.splice(items.indexOf(item), 1);
      },
      raiseToTop(item) {
        items.splice(items.indexOf(item), 1);
        items.push(item);
      },
    },
  };
  const manager = createLayers(
    {
      ...Cesium,
      UrlTemplateImageryProvider: class {
        constructor(options) {
          this.options = options;
        }
      },
    },
    viewer,
    {},
  );
  const layer = {
    id: 'tiles',
    kind: 'xyz-imagery',
    label: 'Tiles',
    visible: true,
    opacity: 0.6,
    attribution: 'Provider',
    url: 'https://example.invalid/{z}/{x}/{y}.png',
  };
  manager.update([layer], null);
  const overlay = items[1];
  manager.update([{ ...layer, visible: false, opacity: 0.2 }], null);
  assert.equal(items[1], overlay);
  assert.equal(overlay.show, false);
  assert.equal(overlay.alpha, 0.2);
  manager.destroy();
  assert.deepEqual(items, [{ id: 'foreign' }]);
  viewer.scene.primitives.destroy();
});
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

test('collection line pool recolors reused lines by sensor, including unknown sensors', () => {
  const h = host();
  const frame = renderPlan(h.adapter);
  const lines = h.viewer.scene.primitives.get(1).get(2);
  const pooled = lines.get(0);
  for (const [sensor, hex] of [
    ['optical', '#6ef2cc'],
    ['infrared', '#ff9854'],
    ['radar', '#c49aff'],
    ['future-sensor', '#d4dde5'],
    [undefined, '#d4dde5'],
    ['optical', '#6ef2cc'],
  ]) {
    h.adapter.render(
      { ...frame, active: [{ ...frame.active[0], sensor }] },
      { options, playing: false, selected: 0, speed: 1 },
    );
    assert.equal(lines.length, 1);
    assert.equal(lines.get(0), pooled);
    assert.ok(
      Cesium.Color.equals(
        pooled.material.uniforms.color,
        Cesium.Color.fromCssColorString(hex).withAlpha(0.9),
      ),
    );
  }
  h.adapter.destroy();
  h.viewer.scene.primitives.destroy();
});

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
