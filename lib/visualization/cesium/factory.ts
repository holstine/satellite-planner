import type { ViewerFactory } from '../contracts';
import { attachCesiumViewer } from './adapter';
import { loadCesium } from './loader';
import './viewer.css';

/** Default composition. This factory owns its viewer, imagery and lifecycle. */
export const createCesiumViewer: ViewerFactory = async (container, events) => {
  const c = await loadCesium();
  const viewer = new c.Viewer(container, {
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
  try {
    viewer.scene.globe.baseColor = c.Color.fromCssColorString('#18333f');
    viewer.scene.backgroundColor = c.Color.fromCssColorString('#050b12');
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.resolutionScale =
      Math.min(window.devicePixelRatio || 1, 1.5) /
      (window.devicePixelRatio || 1);
    void c.TileMapServiceImageryProvider.fromUrl(
      '/cesium/Assets/Textures/NaturalEarthII',
    )
      .then((provider) => {
        if (!viewer.isDestroyed()) {
          viewer.imageryLayers.addImageryProvider(provider);
          viewer.scene.requestRender();
        }
      })
      .catch(() => {
        /* The base globe works without imagery. */
      });
    const adapter = attachCesiumViewer(c, viewer, events, {
      synchronizeClock: true,
    });
    adapter.home();
    return {
      ...adapter,
      destroy() {
        adapter.destroy();
        if (!viewer.isDestroyed()) viewer.destroy();
      },
    };
  } catch (error) {
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }
};
