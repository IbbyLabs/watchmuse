/**
 * Daily reordering for catalog rows.
 *
 * Scoring is deterministic, so a row that is not rebuilt looks identical every
 * time someone opens Stremio, and a row that never moves reads as broken even
 * when the picks behind it are good. Reshuffling from a date-derived seed makes
 * the row visibly alive while staying stable within a day, so a title someone
 * spotted at breakfast is still there at dinner.
 *
 * The strongest few positions are pinned. A plain shuffle would let the best
 * pick of the day sink below the fold, which trades one problem for a worse one.
 */

/**
 * Positions held in score order. Small on purpose: Stremio's board only ever
 * shows around ten items, so pinning many would leave nothing visibly moving.
 */
const PINNED = 3;

/** FNV-1a. Small, fast, and stable across runs — unlike a hash built on Date. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Local calendar date as YYYY-MM-DD, the granularity the shuffle turns over at. */
function dayStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * A seed that changes once a day and differs per catalog, so two rows do not
 * permute in lockstep.
 */
export function dailySeed(salt: string, now: Date = new Date()): number {
  return hash(`${dayStamp(now)}:${salt}`);
}

/** mulberry32 — a compact PRNG with a good enough distribution for shuffling. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Return a copy with the first `pinned` items untouched and the rest shuffled
 * deterministically from `seed`. Same seed and input always give the same order.
 */
export function elitistShuffle<T>(
  items: readonly T[],
  seed: number,
  pinned: number = PINNED,
): T[] {
  const head = items.slice(0, pinned);
  const tail = items.slice(pinned);
  const random = prng(seed);
  // Fisher-Yates over the tail only.
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tail[i], tail[j]] = [tail[j]!, tail[i]!];
  }
  return [...head, ...tail];
}
