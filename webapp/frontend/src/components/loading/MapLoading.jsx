import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Rive, { RuntimeLoader, Rive as RiveRuntime } from '@rive-app/react-canvas';
import riveWasmUrl from '@rive-app/canvas/rive.wasm?url';
import loaderRiv from '../../../assets/animations/loader.riv?url';

// Serve the Rive runtime from our own bundle instead of the default unpkg CDN.
RuntimeLoader.setWasmUrl(riveWasmUrl);
// loader.riv is a plain linear animation; silence the "no stateMachine" notice.
RiveRuntime.suppressDeprecationWarnings = ['default-state-machine'];

const LAYER_LOAD_TIMEOUT_MS = 30000;

const MapLoadingContext = createContext(null);

// Map layers call `begin()` when they start fetching/rendering and invoke the
// returned (idempotent) `end()` once done. Outside a MapLoadingFrame this is a no-op.
const NOOP_TRACKER = { begin: () => () => {} };
export function useMapLoadingTracker() {
  return useContext(MapLoadingContext) || NOOP_TRACKER;
}

// Adds a Leaflet GridLayer to the map and calls `end` once its first batch of
// visible tiles has rendered (GridLayer 'load'), or after a safety timeout.
export function addLayerTracked(map, layer, end) {
  layer.once('load', end);
  map.addLayer(layer);
  if (typeof layer.isLoading === 'function' && !layer.isLoading()) end();
  setTimeout(end, LAYER_LOAD_TIMEOUT_MS);
}

export function MapLoadingOverlay({ visible, message = 'Loading map layers…' }) {
  const [mounted, setMounted] = useState(visible);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      const t = setTimeout(() => setShown(true), 20);
      return () => clearTimeout(t);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(t);
  }, [visible]);

  if (!mounted) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={visible}
      className={`absolute inset-0 z-[1100] flex flex-col items-center justify-center bg-wpBlue-900/80 backdrop-blur-[2px] transition-opacity duration-300 ${shown ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="w-48 h-48 max-w-[70%] max-h-[60%]">
        <Rive src={loaderRiv} />
      </div>
      {message && (
        <span className="px-4 text-center font-outfit text-base font-semibold text-wpGreen-900">{message}</span>
      )}
    </div>
  );
}

// Wraps a map: shows the Rive overlay while `loading` is true or while any
// descendant layer registered through useMapLoadingTracker() is still pending.
export function MapLoadingFrame({ loading = false, message, className = '', style, children }) {
  const [pending, setPending] = useState(0);

  const begin = useCallback(() => {
    let done = false;
    setPending(n => n + 1);
    return () => {
      if (done) return;
      done = true;
      setPending(n => Math.max(0, n - 1));
    };
  }, []);
  const ctx = useMemo(() => ({ begin }), [begin]);

  return (
    <MapLoadingContext.Provider value={ctx}>
      <div className={`relative ${className}`} style={style}>
        {children}
        <MapLoadingOverlay visible={loading || pending > 0} message={message} />
      </div>
    </MapLoadingContext.Provider>
  );
}

// Map-sized placeholder used before any map/geodata is available.
export function MapLoadingPlaceholder({ height = 480, message = 'Loading scenario data…', className = '' }) {
  return (
    <div className={`relative overflow-hidden rounded bg-wpGray-100 ${className}`} style={{ height }}>
      <MapLoadingOverlay visible message={message} />
    </div>
  );
}
