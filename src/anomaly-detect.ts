// Detects whether a value is an outlier against a set of historical values, using a modified
// z-score built on the Median Absolute Deviation (MAD) — Iglewicz & Hoaglin's standard robust
// alternative to a mean/standard-deviation z-score. MAD resists being dragged around by a single
// unusual historical month or transaction, which a plain mean/stddev test would not.

export type AnomalyDirection = "high" | "low"

export interface AnomalyResult {
  isAnomaly: boolean
  direction: AnomalyDirection | null
  median: number
  modifiedZScore: number
}

export interface AnomalyOptions {
  // Minimum number of historical data points required before a value can be judged at all.
  minHistoryCount: number
  // Minimum absolute difference from the historical median before a value can be judged an
  // anomaly, regardless of how large its z-score is — keeps trivial dollar swings on small
  // categories from counting as "anomalies" just because they're a large percentage move.
  minDeviationCents: number
}

export const DEFAULT_MIN_HISTORY_COUNT = 3
export const DEFAULT_MIN_DEVIATION_CENTS = 5000 // $50.00

const MODIFIED_Z_SCORE_THRESHOLD = 3.5
const MODIFIED_Z_SCORE_CONSTANT = 0.6745

// Function to compute the median of a list of numbers
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number)
}

// Function to compute the median absolute deviation of a list of numbers around a given center
export function medianAbsoluteDeviation(values: readonly number[], aroundMedian: number): number {
  return median(values.map((value) => Math.abs(value - aroundMedian)))
}

// Function to test whether `value` is an outlier against `historicalValues`. All values are
// expected in the same unit (e.g. cents of "amount spent", already sign-flipped positive) so
// "high" means value > the historical median and "low" means value < it.
export function detectAnomaly(
  value: number,
  historicalValues: readonly number[],
  options: AnomalyOptions = { minHistoryCount: DEFAULT_MIN_HISTORY_COUNT, minDeviationCents: DEFAULT_MIN_DEVIATION_CENTS },
): AnomalyResult {
  if (historicalValues.length < options.minHistoryCount) {
    return { isAnomaly: false, direction: null, median: 0, modifiedZScore: 0 }
  }

  const historicalMedian = median(historicalValues)
  const deviation = value - historicalMedian
  if (Math.abs(deviation) < options.minDeviationCents) {
    return { isAnomaly: false, direction: null, median: historicalMedian, modifiedZScore: 0 }
  }

  const mad = medianAbsoluteDeviation(historicalValues, historicalMedian)
  // A MAD of zero means every historical value was identical (e.g. a fixed subscription amount).
  // The deviation has already cleared the dollar floor above, so treat it as anomalous outright
  // rather than dividing by zero.
  const modifiedZScore = mad === 0 ? Infinity * Math.sign(deviation) : (MODIFIED_Z_SCORE_CONSTANT * deviation) / mad

  const isAnomaly = Math.abs(modifiedZScore) > MODIFIED_Z_SCORE_THRESHOLD
  return {
    isAnomaly,
    direction: isAnomaly ? (deviation > 0 ? "high" : "low") : null,
    median: historicalMedian,
    modifiedZScore,
  }
}
