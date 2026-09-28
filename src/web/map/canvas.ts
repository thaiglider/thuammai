import { AttributionControl, GPUInitializationError, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { creditsToAdd, mapErrorStage, MAP_CREDIT, type ExtraLayer, type FC } from '../lib/map-data';

// Same-origin bundled worker (Vite `?worker&url`), so the CSP needs no third-party script origin.
setWorkerUrl(workerUrl);

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export type SourceId = 'flagged' | 'extra' | 'reports' | 'places';
export interface CanvasOpts {
  container: HTMLElement; center: [number, number]; zoom: number;
  onReady(): void;
  onError(stage: 'style' | 'tiles'): void;
  popupFor(source: SourceId, id: string): HTMLElement | null;
  onMoveEnd(): void;
}
export interface MapCanvas {
  setData(source: SourceId, fc: FC): void;
  setVisible(layer: ExtraLayer, on: boolean): void;
  center(): { lat: number; lon: number };
  zoom(): number;
  bounds(): [number, number, number, number];
  remove(): void;
}
export class NoWebGLError extends Error {}

type LayerSpec = Parameters<MapLibreMap['addLayer']>[0];
type GeoData = Parameters<GeoJSONSource['setData']>[0];

const KINDS = ['river', 'canal', 'road', 'rain', 'dam'] as const;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };
const LOCALE: Record<string, string> = {
  'Map.Title': 'แผนที่',
  'NavigationControl.ZoomIn': 'ซูมเข้า',
  'NavigationControl.ZoomOut': 'ซูมออก',
  'AttributionControl.ToggleAttribution': 'แสดงหรือซ่อนเครดิตแผนที่',
  'Popup.Close': 'ปิด',
  // Cooperative gestures: one finger scrolls the page, two fingers move the map.
  'CooperativeGesturesHandler.WindowsHelpText': 'กด Ctrl ค้างแล้วเลื่อนเพื่อซูมแผนที่',
  'CooperativeGesturesHandler.MacHelpText': 'กด ⌘ ค้างแล้วเลื่อนเพื่อซูมแผนที่',
  'CooperativeGesturesHandler.MobileHelpText': 'ใช้สองนิ้วเพื่อเลื่อนแผนที่',
};

function circle(id: string, source: SourceId, visible: boolean, kind?: string, strokeWidth = 1.5): LayerSpec {
  return {
    id, type: 'circle', source,
    ...(kind ? { filter: ['==', ['get', 'kind'], kind] } : {}),
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['get', 'r'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': strokeWidth },
  } as LayerSpec;
}

export function createMapCanvas(o: CanvasOpts): MapCanvas {
  let map: MapLibreMap;
  try {
    map = new MapLibreMap({
      container: o.container, style: STYLE_URL, center: o.center, zoom: o.zoom, minZoom: 4, maxZoom: 18,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, locale: LOCALE,
      // The map is 62vh tall: without this a one-finger swipe over it pans the map and traps the
      // page scroll on a phone.
      cooperativeGestures: true,
    });
  } catch (e) {
    if (e instanceof GPUInitializationError) throw new NoWebGLError(e.message);
    throw e;
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  // Starts with all our credits; once the basemap's sources (and their TileJSON) are loaded,
  // entries the style already credits itself are dropped, so nothing is shown twice.
  let attribution = new AttributionControl({ compact: true, customAttribution: MAP_CREDIT.map((c) => c.html) });
  map.addControl(attribution, 'bottom-right');
  let creditsDone = false;
  const trimCredits = () => {
    if (creditsDone) return;
    creditsDone = true;
    const style = map.getStyle();
    const own = Object.keys(style?.sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution ?? '').join(' ');
    const keep = creditsToAdd(own);
    if (keep.length === MAP_CREDIT.length) return;
    map.removeControl(attribution);
    attribution = new AttributionControl({ compact: true, customAttribution: keep });
    map.addControl(attribution, 'bottom-right');
  };

  const data = new Map<SourceId, FC>();
  const visible = new Set<ExtraLayer>();
  const layerOf = (l: ExtraLayer) => (l === 'reports' ? 'reports' : `extra-${l}`);
  let loaded = false;
  map.on('load', () => {
    loaded = true;
    for (const id of ['extra', 'reports', 'places', 'flagged'] as const) map.addSource(id, { type: 'geojson', data: (data.get(id) ?? EMPTY) as GeoData });
    for (const k of KINDS) map.addLayer(circle(`extra-${k}`, 'extra', visible.has(k), k));
    map.addLayer(circle('reports', 'reports', visible.has('reports')));
    map.addLayer(circle('flagged', 'flagged', true));
    map.addLayer(circle('places', 'places', true, undefined, 3));
    // Not `.once`: every idle after the first also tells the view the map is settled, so a
    // transient tile error (stage 'tiles') clears on the next successful idle instead of
    // sticking around for the rest of the session.
    map.on('idle', () => { trimCredits(); o.onReady(); });
  });
  // Classified by the event (tile/source/sprite/glyph → partial), not only by timing, so one
  // failed tile before the first 'load' doesn't tear down a working map.
  map.on('error', (e) => o.onError(mapErrorStage(e as unknown as Parameters<typeof mapErrorStage>[0], loaded, STYLE_URL)));
  map.on('moveend', () => o.onMoveEnd());
  const clickable = ['places', 'flagged', 'reports', ...KINDS.map((k) => `extra-${k}`)];
  map.on('click', (e) => {
    if (!loaded) return;
    const pad = 12; // finger-sized hit area around small circles
    const [f] = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: clickable });
    if (!f) return;
    const content = o.popupFor(f.source as SourceId, String(f.properties.id));
    if (content) new Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setDOMContent(content).addTo(map);
  });

  return {
    setData(id, fc) {
      data.set(id, fc);
      if (loaded) (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc as GeoData);
    },
    setVisible(l, on) {
      if (on) visible.add(l); else visible.delete(l);
      if (loaded) map.setLayoutProperty(layerOf(l), 'visibility', on ? 'visible' : 'none');
    },
    center() {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },
    zoom() { return map.getZoom(); },
    bounds() {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
    remove() { map.remove(); },
  };
}
