/**
 * TMDB's vote average is unusable on its own: a title with eight votes averaging
 * 9.0 outranks a well-known film with fifty thousand votes averaging 7.8, and
 * obscure old titles are where thin vote counts cluster. TMDB's own guidance is
 * to require roughly 50 votes before trusting a rating at all.
 *
 * Rather than a hard cutoff (which puts a cliff between 49 and 50 votes), shrink
 * the average toward the global mean in proportion to how little evidence backs
 * it. This is the standard credibility-weighted rating; a thinly-voted title
 * lands near the mean instead of at the top, and a heavily-voted one is left
 * essentially untouched.
 */
const PRIOR_COUNT = 50;
const PRIOR_MEAN = 6.5;

/**
 * TMDB rating adjusted for how many votes back it, on the same 0-10 scale.
 *
 * Returns 0 when there is no rating at all, so sources that carry no vote data
 * (Trakt and Simkl account recommendations) neither gain nor lose from it. An
 * unknown vote count is passed through untouched rather than shrunk: TMDB always
 * reports one, so the only titles missing it are those scored before this
 * existed, and discounting those would quietly empty a rating-filtered row.
 */
export function credibleRating(voteAverage?: number, voteCount?: number): number {
  if (voteAverage === undefined) return 0;
  if (voteCount === undefined) return voteAverage;
  return (voteCount * voteAverage + PRIOR_COUNT * PRIOR_MEAN) / (voteCount + PRIOR_COUNT);
}
