import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';

// ─── Constants (mirrored from ResultsView) ─────────────────────────────────────

const SANITATION_GROUPS = [
  { id: 'improved',       label: 'Improved',        color: '#2E7D32', darkText: false,
    sources: ['flushSewer','flushSeptic','flushPit','pitSlab','compostingToilet','containerBased'] },
  { id: 'unimproved',     label: 'Unimproved',      color: '#FFDA46', darkText: true,
    sources: ['pitNoSlab','bucketLatrine','hangingToilet','flushOpen','flushUnknown','other'] },
  { id: 'openDefecation', label: 'Open Defecation', color: '#FFC000', darkText: true,
    sources: ['openDefecation'] },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function groupColorForSource(src) {
  const g = SANITATION_GROUPS.find(grp => grp.sources.includes(src));
  return g ? g.color : '#94a3b8';
}

function formatSourceName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function formatScientific(val) {
  if (!val || val === 0) return '0';
  let exp = Math.floor(Math.log10(Math.abs(val)));
  let coef = Math.round((val / Math.pow(10, exp)) * 10) / 10;
  if (coef >= 10) { coef = 1.0; exp += 1; }
  const supMap = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻'};
  return `${coef.toFixed(1)}×10${String(exp).split('').map(c => supMap[c] || c).join('')}`;
}

// ─── Component ─────────────────────────────────────────────────────────────────
/**
 * Horizontal preview panel shown at the bottom of the scenario editor when
 * the scenario has model outputs. Layout:
 *   Total human emissions | Emissions by toilet category | Contributing technologies
 */
export default function HumanEmissionsPreview({ scenarioId }) {
  const [srcData, setSrcData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    setLoading(true);
    setSrcData(null);

    axios.get(`/api/scenarios/${scenarioId}/output-files`)
      .then(({ data }) => {
        const waterSrcFile = (data.files || []).find(
          f => f.includes('human_sources_water') && f.endsWith('.csv')
        );
        if (!waterSrcFile) return null;
        return axios.get(`/api/scenarios/${scenarioId}/output-csv-data/${waterSrcFile}`);
      })
      .then(res => { if (!cancelled && res) setSrcData(res.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [scenarioId]);

  // Aggregate all ISO areas
  const priSrc = useMemo(() => {
    if (!srcData?.iso_rows) return {};
    const out = {};
    Object.values(srcData.iso_rows).forEach(row => {
      Object.entries(row).forEach(([src, v]) => {
        out[src] = (out[src] || 0) + (parseFloat(v) || 0);
      });
    });
    return out;
  }, [srcData]);

  const priTotal = useMemo(
    () => Object.values(priSrc).reduce((s, v) => s + v, 0),
    [priSrc]
  );

  const srcEntries = useMemo(
    () => Object.entries(priSrc).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a),
    [priSrc]
  );

  const topVal = srcEntries[0]?.[1] || 1;

  if (loading) {
    return (
      <div className="border-t border-gray-200 bg-white px-6 py-3 flex items-center gap-2 text-xs text-gray-400 flex-shrink-0">
        <div className="w-3 h-3 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
        Loading emission preview…
      </div>
    );
  }

  if (!srcData || srcEntries.length === 0) return null;

  const groupTotals = SANITATION_GROUPS.map(g => ({
    ...g,
    value: g.sources.reduce((s, src) => s + (priSrc[src] || 0), 0),
  })).filter(g => g.value > 0);

  return (
    <div className="border-t border-gray-200 bg-white flex-shrink-0">
      <div className="px-6 py-3">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Human Emissions — model output preview
        </p>
        <div className="flex gap-6 items-start">

          {/* ── Column 1: Total ───────────────────────────────────────────── */}
          <div className="flex-shrink-0 w-36">
            <p className="text-[9px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Total
            </p>
            <p className="text-2xl font-bold text-wpBlue tabular-nums leading-tight">
              {formatScientific(priTotal)}
            </p>
            <p className="text-[9px] text-gray-400 mt-0.5">vp / grid cell / yr</p>
          </div>

          <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />

          {/* ── Column 2: By toilet category ──────────────────────────────── */}
          <div className="flex-shrink-0 w-40">
            <p className="text-[9px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              By Toilet Category
            </p>
            <div className="space-y-1.5">
              {groupTotals.map(g => {
                const pct = priTotal > 0 ? (g.value / priTotal) * 100 : 0;
                return (
                  <div key={g.id}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: g.color }} />
                      <span className="text-[9px] text-gray-600 truncate">{g.label}</span>
                      <span className="ml-auto text-[9px] text-gray-500 tabular-nums">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct.toFixed(1)}%`, backgroundColor: g.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="w-px self-stretch bg-gray-100 flex-shrink-0" />

          {/* ── Column 3: Contributing technologies ───────────────────────── */}
          <div className="flex-1 min-w-0">
            <p className="text-[9px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Contributing Technologies
            </p>
            <div className="space-y-1">
              {srcEntries.slice(0, 8).map(([src, val]) => (
                <div key={src} className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: groupColorForSource(src) }}
                  />
                  <span className="text-[9px] text-gray-500 flex-shrink-0" style={{ width: 108 }}>
                    {formatSourceName(src)}
                  </span>
                  <div className="flex-1 relative h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="absolute top-0 h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (val / topVal) * 100).toFixed(1)}%`,
                        backgroundColor: groupColorForSource(src),
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <span className="text-[9px] text-gray-500 tabular-nums flex-shrink-0 w-12 text-right">
                    {formatScientific(val)}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
