import type { Basemap } from './visualization/contracts';

/** Provider URLs/credits are application configuration, not Cesium-specific code. */
export const basemaps: Basemap[] = [
  {
    id: 'natural-earth',
    label: 'Natural Earth · offline',
    kind: 'natural-earth',
    attribution: 'Natural Earth',
  },
  {
    id: 'esri-imagery',
    label: 'Esri World Imagery · satellite',
    kind: 'xyz',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maximumLevel: 19,
  },
  {
    id: 'esri-topographic',
    label: 'Esri World Topographic',
    kind: 'xyz',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Esri, HERE, Garmin, USGS, OpenStreetMap contributors, and the GIS User Community',
    maximumLevel: 19,
  },
  {
    id: 'esri-relief',
    label: 'Esri Shaded Relief',
    kind: 'xyz',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, USGS, NOAA',
    maximumLevel: 13,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap · streets',
    kind: 'xyz',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors · openstreetmap.org/copyright',
    maximumLevel: 19,
  },
];

export function resolveBasemap(id: string): Basemap {
  return basemaps.find((item) => item.id === id) ?? basemaps[0];
}
