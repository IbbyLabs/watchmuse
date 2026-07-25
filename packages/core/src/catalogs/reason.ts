import type { Candidate } from '../recommendations/types.js';
import type { ProviderId } from '../providers/types.js';

/**
 * The "why recommended" line shown above a title's synopsis.
 *
 * It goes in the item description rather than the row title because row titles
 * live in the manifest, and Stremio is not reliable about refetching a
 * third-party manifest — a reason there could sit frozen on a stale title long
 * after the recommendation changed.
 */

const PROVIDER_LABEL: Record<ProviderId, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  mdblist: 'MDBList',
  pmdb: 'PMDB',
  letterboxd: 'Letterboxd',
  stremio: 'Stremio',
};

/** Join titles the way a person would: "A", "A and B". */
function list(titles: readonly string[]): string {
  return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0]!;
}

/**
 * A sentence explaining why this title was recommended, or null when there is
 * nothing honest to say. Never guesses: a candidate with no named seed and no
 * originating service gets no line rather than a vague one.
 */
export function recommendationReason(c: Candidate): string | null {
  if (c.seedTitles?.length) {
    // "Loved" is only claimed when the user actually rated the seed highly;
    // otherwise all we know is that they watched it.
    const verb = c.fromLovedSeed ? 'loved' : 'watched';
    return `Because you ${verb} ${list(c.seedTitles)}`;
  }

  const from = c.fromProviders?.filter((p) => PROVIDER_LABEL[p]);
  if (from?.length) return `From your ${list(from.map((p) => PROVIDER_LABEL[p]))} recommendations`;

  return null;
}

/** The reason line prepended to a synopsis, for a Stremio meta description. */
export function describeWithReason(c: Candidate): string | undefined {
  const reason = recommendationReason(c);
  if (!reason) return c.overview;
  return c.overview ? `${reason}.\n\n${c.overview}` : `${reason}.`;
}
