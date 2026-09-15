'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import {
  api,
  type Explanation,
  type Target,
  type Playback,
} from '@/lib/orbit-api';
import { indexInstructions, sampleInterval } from '@/lib/plan-playback';
import { CollectionDetails } from './workspace/plan-panel';

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
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    detail?: Explanation;
    request?: Target;
    error?: string;
  } | null>(null);
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
        let cone: Cesium.Primitive | null = null;
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
        let activeIndex = indexInstructions([]);
        let hoverGeneration = 0;
        const hoverCache = new Map<string, Explanation | Target>();
        function rebuild() {
          const p = current.current;
          detail.show = !!p.playback;
          if (cone) {
            viewer.scene.primitives.remove(cone);
            cone = null;
          }
          hoverGeneration++;
          hoverCache.clear();
          setHover(null);
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
          activeIndex = indexInstructions([]);
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
                id: { request: data[i] },
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
            activeIndex = indexInstructions(p.playback.run.instructions);
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
          if (cone) cone.show = opts.cone;
          if (!opts.horizon && !opts.cone) {
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
          const run = current.current.playback!.run;
          const theta = c.Math.toRadians(
            Math.min(
              run.scenario.constraints.max_off_nadir_deg,
              run.satellites[current.current.selected].max_off_nadir_deg,
            ),
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
          if (cone) {
            viewer.scene.primitives.remove(cone);
            cone = null;
          }
          if (opts.cone) {
            // One closed triangle mesh: apex, ground rim, and a filled base.
            const base = ellipsoid.scaleToGeocentricSurface(
              pos,
              new c.Cartesian3(),
            );
            const vertices = [pos, ...edge, base];
            const packed = new Float64Array(
              vertices.flatMap((v) => [v.x, v.y, v.z]),
            );
            const indices: number[] = [];
            for (let i = 0; i < edge.length; i++) {
              const a = i + 1,
                b = ((i + 1) % edge.length) + 1;
              indices.push(0, b, a, edge.length + 1, a, b);
            }
            const attributes = new c.GeometryAttributes();
            attributes.position = new c.GeometryAttribute({
              componentDatatype: c.ComponentDatatype.DOUBLE,
              componentsPerAttribute: 3,
              values: packed,
            });
            const geometry = new c.Geometry({
              attributes,
              indices: new Uint16Array(indices),
              primitiveType: c.PrimitiveType.TRIANGLES,
              boundingSphere: c.BoundingSphere.fromVertices(packed),
            });
            cone = viewer.scene.primitives.add(
              new c.Primitive({
                geometryInstances: new c.GeometryInstance({
                  geometry,
                  attributes: {
                    color: c.ColorGeometryInstanceAttribute.fromColor(
                      c.Color.fromCssColorString('#3ee1d0').withAlpha(0.3),
                    ),
                  },
                }),
                appearance: new c.PerInstanceColorAppearance({
                  flat: true,
                  closed: true,
                  translucent: true,
                }),
                asynchronous: false,
                allowPicking: false,
              }),
            );
          }
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
            const { index: si, alpha } = sampleInterval(
              seconds,
              run.sample_step,
              run.sample_count,
              run.scenario.duration_seconds,
            );
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
            const active = activeIndex.at(seconds);
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
                const target = targetPositions.get(e.request_id);
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
        let hoverTimer: ReturnType<typeof setTimeout> | undefined;
        let lastHoverKey = '';
        click.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
          clearTimeout(hoverTimer);
          const point = c.Cartesian2.clone(event.endPosition);
          const generation = ++hoverGeneration;
          hoverTimer = setTimeout(() => {
            const picked = viewer.scene.pick(point);
            const id = picked?.id?.request;
            if (id === undefined) {
              setHover(null);
              lastHoverKey = '';
              return;
            }
            const planId = current.current.playback?.run.id;
            const key = `${planId ?? 'catalog'}:${id}`;
            const x = Math.max(
              12,
              Math.min(point.x + 18, viewer.canvas.clientWidth - 326),
            );
            const y = Math.max(
              12,
              Math.min(point.y + 16, viewer.canvas.clientHeight - 360),
            );
            const show = (value: Explanation | Target) =>
              setHover({
                x,
                y,
                ...('decision' in value
                  ? { detail: value }
                  : { request: value }),
              });
            const cached = hoverCache.get(key);
            if (cached) {
              show(cached);
              return;
            }
            if (key !== lastHoverKey) setHover({ x, y });
            lastHoverKey = key;
            void api<Explanation | Target>(
              planId ? `/plans/${planId}/requests/${id}` : `/requests/${id}`,
            )
              .then((value) => {
                if (disposed || generation !== hoverGeneration) return;
                if (hoverCache.size >= 128)
                  hoverCache.delete(hoverCache.keys().next().value!);
                hoverCache.set(key, value);
                show(value);
              })
              .catch((e) => {
                if (!disposed && generation === hoverGeneration)
                  setHover({ x, y, error: String(e) });
              });
          }, 120);
        }, c.ScreenSpaceEventType.MOUSE_MOVE);
        const leave = () => {
          clearTimeout(hoverTimer);
          hoverGeneration++;
          setHover(null);
          lastHoverKey = '';
        };
        viewer.canvas.addEventListener('mouseleave', leave);
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
          clearTimeout(hoverTimer);
          viewer.canvas.removeEventListener('mouseleave', leave);
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
      {hover && (
        <div
          className="target-hover"
          role="tooltip"
          style={{ left: hover.x, top: hover.y }}
        >
          {hover.detail ? (
            <CollectionDetails detail={hover.detail} />
          ) : hover.request ? (
            <>
              <span className="eyebrow">CATALOG REQUEST</span>
              <h3>{hover.request.name}</h3>
              <p>
                {hover.request.duration_seconds}s ·{' '}
                {hover.request.satellites_required} simultaneous spacecraft ·{' '}
                {hover.request.energy_wh} Wh / sat
              </p>
              <p>
                {hover.request.collections_required} collections requested ·{' '}
                {hover.request.sensor}
              </p>
              <small>
                Build a plan to see collection times and scheduling decisions.
              </small>
            </>
          ) : (
            <p>{hover.error ?? 'Loading collection details…'}</p>
          )}
        </div>
      )}
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
