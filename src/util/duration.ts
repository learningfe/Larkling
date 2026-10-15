const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(value: string, field: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`${field} must be a duration like 30s, 15m, or 7d`);
  return Number(match[1]) * UNITS[match[2]];
}
