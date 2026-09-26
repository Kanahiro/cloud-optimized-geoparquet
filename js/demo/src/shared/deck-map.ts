import {
  Deck,
  FlyToInterpolator,
  MapView,
  WebMercatorViewport,
  type Layer,
  type MapViewState,
  type PickingInfo,
} from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { CompassWidget, ZoomWidget } from '@deck.gl/widgets';
import '@deck.gl/widgets/stylesheet.css';

import type { ViewportBbox } from './cogp-types';
import { escapeHtml } from './format';

/** Wait this long after the view stops changing before reading it. */
const SETTLE_MS = 200;
/** Match the MapLibre demo's popup instead of deck.gl's dark default. */
const TOOLTIP_STYLE: Partial<CSSStyleDeclaration> = {
  maxWidth: '320px',
  padding: '8px',
  color: 'var(--text)',
  background: 'white',
  borderRadius: '6px',
  boxShadow: '0 2px 10px rgba(20, 30, 60, 0.2)',
};

export const FILL: [number, number, number, number] = [74, 108, 247, 90];
export const LINE: [number, number, number, number] = [31, 58, 168, 255];

export type Tooltip = { html: string; style: Partial<CSSStyleDeclaration> } | null;

export interface DeckMap {
  /** Replace the data layers drawn above the base map. */
  setLayers(layers: Layer[]): void;
  fitBounds(bounds: [[number, number], [number, number]], transitionDuration?: number): void;
  viewState(): MapViewState;
  /** The visible bounds in degrees; views crossing the antimeridian read every longitude. */
  viewportBbox(): ViewportBbox;
  /** Longitude and latitude at a pixel of the map canvas. */
  unproject(pixel: [number, number]): [number, number];
}

/**
 * A deck.gl map with no base map library: OSM raster tiles are drawn by a
 * `TileLayer`, and the view is kept in `#zoom/latitude/longitude` as in the
 * MapLibre demo. deck.gl has no `moveend`, so `onViewSettled` runs once the
 * view has stopped changing.
 */
export function createDeckMap(options: {
  parent: HTMLElement;
  getTooltip: (info: PickingInfo) => Tooltip;
  onViewSettled: () => void;
}): DeckMap {
  let viewState: MapViewState = viewStateFromHash() ?? { longitude: 0, latitude: 20, zoom: 2 };
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settleAfter = (ms: number): void => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(options.onViewSettled, ms);
  };

  const basemap = new TileLayer<ImageBitmap>({
    id: 'osm',
    data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileSize: 256,
    minZoom: 0,
    maxZoom: 19,
    renderSubLayers: (props) => {
      const [[west, south], [east, north]] = props.tile.boundingBox;
      return new BitmapLayer({ id: props.id, image: props.data, bounds: [west, south, east, north] });
    },
  });

  const deck = new Deck({
    parent: options.parent as HTMLDivElement,
    views: new MapView({ repeat: true }),
    initialViewState: viewState,
    controller: true,
    layers: [basemap],
    getTooltip: options.getTooltip,
    widgets: [
      new ZoomWidget({ placement: 'top-right' }),
      new CompassWidget({ placement: 'top-right' }),
    ],
    onViewStateChange: ({ viewState: next }) => {
      viewState = next as MapViewState;
      writeHash(viewState);
      settleAfter(SETTLE_MS);
    },
  });

  /** Jump or fly to `next`; the view settles after the transition. */
  const setView = (next: MapViewState, transitionDuration = 0): void => {
    deck.setProps({
      initialViewState: transitionDuration
        ? { ...next, transitionDuration, transitionInterpolator: new FlyToInterpolator() }
        : next,
    });
    viewState = next;
    writeHash(viewState);
    settleAfter(transitionDuration + SETTLE_MS);
  };

  const currentViewport = (): WebMercatorViewport => {
    const canvas = deck.getCanvas();
    return new WebMercatorViewport({
      ...viewState,
      width: canvas?.clientWidth || window.innerWidth,
      height: canvas?.clientHeight || window.innerHeight,
    });
  };

  window.addEventListener('hashchange', () => {
    const next = viewStateFromHash();
    if (next) setView(next);
  });

  return {
    setLayers: (layers) => deck.setProps({ layers: [basemap, ...layers] }),
    fitBounds: (bounds, transitionDuration = 0) => {
      const { width, height } = currentViewport();
      const fitted = new WebMercatorViewport({ width, height }).fitBounds(bounds, { padding: 40, maxZoom: 14 });
      setView({ longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom }, transitionDuration);
    },
    viewState: () => viewState,
    unproject: (pixel) => currentViewport().unproject(pixel) as [number, number],
    viewportBbox: () => {
      const [west, south, east, north] = currentViewport().getBounds();
      const wraps = west < -180 || east > 180;
      return {
        minX: wraps ? -180 : west,
        minY: Math.max(-90, south),
        maxX: wraps ? 180 : east,
        maxY: Math.min(90, north),
      };
    },
  };
}

/** Attribute table for a deck.gl tooltip, styled like the MapLibre popup. */
export function attributeTooltip(entries: [string, unknown][], fetchProperties: boolean): Tooltip {
  if (!fetchProperties) entries.push(['', 'Turn on “Fetch attributes” to see attributes.']);
  const rows = entries
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(formatValue(v))}</td></tr>`)
    .join('');
  return { html: `<div class="cogp-popup"><table>${rows}</table></div>`, style: TOOLTIP_STYLE };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || value instanceof Date) return String(value);
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

function viewStateFromHash(): MapViewState | null {
  const [zoom, latitude, longitude] = location.hash.slice(1).split('/').map(Number);
  if (![zoom, latitude, longitude].every((v) => v !== undefined && Number.isFinite(v))) return null;
  return { zoom: zoom!, latitude: latitude!, longitude: longitude! };
}

function writeHash({ zoom, latitude, longitude }: MapViewState): void {
  history.replaceState(null, '', `#${zoom.toFixed(2)}/${latitude.toFixed(5)}/${longitude.toFixed(5)}`);
}
