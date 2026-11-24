// The in-house exposition against Prometheus' text format 0.0.4.
import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, Registry, escapeLabelValue, formatValue } from "./prometheus";

describe("Prometheus text exposition", () => {
  it("counters, gauges and histograms in the text format", async () => {
    const reg = new Registry();
    const c = reg.register(new Counter("app_requests_total", "Requests", ["route", "status"]));
    const plain = reg.register(new Counter("app_restarts_total", "Restarts"));
    const g = reg.register(new Gauge("app_queue", "Queue depth"));
    const h = reg.register(new Histogram("app_latency_seconds", "Latency", ["route"], [0.1, 0.5, 1]));
    c.inc({ route: "/a", status: "200" });
    c.inc({ route: "/a", status: "200" }, 2);
    c.inc({ route: "/b", status: "500" });
    g.collect = () => g.set({}, 7);
    for (const v of [0.05, 0.1, 0.3, 2]) h.observe({ route: "/a" }, v);
    expect(plain.value()).toBe(0);
    expect(await reg.render()).toBe(
      [
        "# HELP app_requests_total Requests",
        "# TYPE app_requests_total counter",
        'app_requests_total{route="/a",status="200"} 3',
        'app_requests_total{route="/b",status="500"} 1',
        "# HELP app_restarts_total Restarts",
        "# TYPE app_restarts_total counter",
        "app_restarts_total 0",
        "# HELP app_queue Queue depth",
        "# TYPE app_queue gauge",
        "app_queue 7",
        "# HELP app_latency_seconds Latency",
        "# TYPE app_latency_seconds histogram",
        'app_latency_seconds_bucket{route="/a",le="0.1"} 2',
        'app_latency_seconds_bucket{route="/a",le="0.5"} 3',
        'app_latency_seconds_bucket{route="/a",le="1"} 3',
        'app_latency_seconds_bucket{route="/a",le="+Inf"} 4',
        'app_latency_seconds_sum{route="/a"} 2.45',
        'app_latency_seconds_count{route="/a"} 4',
        "",
      ].join("\n"),
    );
  });

  it("escapes label values and help text as the format says", async () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    const reg = new Registry();
    const c = reg.register(new Counter("x_total", "line one\nline \\ two", ["v"]));
    c.inc({ v: 'say "hi"\n' });
    const text = await reg.render();
    expect(text).toContain("# HELP x_total line one\\nline \\\\ two");
    expect(text).toContain('x_total{v="say \\"hi\\"\\n"} 1');
    // One sample per line: no raw newline leaks from a value.
    expect(text.trim().split("\n")).toHaveLength(3);
  });

  it("special values, and refuses what the format can't hold", () => {
    expect([formatValue(Infinity), formatValue(-Infinity), formatValue(NaN), formatValue(1.5)]).toEqual(["+Inf", "-Inf", "NaN", "1.5"]);
    expect(() => new Counter("bad-name", "x")).toThrow();
    expect(() => new Counter("ok_total", "x", ["le"])).toThrow();
    expect(() => new Histogram("h", "x", [], [1, 1])).toThrow();
    expect(() => new Counter("c_total", "x").inc({}, -1)).toThrow();
    const reg = new Registry();
    reg.register(new Gauge("dup", "x"));
    expect(() => reg.register(new Gauge("dup", "x"))).toThrow();
  });

  it("a gauge whose reading fails leaves the rest of the scrape intact", async () => {
    const reg = new Registry();
    const bad = reg.register(new Gauge("bad", "x"));
    bad.collect = () => Promise.reject(new Error("db away"));
    reg.register(new Counter("good_total", "x")).inc();
    expect(await reg.render()).toContain("good_total 1");
  });
});
