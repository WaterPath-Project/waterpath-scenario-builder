import React from 'react';

// The single, app-wide inline loading indicator. Inherits the surrounding text
// colour (currentColor) so it blends into buttons, badges and panels alike.
export default function Spinner({ size = 16, className = '', label = 'Loading' }) {
  return (
    <svg
      role="status"
      aria-label={label}
      className={`animate-spin flex-shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
      <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Centered spinner + optional label for panel/section-level loading states.
export function LoadingState({ label, size = 22, className = 'py-10' }) {
  return (
    <div className={`flex items-center justify-center gap-2.5 text-wpBlue ${className}`}>
      <Spinner size={size} />
      {label && <span className="text-sm text-gray-500">{label}</span>}
    </div>
  );
}
