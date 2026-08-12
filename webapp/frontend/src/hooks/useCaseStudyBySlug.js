import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { csSlug } from '../routes';

/**
 * Shared cache and in-flight promise so multiple mounted hooks share a single
 * `/api/case-studies` request. This is intentionally a module-level cache
 * because case studies rarely change during a session and every view that
 * needs slug→id resolution benefits from a warm cache.
 */
let cachedCaseStudies = null; // array or null
let inFlight = null; // Promise<array>

const fetchCaseStudies = () => {
  if (cachedCaseStudies) return Promise.resolve(cachedCaseStudies);
  if (inFlight) return inFlight;
  inFlight = axios
    .get('/api/case-studies')
    .then((res) => {
      cachedCaseStudies = res.data?.case_studies || [];
      return cachedCaseStudies;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/**
 * Resolve a `csSlug` (as it appears in the URL) to a full case-study object.
 * If a `providedList` is passed (e.g. from `Dashboard`'s already-fetched
 * caseStudies state), it's searched first without triggering a network call.
 *
 * Returns `{ loading, caseStudy, allCaseStudies }`.
 */
export default function useCaseStudyBySlug(slug, providedList = null) {
  const [list, setList] = useState(() => providedList || cachedCaseStudies || []);
  const [loading, setLoading] = useState(
    !providedList && !cachedCaseStudies && !!slug,
  );

  // Adopt the provided list if it's non-empty and different from cache.
  useEffect(() => {
    if (providedList && providedList.length) {
      setList(providedList);
      cachedCaseStudies = providedList;
      setLoading(false);
    }
  }, [providedList]);

  // Kick off a fetch if we don't have data and a slug is expected.
  useEffect(() => {
    if (!slug) {
      setLoading(false);
      return;
    }
    if (list && list.length) return; // already have data
    setLoading(true);
    let cancelled = false;
    fetchCaseStudies().then((cs) => {
      if (cancelled) return;
      setList(cs);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, list]);

  const caseStudy = useMemo(() => {
    if (!slug || !list?.length) return null;
    return list.find((cs) => csSlug(cs) === slug) || null;
  }, [slug, list]);

  return { loading, caseStudy, allCaseStudies: list };
}
