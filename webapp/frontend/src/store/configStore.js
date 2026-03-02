import { create } from 'zustand';
import axios from 'axios';

/**
 * Global configuration store.
 *
 * Currently exposes:
 *  • pathogens  – array of pathogen objects read from the glowpa package CSV
 *                 (each object has all CSV columns: name, pathogen_type, …)
 *  • pathogenOptions – [{ value, label }] ready for use in <select> elements
 *
 * Additional config sections will be added here over time.
 *
 * Usage:
 *   import useConfigStore from '../store/configStore';
 *   const { pathogens, pathogenOptions, fetchConfig } = useConfigStore();
 *
 * Call fetchConfig() once at app startup (App.jsx) – subsequent calls are no-ops.
 */
const useConfigStore = create((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────────
  pathogens: [],          // raw rows from /api/config/pathogens
  pathogenOptions: [],    // [{ value: string, label: string }]
  configLoaded: false,
  configLoading: false,
  configError: null,

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Fetch all config data from the backend.
   * Safe to call multiple times — only executes once per session.
   */
  fetchConfig: async () => {
    const { configLoaded, configLoading } = get();
    if (configLoaded || configLoading) return;

    set({ configLoading: true, configError: null });
    try {
      const res = await axios.get('/api/config/pathogens');
      const pathogens = res.data.pathogens ?? [];

      // Derive display options: use the CSV `name` as value; capitalise first letter for label.
      const pathogenOptions = pathogens.map((p) => ({
        value: p.name,
        label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
      }));

      set({ pathogens, pathogenOptions, configLoaded: true });
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      console.error('[configStore] Failed to load config:', msg);
      set({ configError: msg });
    } finally {
      set({ configLoading: false });
    }
  },
}));

export default useConfigStore;
