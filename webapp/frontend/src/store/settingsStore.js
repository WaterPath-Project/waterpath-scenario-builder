import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Global app settings store.
 *
 * Settings are persisted in localStorage so they survive page reloads.
 *
 * Usage:
 *   import useSettingsStore from '../store/settingsStore';
 *   const { heatmapView, setHeatmapView } = useSettingsStore();
 */
const useSettingsStore = create(
  persist(
    (set) => ({
      // ── State ────────────────────────────────────────────────────────────────

      /**
       * When true (default): apply bilinear smoothing to the raster overlay on the map.
       * When false: exact pixel-accurate rendering – no resampling, no averaging.
       */
      heatmapView: true,

      /** OpenFreeMap vector style used by every map in the app. */
      basemapStyle: 'bright',

      /**
       * When true (default): clamp the colour-scale maximum at log₁₀ = 17 so maps from
       * different case studies are always visually comparable.
       * When false: derive the maximum from the loaded TIF file (dynamic per-map range).
       */
      fixedColorScale: true,

      /**
       * Non-persisted: the log₁₀ max derived from the current TIF when fixedColorScale=false.
       * Set by GeoTiffLayer after parsing the raster; read by Legend.
       */
      dynamicLogMax: null,

      /**
       * Minimum number of valid raster pixels required to render the GeoTIFF overlay.
       * When the output raster has fewer valid pixels than this threshold, the map
       * switches to choropleth mode (filled polygons) instead. Default: 20.
       */
      choroplethPixelThreshold: 20,

      /**
       * When true: skip deletion of .RDS files after a model run so they can
       * be inspected for debugging.  When false (default), RDS files are
       * removed automatically once the run completes.
       * Display name: "Development mode — preserve RDS files"
       */
      debugMode: false,

      // ── Actions ──────────────────────────────────────────────────────────────

      setHeatmapView:                (value) => set({ heatmapView: value }),
      setBasemapStyle:               (value) => set({ basemapStyle: value }),
      setFixedColorScale:            (value) => set({ fixedColorScale: value }),
      setDynamicLogMax:              (value) => set({ dynamicLogMax: value }),
      setChoroplethPixelThreshold:   (value) => set({ choroplethPixelThreshold: value }),
      setDebugMode:                  (value) => set({ debugMode: value }),
    }),
    {
      name: 'waterpath-settings', // localStorage key
      // Exclude runtime state (dynamicLogMax) from persistence
      partialize: (state) => ({
        heatmapView:               state.heatmapView,
        basemapStyle:              state.basemapStyle,
        fixedColorScale:           state.fixedColorScale,
        choroplethPixelThreshold:  state.choroplethPixelThreshold,
        debugMode:                 state.debugMode,
      }),
    }
  )
);

export default useSettingsStore;
