// ─────────────────────────────────────────────────────────────────────────────
// Central definition of URL slug helpers, path builders and reserved names.
// Every navigation in the app should go through the `paths.*` helpers so URL
// shape stays consistent and refactor-safe.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Case-study slug — prefers `folder_name` (deterministic, disk-backed).
 * Falls back to `name` for objects that haven't been persisted yet.
 * `folder_name` never contains dots (fs-safe) so Vite's SPA fallback works.
 */
export const csSlug = (cs) =>
  encodeURIComponent(cs?.folder_name || cs?.name || '');

/**
 * Scenario slug — currently the display name, URI-encoded.
 * Scenario names are validated (see `RESERVED_SCENARIO_NAMES`) so they never
 * shadow reserved route segments like `_qmra`.
 */
export const scenSlug = (name) => encodeURIComponent(name ?? '');

/**
 * Reserved words that MUST NOT be used as scenario names, because their URI
 * encodings match dedicated route segments under `/scenarios/:csSlug/*`.
 * Keep this list in sync with `RESERVED_SCENARIO_NAMES` in
 * `webapp/backend/scenario.py`.
 */
export const RESERVED_SCENARIO_NAMES = ['_qmra', 'qmra', 'main'];

/**
 * Returns a human-readable reason if the given scenario name collides with a
 * reserved word, otherwise null. Matching is case-insensitive and ignores
 * surrounding whitespace, mirroring the backend check.
 */
export const validateScenarioName = (rawName) => {
  const name = String(rawName ?? '').trim();
  if (!name) return 'Scenario name is required';
  const lc = name.toLowerCase();
  if (RESERVED_SCENARIO_NAMES.includes(lc)) {
    return `"${name}" is a reserved name — please choose another`;
  }
  return null;
};

// Reserved URL segment for the QMRA config tab (under a case study).
export const QMRA_SEGMENT = '_qmra';

// Reserved URL segments used by the app itself (top-level or under scenarios).
// Exported for tests / defensive checks; not currently used for validation
// because scenario slugs live under `/scenarios/:csSlug/:scenSlug` — only that
// third segment can collide, which is what `RESERVED_SCENARIO_NAMES` covers.
export const TOP_LEVEL_SEGMENTS = [
  'case-studies',
  'scenarios',
  'analytics',
  'summary',
  'narratives',
  'settings',
  'service-status',
];

// ─── Path builders ──────────────────────────────────────────────────────────

export const paths = {
  root: () => '/',
  settings: () => '/settings',
  caseStudies: () => '/case-studies',
  caseStudy: (cs) => `/case-studies/${csSlug(cs)}`,
  scenarios: (cs) => (cs ? `/scenarios/${csSlug(cs)}` : '/scenarios'),
  qmra: (cs) => `/scenarios/${csSlug(cs)}/${QMRA_SEGMENT}`,
  scenario: (cs, scenarioName, category, subcategory) => {
    const parts = ['/scenarios', csSlug(cs), scenSlug(scenarioName)];
    if (category) parts.push(category);
    if (category && subcategory) parts.push(subcategory);
    return parts.join('/');
  },
  summary: (cs) => (cs ? `/summary/${csSlug(cs)}` : '/summary'),
  narratives: (cs) => (cs ? `/narratives/${csSlug(cs)}` : '/narratives'),
  analytics: (cs, opts = {}) => {
    if (!cs) return '/analytics';
    const base = `/analytics/${csSlug(cs)}`;
    const query = buildAnalyticsQuery(opts);
    return query ? `${base}?${query}` : base;
  },
};

// ─── Analytics query-string helpers ─────────────────────────────────────────

/**
 * Build the analytics query string from a params object.
 * - `scenarios`: array of scenario NAMES (raw, unencoded). Comma-joined.
 * - `emissionType`: 'water' | 'land' (default 'water' is omitted).
 * - `area`: ISO code (raw). Empty string omits.
 */
export const buildAnalyticsQuery = ({ scenarios, emissionType, area } = {}) => {
  const usp = new URLSearchParams();
  if (Array.isArray(scenarios) && scenarios.length) {
    // Join with commas — scenario names may contain commas themselves, so we
    // encode each individually.
    usp.set('scenarios', scenarios.map((s) => encodeURIComponent(s)).join(','));
  }
  if (emissionType && emissionType !== 'water') usp.set('emissionType', emissionType);
  if (area) usp.set('area', area);
  const s = usp.toString();
  // URLSearchParams re-encodes our already-encoded scenario names — undo the
  // outer layer so downstream `decodeURIComponent` gets the intended value.
  return s.replace(/%25/g, '%');
};

/** Parse the `scenarios` query param back into an array of raw names. */
export const parseScenariosParam = (raw) => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
};
