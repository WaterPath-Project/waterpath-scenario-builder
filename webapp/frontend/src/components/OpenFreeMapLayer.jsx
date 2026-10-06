import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import useSettingsStore from '../store/settingsStore';
import createMinimalStyle from '../mapStyles/minimalStyle';

setWorkerUrl(maplibreWorkerUrl);

export const BASEMAP_STYLES = [
  { id: 'bright', label: 'Bright' },
  { id: 'positron', label: 'Positron' },
  { id: 'liberty', label: 'Liberty' },
  { id: 'dark', label: 'Dark' },
  { id: 'minimal', label: 'Minimal' },
];

const STYLE_BASE_URL = 'https://tiles.openfreemap.org/styles';
const CONTEXT_PANE = 'basemapContextPane';
const WATER_BODY_COLOR = '#DCE3EA'; // wpGray-200

function loadBasemapStyle(styleId, signal) {
  if (styleId === 'minimal') {
    return Promise.resolve(createMinimalStyle());
  }

  return fetch(`${STYLE_BASE_URL}/${styleId}`, { signal }).then(response => {
    if (!response.ok) {
      throw new Error(`Unable to load basemap style (${response.status})`);
    }

    return response.json();
  });
}

function contextStyle(style) {
  return {
    ...style,
    layers: style.layers.filter(layer => (
      layer.type === 'symbol'
      || layer['source-layer'] === 'boundary'
      || (layer.type === 'line' && layer['source-layer'] === 'waterway')
    )),
  };
}

function withWaterBodyColor(style) {
  return {
    ...style,
    layers: style.layers.map(layer => {
      if (layer.type !== 'fill' || layer['source-layer'] !== 'water') return layer;

      return {
        ...layer,
        paint: {
          ...layer.paint,
          'fill-color': WATER_BODY_COLOR,
        },
      };
    }),
  };
}

export default function OpenFreeMapLayer({ exportable = false }) {
  const map = useMap();
  const basemapStyle = useSettingsStore(state => state.basemapStyle);

  useEffect(() => {
    const controller = new AbortController();

    let active = true;
    let baseLayer = null;
    let foregroundLayer = null;
    if (!map.getPane(CONTEXT_PANE)) {
      const pane = map.createPane(CONTEXT_PANE);
      pane.style.zIndex = '550';
      pane.style.pointerEvents = 'none';
    }

    loadBasemapStyle(basemapStyle, controller.signal)
      .then(style => {
        if (!active) return;
        const styledMap = withWaterBodyColor(style);
        baseLayer = maplibreGL({
          style: styledMap,
          preserveDrawingBuffer: exportable,
          attribution: '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);

        foregroundLayer = maplibreGL({
          style: contextStyle(styledMap),
          preserveDrawingBuffer: exportable,
          pane: CONTEXT_PANE,
          attribution: '',
          interactive: false,
        }).addTo(map);
      })
      .catch(error => {
        if (error.name !== 'AbortError') console.error('Unable to load basemap context layer', error);
      });

    return () => {
      active = false;
      controller.abort();
      if (foregroundLayer) map.removeLayer(foregroundLayer);
      if (baseLayer) map.removeLayer(baseLayer);
    };
  }, [map, basemapStyle, exportable]);

  return null;
}