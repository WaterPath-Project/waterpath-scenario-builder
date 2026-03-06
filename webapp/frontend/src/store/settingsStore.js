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
       * When true: skip deletion of .RDS files after a model run so they can
       * be inspected for debugging.  When false (default), RDS files are
       * removed automatically once the run completes.
       */
      debugMode: false,

      // ── Actions ──────────────────────────────────────────────────────────────

      setHeatmapView:     (value) => set({ heatmapView: value }),
      setFixedColorScale: (value) => set({ fixedColorScale: value }),
      setDynamicLogMax:   (value) => set({ dynamicLogMax: value }),
      setDebugMode:       (value) => set({ debugMode: value }),
    }),
    {
      name: 'waterpath-settings', // localStorage key
      // Exclude runtime state (dynamicLogMax) from persistence
      partialize: (state) => ({
        heatmapView:     state.heatmapView,
        fixedColorScale: state.fixedColorScale,
        debugMode:       state.debugMode,
      }),
    }
  )
);

export default useSettingsStore;
