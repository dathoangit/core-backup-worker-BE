/**
 * Half-open exclusive lower / inclusive upper: (saved, captured].
 * First run (saved null) uses fromExclusive = 0n so ids start at 1.
 */
export function buildIdRange(
  saved: bigint | null,
  captured: bigint,
): { fromExclusive: bigint; toInclusive: bigint } | null {
  if (captured < 0n) {
    throw new Error(`captured watermark must be >= 0, got ${captured}`);
  }

  const fromExclusive = saved ?? 0n;

  if (captured <= fromExclusive) {
    return null;
  }

  return { fromExclusive, toInclusive: captured };
}

export function splitIdRange(
  range: { fromExclusive: bigint; toInclusive: bigint },
  chunkSize: bigint,
): Array<{ fromExclusive: bigint; toInclusive: bigint }> {
  if (chunkSize <= 0n) {
    throw new Error(`chunkSize must be > 0, got ${chunkSize}`);
  }

  const chunks: Array<{ fromExclusive: bigint; toInclusive: bigint }> = [];
  let cursor = range.fromExclusive;

  while (cursor < range.toInclusive) {
    const next = cursor + chunkSize;
    const toInclusive =
      next < range.toInclusive ? next : range.toInclusive;
    chunks.push({ fromExclusive: cursor, toInclusive });
    cursor = toInclusive;
  }

  return chunks;
}

export function parseWatermark(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return BigInt(value);
}

export function formatWatermark(value: bigint): string {
  return value.toString();
}

export function chunkKey(
  schema: string,
  table: string,
  fromExclusive: bigint,
  toInclusive: bigint,
): string {
  return `${schema}.${table}:${fromExclusive}:${toInclusive}`;
}
