import React from 'react';
import { Layers, MapPin } from 'lucide-react';

/**
 * AreaEditModeToggle — segmented control to pick how region edits apply.
 *
 *   'all'        → "Adjust all areas": every edit scales all regions proportionally.
 *   'individual' → "Edit individual areas": area pills appear; edits apply to the
 *                  selected region(s) only.
 *
 * Props:
 *   mode      {'all'|'individual'} — current mode
 *   onChange  {function}           — called with the new mode key
 *   className {string}             — optional extra classes
 */
export default function AreaEditModeToggle({ mode, onChange, className = '' }) {
  const opts = [
    { key: 'all', label: 'Adjust all areas', Icon: Layers },
    { key: 'individual', label: 'Edit individual areas', Icon: MapPin },
  ];
  return (
    <div
      className={`flex gap-1 rounded-xl bg-wpGray-100 p-1 font-inter text-xs flex-shrink-0 ${className}`}
      aria-label="Area editing scope"
    >
      {opts.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={mode === key}
          className={`flex items-center rounded-xl gap-1.5 px-3 py-1.5 font-medium transition-colors ${
            mode === key ? 'bg-white text-wpBlue' : 'bg-wpGray-100 hover:bg-wpGray-300'
          }`}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}
