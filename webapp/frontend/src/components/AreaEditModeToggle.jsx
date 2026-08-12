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
    <div className={`flex gap-0.5 p-0.5 bg-gray-100 border border-gray-200 rounded-lg flex-shrink-0 ${className}`}>
      {opts.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors ${
            mode === key ? 'bg-white text-wpBlue' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Icon size={11} />
          {label}
        </button>
      ))}
    </div>
  );
}
