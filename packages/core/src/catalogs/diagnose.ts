import { applyCatalogFilter } from './filter.js';
import type { Candidate } from '../recommendations/types.js';
import type { CatalogDef } from './types.js';

/** One filter of a catalog, and how much of the pool it is responsible for cutting. */
export interface ConstraintReport {
  /** Which filter this is, for the UI to label. */
  key: 'mediaType' | 'genres' | 'years' | 'minRating' | 'providers' | 'sources';
  /** How many titles the catalog would hold if only this filter were lifted. */
  withoutThis: number;
}

export interface CatalogDiagnosis {
  /** Titles the catalog actually serves. */
  matched: number;
  /** Titles in the pool before any of the catalog's filters. */
  pool: number;
  /** Active filters, worst offender first. Empty when nothing is filtered. */
  constraints: ConstraintReport[];
}

/** The catalog with one filter lifted, leaving everything else in place. */
function without(def: CatalogDef, key: ConstraintReport['key']): CatalogDef {
  const filter = { ...(def.filter ?? {}) };
  switch (key) {
    case 'mediaType':
      return { ...def, mediaType: 'both' };
    case 'sources':
      return { ...def, sources: [] };
    case 'genres':
      delete filter.genres;
      break;
    case 'years':
      delete filter.yearMin;
      delete filter.yearMax;
      break;
    case 'minRating':
      delete filter.minRating;
      break;
    case 'providers':
      delete filter.providers;
      break;
  }
  return { ...def, filter };
}

/** Which of the catalog's filters are actually doing something. */
function activeKeys(def: CatalogDef): ConstraintReport['key'][] {
  const f = def.filter ?? {};
  const keys: ConstraintReport['key'][] = [];
  if (def.mediaType !== 'both') keys.push('mediaType');
  if (f.genres?.length) keys.push('genres');
  if (f.yearMin !== undefined || f.yearMax !== undefined) keys.push('years');
  if (f.minRating !== undefined) keys.push('minRating');
  if (f.providers?.length) keys.push('providers');
  if (def.sources.length) keys.push('sources');
  return keys;
}

/**
 * Explain how a catalog's filters narrow the pool.
 *
 * A catalog draws on the titles the user's own history surfaced, so a filter
 * for something they do not watch can leave the row nearly empty however large
 * the pool is. Lifting one filter at a time and re-counting shows which one is
 * actually responsible, which is the difference between "this is broken" and
 * "loosen the rating floor".
 *
 * Counting is done by re-running the real filter, so this cannot drift from
 * what the catalog serves.
 */
export function diagnoseCatalog(
  candidates: Candidate[],
  def: CatalogDef,
  exclude?: ReadonlySet<string>,
): CatalogDiagnosis {
  const matched = applyCatalogFilter(candidates, def, exclude).length;
  const constraints = activeKeys(def)
    .map((key) => ({
      key,
      withoutThis: applyCatalogFilter(candidates, without(def, key), exclude).length,
    }))
    // Biggest gain first: the filter whose removal helps most is the one to relax.
    .sort((a, b) => b.withoutThis - a.withoutThis);

  return { matched, pool: candidates.length, constraints };
}
