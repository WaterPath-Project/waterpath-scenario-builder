/**
 * RegenerateDialog.jsx
 * ====================
 *
 * Confirms a regeneration run: which sections to rebuild, and whether the
 * user's manual edits should survive it.
 */

import React, { useState } from 'react';
import { X } from 'lucide-react';

const QUANTILES = [
  { value: 0.025, label: 'Lower bound (2.5%)' },
  { value: 0.5, label: 'Median (50%)' },
  { value: 0.975, label: 'Upper bound (97.5%)' },
];

const RegenerateDialog = ({ sections, quantile: initialQuantile, onCancel, onConfirm }) => {
  const [scope, setScope] = useState('all');
  const [selected, setSelected] = useState([]);
  const [overwrite, setOverwrite] = useState(false);
  const [quantile, setQuantile] = useState(
    QUANTILES.some((q) => q.value === initialQuantile) ? initialQuantile : 0.5,
  );

  const editedCount = sections.filter((s) => s.edited_md !== null && s.edited_md !== undefined).length;

  const toggle = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const confirm = () => {
    onConfirm({
      section_ids: scope === 'all' ? 'all' : selected,
      overwrite_edited: overwrite,
      quantile,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col font-inter">
        <div className="flex items-center justify-between px-5 py-3 border-b border-wpGray-200">
          <h3 className="font-outfit font-semibold text-wpBlue">Regenerate sections</h3>
          <button onClick={onCancel} className="p-1 text-wpGray-500 hover:text-wpBlue rounded">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          <p className="text-sm text-wpGray-600 mb-4">
            Rebuilds the text from the current scenario data. Sections you added yourself are left untouched.
          </p>

          <label className="flex items-center gap-2 text-sm text-wpGray-700 mb-2">
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} className="accent-wpBlue" />
            All generated sections
          </label>
          <label className="flex items-center gap-2 text-sm text-wpGray-700 mb-3">
            <input type="radio" checked={scope === 'some'} onChange={() => setScope('some')} className="accent-wpBlue" />
            Only the sections I pick
          </label>

          {scope === 'some' && (
            <div className="mb-4 max-h-56 overflow-y-auto border border-wpGray-200 rounded-lg divide-y divide-wpGray-100">
              {sections.map((section) => (
                <label key={section.id} className="flex items-center gap-2 px-3 py-2 text-sm text-wpGray-700 cursor-pointer hover:bg-wpGray-50">
                  <input
                    type="checkbox"
                    checked={selected.includes(section.id)}
                    onChange={() => toggle(section.id)}
                    className="accent-wpBlue"
                  />
                  {section.title}
                </label>
              ))}
            </div>
          )}

          <label className="block text-sm text-wpGray-700 border-t border-wpGray-200 pt-4 mb-4">
            <span className="block mb-1">Risk quantile</span>
            <select
              value={quantile}
              onChange={(e) => setQuantile(Number(e.target.value))}
              className="w-full px-3 py-2 border border-wpGray-300 rounded-lg text-sm focus:ring-2 focus:ring-wpBlue focus:border-transparent"
            >
              {QUANTILES.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </label>

          <label className="flex items-start gap-2 text-sm text-wpGray-700 border-t border-wpGray-200 pt-4">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="accent-wpBlue mt-0.5"
            />
            <span>
              Discard my manual edits
              {editedCount > 0 && (
                <span className="block text-xs text-amber-700">
                  {editedCount} section{editedCount === 1 ? '' : 's'} currently edited by hand.
                </span>
              )}
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-wpGray-200">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-wpGray-500 hover:text-wpBlue">
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={scope === 'some' && selected.length === 0}
            className="px-4 py-2 bg-wpBlue text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-40"
          >
            Regenerate
          </button>
        </div>
      </div>
    </div>
  );
};

export default RegenerateDialog;
