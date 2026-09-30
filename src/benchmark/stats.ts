/** Small statistics helpers used by the benchmark harness. */

export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}

export function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((s, v) => s + v, 0) / samples.length;
}
