type MetricTags = Record<string, string | number | boolean | undefined>;

interface CounterKey {
  name: string;
  tags: MetricTags;
}

const counters = new Map<string, number>();
const timings = new Map<string, number[]>();

function buildKey(name: string, tags: MetricTags): string {
  const sorted = Object.entries(tags)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `${name}:${JSON.stringify(sorted)}`;
}

export function incrementCounter(name: string, tags: MetricTags = {}): void {
  const key = buildKey(name, tags);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function recordTiming(
  name: string,
  valueMs: number,
  tags: MetricTags = {},
): void {
  const key = buildKey(name, tags);
  const values = timings.get(key) ?? [];
  values.push(valueMs);
  timings.set(key, values);
}

export function getMetricSnapshot(): {
  counters: Record<string, number>;
  timings: Record<string, { count: number; avgMs: number; p95Ms: number }>;
} {
  const counterJson: Record<string, number> = {};
  for (const [key, value] of counters.entries()) {
    counterJson[key] = value;
  }
  const timingJson: Record<
    string,
    { count: number; avgMs: number; p95Ms: number }
  > = {};
  for (const [key, values] of timings.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const avgMs =
      count === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / count;
    const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
    timingJson[key] = {
      count,
      avgMs,
      p95Ms: sorted[p95Index] ?? 0,
    };
  }
  return {
    counters: counterJson,
    timings: timingJson,
  };
}
