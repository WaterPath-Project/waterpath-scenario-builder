// ─── Area-scoped proportional editing helpers ────────────────────────────────
// Shared math used by the sanitation and livestock fraction editors so that
// "Adjust all areas" / "Edit individual areas" behave identically everywhere.

const TOL = 1e-6;

// Scale each target row's `key` so that the AVERAGE over `targets` becomes
// `newAvg`, while preserving the relative differences between areas.
// Rows whose index is not in `targets` are returned unchanged.
// Returns a NEW array (rows are shallow-copied only when modified).
export function scaleProportional(rows, targets, key, newAvg, { clampMax = 1, clampMin = 0, asString = false } = {}) {
  const set = new Set(targets);
  const fmt = (n) => (asString ? String(n) : n);
  const oldAvg = targets.length
    ? targets.reduce((s, i) => s + (parseFloat(rows[i]?.[key]) || 0), 0) / targets.length
    : 0;
  return rows.map((r, i) => {
    if (!set.has(i)) return r;
    const oldVal = parseFloat(r[key]) || 0;
    const scaled = oldAvg > TOL
      ? Math.min(clampMax, Math.max(clampMin, oldVal * (newAvg / oldAvg)))
      : Math.min(clampMax, Math.max(clampMin, newAvg));
    return { ...r, [key]: fmt(scaled) };
  });
}

// Like scaleProportional, but for a group of keys that must keep a constant
// per-row sum (e.g. a technology mix that sums to 100%). After scaling `key`
// proportionally toward `newAvg`, the remaining mass (rowSum − newKey) is
// redistributed across the OTHER group keys proportionally to their current
// values — or spread equally if they are all zero. This preserves each row's
// group total, so a mix that summed to 100% stays at 100% after the edit.
export function scaleGroupProportional(rows, targets, groupKeys, key, newAvg, { asString = false } = {}) {
  const set = new Set(targets);
  const others = groupKeys.filter((k) => k !== key);
  const fmt = (n) => (asString ? String(n) : n);
  const oldAvg = targets.length
    ? targets.reduce((s, i) => s + (parseFloat(rows[i]?.[key]) || 0), 0) / targets.length
    : 0;
  return rows.map((r, i) => {
    if (!set.has(i)) return r;
    const oldVal = parseFloat(r[key]) || 0;
    const rowSum = groupKeys.reduce((s, k) => s + (parseFloat(r[k]) || 0), 0);
    let newKey = oldAvg > TOL
      ? Math.min(1, Math.max(0, oldVal * (newAvg / oldAvg)))
      : Math.min(1, Math.max(0, newAvg));
    // A single field can never hold more mass than the whole group.
    newKey = Math.min(newKey, rowSum);
    const remaining = Math.max(0, rowSum - newKey);
    const sumOthers = others.reduce((s, k) => s + (parseFloat(r[k]) || 0), 0);
    const next = { ...r, [key]: fmt(newKey) };
    if (sumOthers > TOL) {
      others.forEach((k) => {
        const v = parseFloat(r[k]) || 0;
        next[k] = fmt(v * remaining / sumOthers);
      });
    } else if (others.length) {
      const each = remaining / others.length;
      others.forEach((k) => { next[k] = fmt(each); });
    }
    return next;
  });
}
