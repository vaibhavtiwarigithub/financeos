/**
 * Pure rank-correlation and HAC helpers for offline historical runners.
 * No network, database, clock, or application path aliases.
 */
function ranks(values: number[]): number[] {
  const indexed = values
    .map((value, index) => [value, index] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const result = new Array(values.length).fill(0);
  let index = 0;
  while (index < indexed.length) {
    let end = index;
    while (end + 1 < indexed.length && indexed[end + 1][0] === indexed[index][0]) end++;
    const averageRank = (index + end) / 2 + 1;
    for (let cursor = index; cursor <= end; cursor++) {
      result[indexed[cursor][1]] = averageRank;
    }
    index = end + 1;
  }
  return result;
}

function pearson(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) return Number.NaN;
  const n = left.length;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / n;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < n; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  return leftVariance > 0 && rightVariance > 0
    ? covariance / Math.sqrt(leftVariance * rightVariance)
    : Number.NaN;
}

export function spearman(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 3) return Number.NaN;
  return pearson(ranks(left), ranks(right));
}

/** Newey-West standard error of the sample mean using a Bartlett kernel. */
export function neweyWestSEofMean(values: number[], lag: number): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const centered = values.map((value) => value - mean);
  let gamma0 = 0;
  for (const value of centered) gamma0 += value * value;
  gamma0 /= n;
  let longRunVariance = gamma0;
  for (let offset = 1; offset <= Math.min(lag, n - 1); offset++) {
    let covariance = 0;
    for (let index = offset; index < n; index++) {
      covariance += centered[index] * centered[index - offset];
    }
    covariance /= n;
    longRunVariance += 2 * (1 - offset / (lag + 1)) * covariance;
  }
  return longRunVariance > 0 ? Math.sqrt(longRunVariance / n) : Number.NaN;
}
