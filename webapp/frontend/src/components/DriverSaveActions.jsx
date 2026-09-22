import React from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, Save } from 'lucide-react';

export default function DriverSaveActions({ target, isDirty, isSaving, onReset, onSave, canSave = true, disabledTitle = '' }) {
  if (!target || !isDirty) return null;

  return createPortal(
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="w-2 h-2 rounded-full bg-orange-400" title="Unsaved changes" />
      <button
        type="button"
        onClick={onReset}
        className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
        title="Reset to last saved values"
      >
        <RotateCcw size={16} /> Reset
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={isSaving || !canSave}
        title={!canSave ? disabledTitle : 'Save changes'}
        className="flex items-center gap-2 min-w-[92px] justify-center px-4 py-2 text-sm font-semibold text-wpBlue bg-wpGreen border border-wpGreen rounded-lg shadow-sm hover:bg-wpGreen-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Save size={16} /> {isSaving ? 'Saving…' : 'Save'}
      </button>
    </div>,
    target
  );
}
