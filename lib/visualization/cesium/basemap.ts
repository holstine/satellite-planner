import type * as Cesium from 'cesium';
import type { Basemap } from '../contracts';
import type { CesiumAPI } from './adapter';

/** Switching owns one base layer; host imagery is never removed. */
export function createBasemap(
  c: CesiumAPI,
  viewer: Cesium.Viewer,
  onError?: (error: string) => void,
) {
  let generation = 0,
    currentId = '';
  let layer: Cesium.ImageryLayer | null = null;
  let unsubscribe: (() => void) | undefined;
  let destroyed = false;
  return {
    update(spec?: Basemap) {
      if (!spec || destroyed || `${spec.id}:${spec.url ?? ''}` === currentId)
        return;
      currentId = `${spec.id}:${spec.url ?? ''}`;
      const request = ++generation;
      const pending =
        spec.kind === 'natural-earth'
          ? c.TileMapServiceImageryProvider.fromUrl(
              '/cesium/Assets/Textures/NaturalEarthII',
            )
          : Promise.resolve(
              new c.UrlTemplateImageryProvider({
                url: spec.url!,
                maximumLevel: spec.maximumLevel,
                credit: new c.Credit(spec.attribution, true),
              }),
            );
      void pending
        .then((provider) => {
          if (destroyed || request !== generation || viewer.isDestroyed())
            return;
          unsubscribe?.();
          if (layer) viewer.imageryLayers.remove(layer, true);
          layer = viewer.imageryLayers.addImageryProvider(provider, 0);
          unsubscribe = provider.errorEvent.addEventListener(() =>
            onError?.(
              `${spec.label} tiles could not load. Choose another basemap or Natural Earth for offline use.`,
            ),
          );
          onError?.('');
          viewer.scene.requestRender();
        })
        .catch(() => {
          if (!destroyed && request === generation)
            onError?.(`${spec.label} could not load. Choose another basemap.`);
        });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      if (layer && !viewer.isDestroyed())
        viewer.imageryLayers.remove(layer, true);
    },
  };
}
