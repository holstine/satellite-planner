import type { CesiumAPI } from './adapter';

declare global {
  interface Window {
    Cesium: CesiumAPI;
    CESIUM_BASE_URL: string;
  }
}
let loader: Promise<CesiumAPI> | null = null;

/** Only the bundled viewer needs this loader; external viewers supply their SDK. */
export function loadCesium(): Promise<CesiumAPI> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (loader) return loader;
  loader = new Promise<CesiumAPI>((resolve, reject) => {
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
      script.remove();
      css.remove();
      reject(new Error('Cesium could not load. Run npm run assets.'));
    };
    document.head.append(script);
  });
  return loader;
}
