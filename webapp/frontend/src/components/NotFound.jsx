import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { paths } from '../routes';

/**
 * Rendered for any URL that does not match a declared route.
 * Kept intentionally simple — no dependency on Dashboard state or stores.
 */
const NotFound = () => {
  const location = useLocation();
  return (
    <div className="min-h-screen bg-wpGray-100 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm max-w-md w-full p-8 text-center space-y-4">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-wpBrown/40 text-wpBlue">
          <AlertTriangle size={28} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-wpBlue font-outfit">Page not found</h1>
          <p className="text-sm text-gray-500 mt-2">
            The URL{' '}
            <code className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
              {location.pathname}
            </code>{' '}
            does not match any known route.
          </p>
        </div>
        <Link
          to={paths.caseStudies()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-wpBlue hover:bg-wpBlue-800 text-white text-sm font-medium transition-colors"
        >
          <ArrowLeft size={14} /> Back to Case Studies
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
