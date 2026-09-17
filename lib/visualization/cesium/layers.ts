import type * as Cesium from 'cesium';
import type { VisualizationLayer } from '../contracts';
import type { CesiumAPI } from './adapter';

/** Overlay ownership is independent from the host's imagery and planning primitives. */
export function createLayers(
  c: CesiumAPI,
  viewer: Cesium.Viewer,
  owner: object,
) {
  let previousLayers: readonly VisualizationLayer[] | null = null;
  const entries = new Map<
    string,
    {
      spec: VisualizationLayer;
      time: number;
      primitive?: Cesium.Primitive;
      imagery?: Cesium.ImageryLayer;
    }
  >();
  function remove(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    if (!viewer.isDestroyed()) {
      if (entry.primitive) viewer.scene.primitives.remove(entry.primitive);
      if (entry.imagery) viewer.imageryLayers.remove(entry.imagery, true);
    }
    entries.delete(id);
  }
  return {
    update(layers: readonly VisualizationLayer[], unixMs: number | null) {
      let reorder = previousLayers !== layers;
      const ids = new Set(layers.map((layer) => layer.id));
      for (const id of entries.keys()) if (!ids.has(id)) remove(id);
      for (const layer of layers) {
        const time =
          layer.kind === 'scalar-grid'
            ? Math.floor(
                (layer.followPlayback === false
                  ? layer.defaultTimeUnixMs
                  : (unixMs ?? layer.defaultTimeUnixMs)) / 3600000,
              ) * 3600000
            : 0;
        const old = entries.get(layer.id);
        if (old?.spec === layer && old.time === time) continue;
        if (
          old &&
          layer.kind === 'xyz-imagery' &&
          old.spec.kind === 'xyz-imagery' &&
          old.spec.url === layer.url
        ) {
          old.imagery!.show = layer.visible;
          old.imagery!.alpha = layer.opacity;
          old.spec = layer;
          continue;
        }
        remove(layer.id);
        reorder = true;
        if (!layer.visible) continue;
        if (layer.kind === 'xyz-imagery') {
          const imagery = viewer.imageryLayers.addImageryProvider(
            new c.UrlTemplateImageryProvider({
              url: layer.url,
              credit: layer.attribution,
            }),
          );
          imagery.alpha = layer.opacity;
          entries.set(layer.id, { spec: layer, time, imagery });
          continue;
        }
        const instances: Cesium.GeometryInstance[] = [];
        for (const cell of layer.cells) {
          const index = cell.times.indexOf(time);
          const value = index < 0 ? null : cell.values[index];
          if (value === null || value === undefined || !Number.isFinite(value))
            continue;
          const half = cell.sizeDegrees / 2;
          const color = c.Color.fromCssColorString(layer.color).withAlpha(
            layer.opacity * Math.max(0, Math.min(1, value / layer.maximum)),
          );
          instances.push(
            new c.GeometryInstance({
              id: {
                owner,
                layer: {
                  layerId: layer.id,
                  label: layer.label,
                  value,
                  unit: layer.unit,
                  timeUnixMs: time,
                  attribution: layer.attribution,
                },
              },
              geometry: new c.RectangleGeometry({
                rectangle: c.Rectangle.fromDegrees(
                  cell.longitude - half,
                  cell.latitude - half,
                  cell.longitude + half,
                  cell.latitude + half,
                ),
                height: 1000,
                vertexFormat: c.PerInstanceColorAppearance.VERTEX_FORMAT,
              }),
              attributes: {
                color: c.ColorGeometryInstanceAttribute.fromColor(color),
              },
            }),
          );
        }
        const primitive = instances.length
          ? (viewer.scene.primitives.add(
              new c.Primitive({
                geometryInstances: instances,
                appearance: new c.PerInstanceColorAppearance({
                  flat: true,
                  translucent: true,
                }),
                asynchronous: false,
              }),
            ) as Cesium.Primitive)
          : undefined;
        entries.set(layer.id, { spec: layer, time, primitive });
      }
      if (reorder)
        for (const layer of layers) {
          const entry = entries.get(layer.id);
          if (entry?.primitive)
            viewer.scene.primitives.raiseToTop(entry.primitive);
          if (entry?.imagery) viewer.imageryLayers.raiseToTop(entry.imagery);
        }
      previousLayers = layers;
    },
    destroy() {
      for (const id of entries.keys()) remove(id);
    },
  };
}
