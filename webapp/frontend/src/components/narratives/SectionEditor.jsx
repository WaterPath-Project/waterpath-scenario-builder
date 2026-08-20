/**
 * SectionEditor.jsx
 * =================
 *
 * One report section: preview by default, Markdown textarea when editing.
 * `edited_md` always wins over `generated_md`; reverting clears it so the
 * section follows the generator again.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Undo2, Check, X } from 'lucide-react';

const KIND_BADGES = {
  intro: 'Introduction',
  driver_table: 'Reference table',
  driver: 'Driver',
  map: 'Result map',
  risk: 'Risk',
  summary: 'Summary',
  appendix: 'Appendix',
  custom: 'Custom',
};

const SectionEditor = ({ section, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);

  const text = section.edited_md ?? section.generated_md ?? '';
  const isEdited = section.edited_md !== null && section.edited_md !== undefined;

  useEffect(() => {
    if (editing && textareaRef.current) textareaRef.current.focus();
  }, [editing]);

  const startEditing = () => {
    setDraft(text);
    setEditing(true);
  };

  const save = () => {
    onChange({ ...section, edited_md: draft });
    setEditing(false);
  };

  const revert = () => {
    onChange({ ...section, edited_md: null });
    setEditing(false);
  };

  return (
    <div
      className={`border rounded-lg mb-3 ${
        section.include === false ? 'border-wpGray-200 bg-wpGray-50 opacity-60' : 'border-wpGray-200'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-2 border-b border-wpGray-200 bg-wpGray-50 rounded-t-lg">
        <input
          type="checkbox"
          checked={section.include !== false}
          onChange={(e) => onChange({ ...section, include: e.target.checked })}
          className="accent-wpBlue"
          title="Include this section in the report"
        />
        <span className="text-sm font-medium text-wpBlue">{section.title}</span>
        <span className="text-[10px] uppercase tracking-wide text-wpGray-400 border border-wpGray-300 rounded px-1.5 py-0.5">
          {KIND_BADGES[section.kind] || section.kind}
        </span>
        {isEdited && (
          <span className="text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            Edited
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <button onClick={save} className="p-1.5 text-green-700 hover:bg-green-50 rounded" title="Save changes">
                <Check size={15} />
              </button>
              <button onClick={() => setEditing(false)} className="p-1.5 text-wpGray-500 hover:bg-wpGray-100 rounded" title="Discard changes">
                <X size={15} />
              </button>
            </>
          ) : (
            <>
              <button onClick={startEditing} className="p-1.5 text-wpGray-500 hover:text-wpBlue hover:bg-wpGray-100 rounded" title="Edit text">
                <Pencil size={15} />
              </button>
              {isEdited && (
                <button onClick={revert} className="p-1.5 text-wpGray-500 hover:text-wpBlue hover:bg-wpGray-100 rounded" title="Revert to generated text">
                  <Undo2 size={15} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(24, Math.max(6, draft.split('\n').length + 2))}
            className="w-full font-mono text-xs leading-relaxed px-3 py-2 border border-wpGray-300 rounded-lg focus:ring-2 focus:ring-wpBlue focus:border-transparent"
          />
        ) : (
          <div className="report-markdown text-sm text-wpGray-700 leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
};

export default SectionEditor;
