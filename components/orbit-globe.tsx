'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import type { Playback } from '@/lib/orbit-api';

type CAPI = typeof Cesium;
declare global {
  interface Window {
    Cesium: CAPI;
    CESIUM_BASE_URL: string;
  }
}
export type GlobeOptions = {
  targets: boolean;
  lines: boolean;
  cone: boolean;
  horizon: boolean;
  feasibleOnly: boolean;
};
export type GlobeHandle = { seek: (seconds: number) => void; home: () => void };
type Props = {
  points: Float64Array | null;
  playback: Playback | null;
  playing: boolean;
  speed: number;
  selected: number;
  options: GlobeOptions;
  onTime: (seconds: number, fps: number, active: number) => void;
  onSelect: (index: number) => void;
  handle: React.RefObject<GlobeHandle | null>;
};

let loader: Promise<CAPI> | null = null;
function loadCesium() {
  if (!loader)
    loader = new Promise<CAPI>((resolve, reject) => {
      if (window.Cesium) return resolve(window.Cesium);
      window.CESIUM_BASE_URL = '/cesium/';
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/cesium/Widgets/widgets.css';
      document.head.append(css);
      const script = document.createElement('script');
      script.src = '/cesium/Cesium.js';
      script.onload = () => resolve(window.Cesium);
      script.onerror = () => {
        loader = null;
        reject(new Error('Cesium could not load. Run npm run assets.'));
      };
      document.head.append(script);
    });
  return loader;
}

export default function OrbitGlobe(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const runtime = useRef<{
    c: CAPI;
    viewer: Cesium.Viewer;
    rebuild: () => void;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    loadCesium()
      .then((c) => {
        if (disposed || !container.current) return;
        const viewer = new c.Viewer(container.current, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          baseLayer: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
          contextOptions: { webgl: { alpha: false } },
          skyBox: false,
        });
        viewer.scene.globe.baseColor = c.Color.fromCssColorString('#18333f');
        viewer.scene.backgroundColor = c.Color.fromCssColorString('#050b12');
        viewer.scene.globe.enableLighting = true;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.resolutionScale =
          Math.min(window.devicePixelRatio || 1, 1.5) /
          (window.devicePixelRatio || 1);
        // Bundled earth imagery works offline and needs no ion token.
        c.TileMapServiceImageryProvider.fromUrl(
          '/cesium/Assets/Textures/NaturalEarthII',
        )
          .then((provider) => {
            if (!disposed) {
              viewer.imageryLayers.addImageryProvider(provider);
              viewer.scene.requestRender();
            }
          })
          .catch(() => {
            /* Base globe remains usable if texture is unavailable. */
          });
        const home = () =>
          viewer.camera.flyTo({
            destination: c.Cartesian3.fromDegrees(-30, 22, 23000000),
            duration: 1,
          });
        home();
        let points = viewer.scene.primitives.add(
          new c.PointPrimitiveCollection(),
        );
        let sats = viewer.scene.primitives.add(
          new c.PointPrimitiveCollection(),
        );
        const lines = viewer.scene.primitives.add(new c.PolylineCollection());
        const detail = viewer.scene.primitives.add(new c.PolylineCollection());
        const horizon = detail.add({
          positions: [],
          width: 1,
          material: c.Material.fromType('Color', {
            color: c.Color.fromCssColorString('#7d9cad').withAlpha(0.7),
          }),
        });
        const footprint = detail.add({
          positions: [],
          width: 2,
          material: c.Material.fromType('Color', {
            color: c.Color.fromCssColorString('#52d8cd'),
          }),
        });
        const spokes = Array.from({ length: 8 }, () =>
          detail.add({
            positions: [],
            width: 1,
            material: c.Material.fromType('Color', {
              color: c.Color.fromCssColorString('#52d8cd').withAlpha(0.5),
            }),
          }),
        );
        const triangles = Array.from({ length: 32 }, () =>
          viewer.entities.add({
            show: false,
            polygon: {
              hierarchy: new c.PolygonHierarchy(),
              perPositionHeight: true,
              arcType: c.ArcType.NONE,
              material: c.Color.fromCssColorString('#3ee1d0').withAlpha(0.055),
            },
          }),
        );
        let satPoints: Cesium.PointPrimitive[] = [];
        let satPositions: Cesium.Cartesian3[] = [];
        let targetPositions = new Map<number, Cesium.Cartesian3>();
        let linePool: Cesium.Polyline[] = [];
        let seconds = 0,
          last = performance.now(),
          lastUi = last,
          lastDetail = -Infinity,
          frames = 0,
          detailKey = '';
        let lastPlayback: Playback | null = null;
        const scratch = new c.Cartesian3();
        let activeBySecond = new Map<
          number,
          import('@/lib/orbit-api').Observation[]
        >();
        function rebuild() {
          const p = current.current;
          detail.show = !!p.playback;
          triangles.forEach((t) => {
            t.show = false;
          });
          viewer.scene.primitives.remove(points);
          viewer.scene.primitives.remove(sats);
          points = viewer.scene.primitives.add(
            new c.PointPrimitiveCollection(),
          );
          sats = viewer.scene.primitives.add(new c.PointPrimitiveCollection());
          satPoints = [];
          satPositions = [];
          targetPositions = new Map();
          lines.removeAll();
          linePool = [];
          activeBySecond = new Map();
          const data = p.playback?.targets ?? p.points;
          const stride = p.playback ? 6 : 5;
          if (data)
            for (let i = 0; i < data.length; i += stride) {
              const pos = new c.Cartesian3(
                data[i + 1],
                data[i + 2],
                data[i + 3],
              );
              targetPositions.set(data[i], pos);
              const feasible = p.playback ? data[i + 4] === 1 : true;
              const scheduled = p.playback ? data[i + 5] === 1 : false;
              points.add({
                position: pos,
                pixelSize: scheduled ? 4 : 3,
                color: c.Color.fromCssColorString(
                  scheduled ? '#6ef2cc' : feasible ? '#f2bd69' : '#677485',
                ),
                show: !p.options.feasibleOnly || feasible,
              });
            }
          if (p.playback) {
            p.playback.run.satellites.forEach((s, i) => {
              const pos = new c.Cartesian3();
              satPositions.push(pos);
              satPoints.push(
                sats.add({
                  id: { satellite: i },
                  position: pos,
                  pixelSize: 6,
                  color: c.Color.fromCssColorString('#eafaff'),
                  outlineColor: c.Color.fromCssColorString('#379fb6'),
                  outlineWidth: 1,
                }),
              );
            });
            for (const event of p.playback.run.events) {
              for (let second = event.start; second < event.end; second++) {
                const list = activeBySecond.get(second) ?? [];
                list.push(event);
                activeBySecond.set(second, list);
              }
            }
            if (lastPlayback !== p.playback) {
              seconds = 0;
              lastPlayback = p.playback;
            }
          }
          lastDetail = -Infinity;
          detailKey = '';
          viewer.scene.requestRender();
        }
        function drawDetail(pos: Cesium.Cartesian3) {
          const opts = current.current.options;
          horizon.show = opts.horizon;
          footprint.show = opts.cone;
          spokes.forEach((s) => (s.show = opts.cone));
          if (!opts.horizon && !opts.cone) {
            triangles.forEach((t) => (t.show = false));
            return;
          }
          const ellipsoid = c.Ellipsoid.WGS84;
          const scaled = c.Cartesian3.multiplyComponents(
            pos,
            ellipsoid.oneOverRadii,
            new c.Cartesian3(),
          );
          const magnitude = c.Cartesian3.magnitude(scaled);
          if (magnitude <= 1) return;
          const normal = c.Cartesian3.normalize(scaled, new c.Cartesian3());
          const axis =
            Math.abs(normal.z) < 0.9
              ? c.Cartesian3.UNIT_Z
              : c.Cartesian3.UNIT_X;
          const u = c.Cartesian3.normalize(
            c.Cartesian3.cross(normal, axis, new c.Cartesian3()),
            new c.Cartesian3(),
          );
          const v = c.Cartesian3.cross(normal, u, new c.Cartesian3());
          const center = c.Cartesian3.divideByScalar(
            normal,
            magnitude,
            new c.Cartesian3(),
          );
          const radius = Math.sqrt(1 - 1 / (magnitude * magnitude));
          const limb: Cesium.Cartesian3[] = [];
          for (let i = 0; i <= 64; i++) {
            const angle = (i / 64) * 2 * Math.PI;
            const q = new c.Cartesian3(
              center.x +
                radius * (u.x * Math.cos(angle) + v.x * Math.sin(angle)),
              center.y +
                radius * (u.y * Math.cos(angle) + v.y * Math.sin(angle)),
              center.z +
                radius * (u.z * Math.cos(angle) + v.z * Math.sin(angle)),
            );
            limb.push(c.Cartesian3.multiplyComponents(q, ellipsoid.radii, q));
          }
          horizon.positions = limb;
          const down = c.Cartesian3.negate(
            c.Cartesian3.normalize(pos, new c.Cartesian3()),
            new c.Cartesian3(),
          );
          const side = c.Cartesian3.normalize(
            c.Cartesian3.cross(down, axis, new c.Cartesian3()),
            new c.Cartesian3(),
          );
          const up = c.Cartesian3.cross(down, side, new c.Cartesian3());
          const theta = c.Math.toRadians(
            current.current.playback!.run.scenario.constraints
              .max_off_nadir_deg,
          );
          const edge: Cesium.Cartesian3[] = [];
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            // Clip each ray to the ellipsoid limb using bisection if it misses Earth.
            let lo = 0,
              hi = theta,
              hit: Cesium.Cartesian3 | undefined;
            for (let k = 0; k < 14; k++) {
              const t = k === 0 ? hi : (lo + hi) / 2;
              const dir = new c.Cartesian3(
                down.x * Math.cos(t) +
                  (side.x * Math.cos(a) + up.x * Math.sin(a)) * Math.sin(t),
                down.y * Math.cos(t) +
                  (side.y * Math.cos(a) + up.y * Math.sin(a)) * Math.sin(t),
                down.z * Math.cos(t) +
                  (side.z * Math.cos(a) + up.z * Math.sin(a)) * Math.sin(t),
              );
              const ray = new c.Ray(pos, dir);
              const interval = c.IntersectionTests.rayEllipsoid(ray, ellipsoid);
              if (interval) {
                hit = c.Ray.getPoint(ray, interval.start, new c.Cartesian3());
                lo = t;
                if (k === 0) break;
              } else hi = t;
            }
            edge.push(
              hit ??
                ellipsoid.scaleToGeocentricSurface(pos, new c.Cartesian3()),
            );
          }
          footprint.positions = [...edge, edge[0]];
          spokes.forEach((s, i) => (s.positions = [pos, edge[i * 4]]));
          triangles.forEach((entity, i) => {
            entity.show = opts.cone;
            entity.polygon!.hierarchy = new c.ConstantProperty(
              new c.PolygonHierarchy([
                c.Cartesian3.clone(pos),
                edge[i],
                edge[(i + 1) % 32],
              ]),
            );
          });
        }
        const removeTick = viewer.clock.onTick.addEventListener(() => {
          const now = performance.now(),
            p = current.current,
            elapsed = Math.min((now - last) / 1000, 0.25);
          last = now;
          if (p.playback) {
            if (p.playing)
              seconds = Math.min(
                seconds + elapsed * p.speed,
                p.playback.run.scenario.duration_seconds,
              );
            const { positions: array, run } = p.playback;
            const si = Math.min(
                Math.floor(seconds / run.sample_step),
                run.sample_count - 2,
              ),
              alpha = (seconds - si * run.sample_step) / run.sample_step;
            const count = satPoints.length;
            for (let i = 0; i < count; i++) {
              const a = (si * count + i) * 3,
                b = ((si + 1) * count + i) * 3;
              scratch.x = array[a] + (array[b] - array[a]) * alpha;
              scratch.y = array[a + 1] + (array[b + 1] - array[a + 1]) * alpha;
              scratch.z = array[a + 2] + (array[b + 2] - array[a + 2]) * alpha;
              c.Cartesian3.clone(scratch, satPositions[i]);
              satPoints[i].position = scratch;
              satPoints[i].pixelSize = i === p.selected ? 10 : 6;
            }
            viewer.clock.currentTime = c.JulianDate.addSeconds(
              c.JulianDate.fromIso8601(run.scenario.start),
              seconds,
              new c.JulianDate(),
            );
            const active = activeBySecond.get(Math.floor(seconds)) ?? [];
            while (linePool.length < active.length)
              linePool.push(
                lines.add({
                  positions: [],
                  width: 1.5,
                  material: c.Material.fromType('Color', {
                    color: c.Color.fromCssColorString('#6ef2cc').withAlpha(0.7),
                  }),
                }),
              );
            linePool.forEach((line, i) => {
              const e = active[i];
              line.show = p.options.lines && !!e;
              if (e) {
                const target = targetPositions.get(e.target_id);
                if (target)
                  line.positions = [satPositions[e.satellite_index], target];
              }
            });
            const nextDetailKey = `${Math.floor(seconds * 5)}:${p.selected}:${p.options.cone}:${p.options.horizon}`;
            if (
              now - lastDetail > 200 &&
              nextDetailKey !== detailKey &&
              satPositions[p.selected]
            ) {
              drawDetail(satPositions[p.selected]);
              lastDetail = now;
              detailKey = nextDetailKey;
              viewer.scene.requestRender();
            }
            if (p.playing) viewer.scene.requestRender();
            if (now - lastUi > 250) {
              p.onTime(
                seconds,
                Math.round((frames * 1000) / (now - lastUi)),
                active.length,
              );
              lastUi = now;
              frames = 0;
            }
          }
          points.show = p.options.targets;
        });
        const removeRender = viewer.scene.postRender.addEventListener(() => {
          frames++;
        });
        const click = new c.ScreenSpaceEventHandler(viewer.canvas);
        click.setInputAction((event: { position: Cesium.Cartesian2 }) => {
          const picked = viewer.scene.pick(event.position);
          if (picked?.id?.satellite !== undefined)
            current.current.onSelect(picked.id.satellite);
        }, c.ScreenSpaceEventType.LEFT_CLICK);
        current.current.handle.current = {
          seek: (value) => {
            seconds = value;
            lastDetail = -Infinity;
            viewer.scene.requestRender();
          },
          home,
        };
        runtime.current = { c, viewer, rebuild };
        rebuild();
        setReady(true);
        cleanup = () => {
          removeTick();
          removeRender();
          click.destroy();
          viewer.destroy();
          runtime.current = null;
        };
      })
      .catch((err) => setError(String(err)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  useEffect(() => {
    runtime.current?.rebuild();
  }, [props.points, props.playback, props.options.feasibleOnly]);
  useEffect(() => {
    runtime.current?.viewer.scene.requestRender();
  }, [props.options, props.selected, props.playing]);
  return (
    <div className="globe-root">
      <div className="cesium-host" ref={container} />
      {!ready && !error && (
        <div className="globe-notice">Loading Cesium globe…</div>
      )}
      {error && (
        <div role="alert" className="globe-notice">
          {error}
        </div>
      )}
    </div>
  );
}
