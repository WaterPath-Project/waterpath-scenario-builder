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
       * When true: show the TIF raster as a continuous heatmap overlay on the map.
       * When false: show distinct coloured squares (choropleth) based on GeoJSON polygons.
       */
      heatmapView: true,

      // ── Actions ──────────────────────────────────────────────────────────────

      setHeatmapView: (value) => set({ heatmapView: value }),
    }),
    {
      name: 'waterpath-settings', // localStorage key
    }
  )
);

export default useSettingsStore;
