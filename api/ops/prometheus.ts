// A small Prometheus text exposition (format 0.0.4): counters, gauges and
// histograms with fixed buckets, labels escaped as the format says. In-house, so
// the server carries no metrics dependency of its own.

export type Labels = Record<string, string>;

/** A label value as the text format writes it: backslash, double quote and newline escaped. */
export const escapeLabelValue = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** HELP text escaping: backslash and newline. */
const escapeHelp = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A sample value as the format writes it (+Inf, -Inf, NaN spelled out). */
export function formatValue(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function labelText(labels: Labels): string {
  const keys = Object.keys(labels);
  return keys.length === 0 ? "" : `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",")}}`;
}

abstract class Metric<L extends string> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly L[];
  constructor(name: string, help: string, labelNames: readonly L[] = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    if (!NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
    for (const l of labelNames) if (!LABEL.test(l) || l === "le") throw new Error(`invalid label name: ${l}`);
  }
  abstract readonly type: "counter" | "gauge" | "histogram";
  /** Read just before rendering (scrape-time gauges). */
  collect?: () => void | Promise<void>;
  protected key(labels: Partial<Record<L, string>>): string {
    return JSON.stringify(this.labelNames.map((l) => labels[l] ?? ""));
  }
  protected labelsOf(key: string): Labels {
    const values = JSON.parse(key) as string[];
    return Object.fromEntries(this.labelNames.map((l, i) => [l, values[i]]));
  }
  abstract lines(): string[];
  render(): string {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`, ...this.lines()].join("\n");
  }
}

export class Counter<L extends string = never> extends Metric<L> {
  readonly type = "counter";
  private values = new Map<string, number>();
  inc(labels: Partial<Record<L, string>> = {}, by = 1): void {
    if (by < 0) throw new Error("a counter only goes up");
    const k = this.key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  value(labels: Partial<Record<L, string>> = {}): number {
    return this.values.get(this.key(labels)) ?? 0;
  }
  lines(): string[] {
    if (this.values.size === 0 && this.labelNames.length === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => `${this.name}${labelText(this.labelsOf(k))} ${formatValue(v)}`);
  }
}

export class Gauge<L extends string = never> extends Metric<L> {
  readonly type = "gauge";
  private values = new Map<string, number>();
  set(labels: Partial<Record<L, string>>, value: number): void {
    this.values.set(this.key(labels), value);
  }
  value(labels: Partial<Record<L, string>> = {}): number | undefined {
    return this.values.get(this.key(labels));
  }
  reset(): void {
    this.values.clear();
  }
  lines(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${labelText(this.labelsOf(k))} ${formatValue(v)}`);
  }
}

export class Histogram<L extends string = never> extends Metric<L> {
  readonly type = "histogram";
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly buckets: readonly number[];
  constructor(name: string, help: string, labelNames: readonly L[], buckets: readonly number[]) {
    super(name, help, labelNames);
    this.buckets = buckets;
    if (buckets.some((b, i) => i > 0 && b <= buckets[i - 1])) throw new Error("buckets must increase");
  }
  observe(labels: Partial<Record<L, string>>, value: number): void {
    const k = this.key(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    // Per bucket here; cumulative when written.
    const i = this.buckets.findIndex((b) => value <= b);
    if (i >= 0) s.counts[i]++;
    s.sum += value;
    s.count++;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const labels = this.labelsOf(k);
      let acc = 0;
      this.buckets.forEach((b, i) => {
        acc += s.counts[i];
        out.push(`${this.name}_bucket${labelText({ ...labels, le: formatValue(b) })} ${acc}`);
      });
      out.push(`${this.name}_bucket${labelText({ ...labels, le: "+Inf" })} ${s.count}`);
      out.push(`${this.name}_sum${labelText(labels)} ${formatValue(s.sum)}`);
      out.push(`${this.name}_count${labelText(labels)} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  static readonly contentType = "text/plain; version=0.0.4; charset=utf-8";
  private metrics: Metric<string>[] = [];
  register<M extends Metric<string>>(m: M): M {
    if (this.metrics.some((x) => x.name === m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.metrics.push(m);
    return m;
  }
  /** Every metric as text; a gauge whose reading fails is left empty, never the whole scrape. */
  async render(): Promise<string> {
    await Promise.all(this.metrics.map((m) => Promise.resolve(m.collect?.()).catch(() => undefined)));
    return `${this.metrics.map((m) => m.render()).join("\n")}\n`;
  }
}
