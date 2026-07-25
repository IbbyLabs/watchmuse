import { createLogger } from '../logger.js';
import { TmdbClient } from '../providers/tmdb.js';
import type { Candidate } from '../recommendations/types.js';
import type { LlmClient } from './client.js';

const log = createLogger('ai-rank');

/** Render candidates as a compact numbered list the model can reason over. */
export function candidateList(candidates: Candidate[]): string {
  return candidates
    .map((c) => {
      const genres = (c.genreIds ?? []).map((g) => TmdbClient.genreName(g)).filter(Boolean).join(', ');
      const bits = [c.title ?? `TMDB ${c.tmdbId}`];
      if (c.year) bits.push(`(${c.year})`);
      if (genres) bits.push(`[${genres}]`);
      return `${c.tmdbId}: ${bits.join(' ')}`;
    })
    .join('\n');
}

/**
 * Extract a list of tmdbIds from a model reply. Tolerant of code fences and
 * surrounding prose — pulls the first JSON array of numbers it can find.
 */
export function parseIdList(text: string): number[] {
  const match = /\[[\s\S]*?\]/.exec(text);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  } catch {
    return [];
  }
}

/**
 * Reorder candidates by a model-provided id order. Ids not in the candidate set
 * are ignored; candidates the model omitted are appended in their original order
 * (for rerank) or dropped (for selection), per `keepUnlisted`.
 */
export function applyOrder(candidates: Candidate[], orderedIds: number[], keepUnlisted: boolean): Candidate[] {
  const byId = new Map(candidates.map((c) => [c.tmdbId, c] as const));
  const used = new Set<number>();
  const out: Candidate[] = [];
  for (const id of orderedIds) {
    const c = byId.get(id);
    if (c && !used.has(id)) {
      out.push(c);
      used.add(id);
    }
  }
  if (keepUnlisted) {
    for (const c of candidates) if (!used.has(c.tmdbId)) out.push(c);
  }
  return out;
}

const RERANK_SYSTEM =
  'You reorder movie/show recommendations by how well they match a viewer\'s taste. ' +
  'Reply ONLY with a JSON array of the numeric ids in your preferred order, best first. No prose.';

/**
 * Ask the model to reorder candidates for taste coherence. Defensive: if the
 * reply yields no valid ids, the original (algorithmic) order is returned.
 */
export async function rerank(client: LlmClient, candidates: Candidate[], max = 80): Promise<Candidate[]> {
  const slice = candidates.slice(0, max);
  if (slice.length < 2) return candidates;
  try {
    const reply = await client.complete(RERANK_SYSTEM, `Reorder these:\n${candidateList(slice)}`);
    const ids = parseIdList(reply);
    if (ids.length === 0) {
      log.warn('Rerank returned no ids; keeping algorithmic order');
      return candidates;
    }
    const reordered = applyOrder(slice, ids, true);
    return [...reordered, ...candidates.slice(max)];
  } catch (err) {
    log.warn({ err }, 'Rerank failed; keeping algorithmic order');
    return candidates;
  }
}

/**
 * Ask the model to pick and order the candidates that fit a natural-language
 * prompt. Falls back to the top algorithmic candidates if the reply is unusable,
 * so a natural-language catalog is never empty due to a bad model response.
 */
export async function selectForPrompt(
  client: LlmClient,
  prompt: string,
  candidates: Candidate[],
  max = 100,
): Promise<Candidate[]> {
  const slice = candidates.slice(0, Math.max(max, 120));
  if (slice.length === 0) return [];
  const system =
    'You curate a themed list from a candidate pool of movies/shows. Pick the ids that fit the ' +
    "viewer's request and order them best-first. Reply ONLY with a JSON array of numeric ids. No prose.";
  try {
    const reply = await client.complete(system, `Request: ${prompt}\n\nCandidates:\n${candidateList(slice)}`);
    const ids = parseIdList(reply);
    if (ids.length === 0) {
      log.warn('NL select returned no ids; falling back to top candidates');
      return candidates.slice(0, max);
    }
    return applyOrder(slice, ids, false).slice(0, max);
  } catch (err) {
    log.warn({ err }, 'NL select failed; falling back to top candidates');
    return candidates.slice(0, max);
  }
}
