// TEST-ONLY reproduction of the reviewed v1 stoplist (tokenizer v1), kept to
// demonstrate the H1 regression it caused. Production code uses STOPWORDS_V2
// only. Its SHA-256 equals the stopword hash recorded in the archived reviewed
// v1 manifest (evals/aven-007/reviewed-v1/manifest.json).
import { sStem } from '../src/index.ts';

export const STOPWORDS_V1_FIXTURE: readonly string[] = Object.freeze(
  'a about above after again all also am an and any are as at be because been before being below between both but by can could d did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just ll m may me might more most must my myself no nor not now of off on once only or other our ours ourselves out over own please re s same shall she should so some such t than that the their theirs them themselves then there these they this those through to too under until up us ve very was we were what when where which while who whom why will with would you your yours yourself yourselves'.split(
    ' ',
  ),
);

/** v1 pipeline: NFKC, lowercase, split, stopword removal, S stemmer (no contraction expansion). */
export function tokenizeWithStopwords(
  stopwords: readonly string[],
  text: string,
): string[] {
  const stop = new Set(stopwords);
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0 && !stop.has(t))
    .map(sStem);
}
