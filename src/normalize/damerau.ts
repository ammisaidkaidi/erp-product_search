/**
 * Damerau-Levenshtein (optimal string alignment) distance with early cutoff.
 * Used for conservative typo correction against a bounded vocabulary.
 */

export function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a === b) return 0;

  const lenA = a.length;
  const lenB = b.length;
  // row[i] = distance between a[:i] and current b prefix
  let prevPrev = new Int32Array(lenA + 1);
  let prev = new Int32Array(lenA + 1);
  let current = new Int32Array(lenA + 1);

  for (let i = 0; i <= lenA; i++) prev[i] = i;

  for (let j = 1; j <= lenB; j++) {
    current[0] = j;
    let rowMin = current[0]!;
    const bj = b[j - 1]!;
    for (let i = 1; i <= lenA; i++) {
      const cost = a[i - 1] === bj ? 0 : 1;
      let value = Math.min(
        current[i - 1]! + 1, // insertion
        prev[i]! + 1, // deletion
        prev[i - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === bj) {
        value = Math.min(value, prevPrev[i - 2]! + 1); // transposition
      }
      current[i] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1; // early exit
    const swap = prevPrev;
    prevPrev = prev;
    prev = current;
    current = swap;
  }
  const distance = prev[lenA]!;
  return distance > maxDistance ? maxDistance + 1 : distance;
}

export interface BestMatch {
  word: string;
  distance: number;
  /** true when the winner is strictly closer than any runner-up (correction-safe) */
  unique: boolean;
}

/**
 * Find the closest vocabulary word within maxDistance. A correction is only
 * "unique" when exactly one candidate achieves the best distance — ambiguous
 * matches are left uncorrected (conservative by design).
 */
export function closestWord(input: string, vocabulary: Iterable<string>, maxDistance: number): BestMatch | null {
  let best: BestMatch | null = null;
  let runnerUpDistance = Infinity;
  for (const word of vocabulary) {
    if (word === input) return { word, distance: 0, unique: true };
    const distance = damerauLevenshtein(input, word, maxDistance);
    if (distance > maxDistance) continue;
    if (best === null || distance < best.distance) {
      if (best !== null) runnerUpDistance = best.distance;
      best = { word, distance, unique: true };
    } else if (distance === best.distance) {
      best.unique = false;
    } else if (distance < runnerUpDistance) {
      runnerUpDistance = distance;
    }
  }
  if (best && runnerUpDistance <= best.distance) best.unique = false;
  return best;
}
