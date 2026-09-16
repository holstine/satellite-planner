import type * as Cesium from 'cesium';
import type {
  ViewerAdapter,
  ViewerEvents,
  VisualScene,
  ViewState,
  VisualFrame,
} from '../contracts';

export type CesiumAPI = typeof Cesium;
export type CesiumAttachmentOptions = {
  /** Opt in only if the host delegates its clock to plan playback. */
  synchronizeClock?: boolean;
  /** Supply a host-specific camera reset, or use the standard Earth view. */
  home?: () => void;
};

/** Attach planning layers to a host-owned Viewer. Never destroys the viewer,
 * replaces imagery, changes its camera at mount, or takes over its render loop.
 */
export function attachCesiumViewer(
  c: CesiumAPI,
  viewer: Cesium.Viewer,
  events: ViewerEvents,
  settings: CesiumAttachmentOptions = {},
): ViewerAdapter {
  const owner = {};
  const owned = viewer.scene.primitives.add(
    new c.PrimitiveCollection(),
  ) as Cesium.PrimitiveCollection;
  const points = owned.add(
    new c.PointPrimitiveCollection(),
  ) as Cesium.PointPrimitiveCollection;
  const sats = owned.add(
    new c.PointPrimitiveCollection(),
  ) as Cesium.PointPrimitiveCollection;
  const lines = owned.add(
    new c.PolylineCollection(),
  ) as Cesium.PolylineCollection;
  const detail = owned.add(
    new c.PolylineCollection(),
  ) as Cesium.PolylineCollection;
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
  let scene: VisualScene | null = null;
  let satPoints: Cesium.PointPrimitive[] = [];
  let satPositions: Cesium.Cartesian3[] = [];
  const targetPositions = new Map<number, Cesium.Cartesian3>();
  const targetPoints: { point: Cesium.PointPrimitive; feasible: boolean }[] =
    [];
  let linePool: Cesium.Polyline[] = [];
  let detailKey = '';
  let detailStyle = '';
  let lastDetail = -Infinity;
  let lastFeasibleOnly: boolean | undefined;
  let destroyed = false;
  const scratchTime = new c.JulianDate();
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const click = new c.ScreenSpaceEventHandler(viewer.canvas);
  const leave = () => {
    clearTimeout(hoverTimer);
    events.onHover(null);
  };
  viewer.canvas.addEventListener('mouseleave', leave);
  click.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
    clearTimeout(hoverTimer);
    const point = c.Cartesian2.clone(event.endPosition);
    // Immediately invalidate outstanding application-side detail requests.
    events.onHover(null);
    hoverTimer = setTimeout(() => {
      if (destroyed || viewer.isDestroyed()) return;
      const id = viewer.scene.pick(point)?.id;
      events.onHover(
        id?.owner === owner && id.request !== undefined
          ? { requestId: id.request, x: point.x, y: point.y }
          : null,
      );
    }, 120);
  }, c.ScreenSpaceEventType.MOUSE_MOVE);
  click.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    const id = viewer.scene.pick(event.position)?.id;
    if (id?.owner === owner && id.satellite !== undefined)
      events.onSelect(id.satellite);
  }, c.ScreenSpaceEventType.LEFT_CLICK);
  const removeRender = viewer.scene.postRender.addEventListener(
    events.onRender,
  );

  function drawDetail(
    pos: Cesium.Cartesian3,
    opts: ViewState['options'],
    maxOffNadirDeg: number,
  ) {
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
      Math.abs(normal.z) < 0.9 ? c.Cartesian3.UNIT_Z : c.Cartesian3.UNIT_X;
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
        center.x + radius * (u.x * Math.cos(angle) + v.x * Math.sin(angle)),
        center.y + radius * (u.y * Math.cos(angle) + v.y * Math.sin(angle)),
        center.z + radius * (u.z * Math.cos(angle) + v.z * Math.sin(angle)),
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
    const theta = c.Math.toRadians(maxOffNadirDeg);
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
        hit ?? ellipsoid.scaleToGeocentricSurface(pos, new c.Cartesian3()),
      );
    }
    footprint.positions = [...edge, edge[0]];
    if (cone) {
      owned.remove(cone);
      cone = null;
    }
    if (opts.cone) {
      // One closed triangle mesh: apex, ground rim, and a filled base.
      const base = ellipsoid.scaleToGeocentricSurface(pos, new c.Cartesian3());
      const vertices = [pos, ...edge, base];
      const packed = new Float64Array(vertices.flatMap((v) => [v.x, v.y, v.z]));
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
      cone = owned.add(
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

  return {
    setScene(next) {
      if (destroyed || viewer.isDestroyed()) return;
      leave();
      scene = next;
      if (cone) {
        owned.remove(cone);
        cone = null;
      }
      points.removeAll();
      sats.removeAll();
      lines.removeAll();
      satPoints = [];
      satPositions = [];
      linePool = [];
      targetPositions.clear();
      targetPoints.length = 0;
      lastFeasibleOnly = undefined;
      detailKey = '';
      detailStyle = '';
      lastDetail = -Infinity;
      detail.show = false;
      const data = next.targets;
      for (let i = 0; i < data.length; i += 6) {
        const position = new c.Cartesian3(
          data[i + 1],
          data[i + 2],
          data[i + 3],
        );
        const feasible = data[i + 4] === 1,
          scheduled = data[i + 5] === 1;
        targetPositions.set(data[i], position);
        const point = points.add({
          id: { owner, request: data[i] },
          position,
          pixelSize: scheduled ? 4 : 3,
          color: c.Color.fromCssColorString(
            scheduled ? '#6ef2cc' : feasible ? '#f2bd69' : '#677485',
          ),
        });
        targetPoints.push({ point, feasible });
      }
      for (let i = 0; i < next.spacecraft.length; i++) {
        const position = new c.Cartesian3();
        satPositions.push(position);
        satPoints.push(
          sats.add({
            id: { owner, satellite: i },
            position,
            pixelSize: 6,
            color: c.Color.fromCssColorString('#eafaff'),
            outlineColor: c.Color.fromCssColorString('#379fb6'),
            outlineWidth: 1,
          }),
        );
      }
      viewer.scene.requestRender();
    },
    render(frame: VisualFrame, state: ViewState) {
      if (destroyed || viewer.isDestroyed() || !scene) return;
      points.show = state.options.targets;
      if (lastFeasibleOnly !== state.options.feasibleOnly) {
        for (const { point, feasible } of targetPoints)
          point.show = !state.options.feasibleOnly || feasible;
        lastFeasibleOnly = state.options.feasibleOnly;
      }
      for (let i = 0; i < satPoints.length; i++) {
        satPositions[i].x = frame.spacecraftPositions[i * 3];
        satPositions[i].y = frame.spacecraftPositions[i * 3 + 1];
        satPositions[i].z = frame.spacecraftPositions[i * 3 + 2];
        satPoints[i].position = satPositions[i];
        satPoints[i].pixelSize = i === state.selected ? 10 : 6;
      }
      if (settings.synchronizeClock && frame.unixMs !== null) {
        c.JulianDate.fromDate(new Date(frame.unixMs), scratchTime);
        viewer.clock.currentTime = scratchTime;
      }
      while (linePool.length < frame.active.length)
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
        const instruction = frame.active[i];
        const target =
          instruction && targetPositions.get(instruction.requestId);
        const satellite =
          instruction && satPositions[instruction.spacecraftIndex];
        line.show = state.options.lines && !!target && !!satellite;
        if (line.show) line.positions = [satellite, target!];
      });
      const selected = satPositions[state.selected];
      detail.show = !!selected && !!scene.timeline;
      if (cone) cone.show = detail.show && state.options.cone;
      // Geometry follows playback at 5 Hz, while selections/toggles update immediately.
      const nextStyle = `${state.selected}:${state.options.cone}:${state.options.horizon}`;
      const nextKey = `${Math.floor(frame.seconds * 5)}:${nextStyle}`;
      const now = performance.now();
      if (
        detail.show &&
        nextKey !== detailKey &&
        (!state.playing || nextStyle !== detailStyle || now - lastDetail >= 200)
      ) {
        drawDetail(
          selected,
          state.options,
          scene.spacecraft[state.selected].maxOffNadirDeg,
        );
        detailKey = nextKey;
        detailStyle = nextStyle;
        lastDetail = now;
      }
      viewer.scene.requestRender();
    },
    home() {
      if (destroyed || viewer.isDestroyed()) return;
      if (settings.home) settings.home();
      else
        viewer.camera.flyTo({
          destination: c.Cartesian3.fromDegrees(-30, 22, 23000000),
          duration: 1,
        });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      leave();
      viewer.canvas.removeEventListener('mouseleave', leave);
      removeRender();
      click.destroy();
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(owned);
      else if (!owned.isDestroyed()) owned.destroy();
    },
  };
}
