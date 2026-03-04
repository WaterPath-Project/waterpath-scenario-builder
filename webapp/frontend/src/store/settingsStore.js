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
       * When true: apply nearest-neighbour smoothing to the raster overlay on the map.
       * When false (default): exact pixel-accurate rendering – no resampling, no averaging.
       */
      heatmapView: false,

      // ── Actions ──────────────────────────────────────────────────────────────

      setHeatmapView: (value) => set({ heatmapView: value }),
    }),
    {
      name: 'waterpath-settings', // localStorage key
    }
  )
);

export default useSettingsStore;
