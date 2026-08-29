/** Apple "Cocoa" epoch: 2001-01-01T00:00:00Z, in Unix milliseconds. */
export const APPLE_EPOCH_MS = 978_307_200_000;

/**
 * Convert a chat.db timestamp to Unix milliseconds.
 * Modern macOS stores nanoseconds since 2001-01-01; very old databases stored seconds.
 * Returns undefined for 0/null (Apple uses 0 for "not set").
 */
export function appleTimeToUnixMs(value: number | bigint | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return undefined;
  // Heuristic: anything above 1e12 must be nanoseconds (1e12 s would be the year 33,000).
  const ms = Math.abs(n) > 1e12 ? n / 1e6 : n * 1000;
  return Math.round(ms + APPLE_EPOCH_MS);
}

export function appleTimeToIso(value: number | bigint | null | undefined): string | undefined {
  const ms = appleTimeToUnixMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Inverse, used by tests and the synthetic DB generator. */
export function unixMsToAppleNs(unixMs: number): number {
  return Math.round((unixMs - APPLE_EPOCH_MS) * 1e6);
}
