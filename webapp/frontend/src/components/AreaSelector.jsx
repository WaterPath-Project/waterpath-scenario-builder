import React from 'react';

/**
 * AreaSelector — "All" pill + one pill per area (multi-select)
 *
 * Props:
 *   labels          {string[]}       — display label for each area
 *   selectedIndices {Set<number>}    — empty Set = All mode; non-empty = selected indices
 *   onChange        {function}       — called with the new Set<number>
 *   singleSelect    {boolean}        — if true, selecting an area keeps only that index
 *   allowAll        {boolean}        — if true, renders the "All" option
 *   badges          {Array<{color:string,title:string}|null>|null}
 *                                    — optional per-area badge dot (index-aligned)
 */
export default function AreaSelector({
  labels,
  selectedIndices,
  onChange,
  singleSelect = false,
  allowAll = true,
  badges = null,
}) {
  const allActive = allowAll && selectedIndices.size === 0;

  const handleAll = () => {
    onChange(new Set());
  };

  const handleArea = (i) => {
    if (singleSelect) {
      onChange(new Set([i]));
      return;
    }

    const next = new Set(selectedIndices);
    if (next.has(i)) {
      next.delete(i);
      // If that was the last one, go back to "All"
    } else {
      next.add(i);
    }
    onChange(next);
  };

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {allowAll && (
        <button
          onClick={handleAll}
          className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
            allActive ? 'bg-wpBlue text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          All
        </button>
      )}
      {labels.map((label, i) => {
        const active = selectedIndices.has(i);
        const badge = badges?.[i];
        return (
          <button
            key={i}
            onClick={() => handleArea(i)}
            className={`relative px-3 py-1 text-xs rounded-full font-medium transition-colors ${
              active ? 'bg-wpBlue text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {label}
            {badge && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white"
                style={{ backgroundColor: badge.color }}
                title={badge.title}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
