import { runLoop } from "../loop";
import { createNoise3, mulberry32 } from "./rng";
import type { Scene, ScenePalette } from "./types";

/**
 * Ink in water: drops bloom on the paper, their particles carried by a slow curl-noise
 * current, a few curling tentacles each; after a few minutes the water washes the
 * paper clean and new drops fall. Everything follows the seed.
 */

const PARTICLES = 700;
const TENTACLES = 6;
const MAX_DROPS = 3;
const FPS = 30;
const WASH_SECONDS = 5;

type Drop = {
  /** Where it fell. */
  cx: number;
  cy: number;
  born: number;
  life: number;
  tentacleLife: number;
  ink: string;
  /** x, y per particle. */
  ps: Float32Array;
  /** Outward push per particle (px/s at birth). */
  push: Float32Array;
  /** x, y, heading per tentacle. */
  ts: Float32Array;
};

type World = {
  /** One step of `dt` seconds, drawn into `g`. */
  step(g: CanvasRenderingContext2D, dt: number): void;
  /** Seconds simulated so far. */
  time(): number;
};

function world(width: number, height: number, seed: number, palette: ScenePalette): World {
  const rand = mulberry32(seed);
  const noise = createNoise3(rand);
  const between = (a: number, b: number) => a + (b - a) * rand();
  const size = Math.min(width, height);
  // The current: wide, slow swirls (smaller field scale = wider swirls).
  const field = 1 / (size * between(0.28, 0.45));
  const flow = between(26, 42);
  const drift = between(0.025, 0.05);
  const inks = palette.inks.slice(0, Math.max(1, palette.inks.length - 1));
  const tentacleInk = palette.inks[palette.inks.length - 1] ?? palette.paper;

  let t = 0;
  let drops: Drop[] = [];
  let nextDrop = 0.4;
  let washFrom = between(150, 210);

  const curl = (x: number, y: number, out: Float32Array) => {
    const u = x * field;
    const v = y * field;
    const z = t * drift;
    const e = 0.02;
    const dy = noise(u, v + e, z) - noise(u, v - e, z);
    const dx = noise(u + e, v, z) - noise(u - e, v, z);
    out[0] = (dy / (2 * e)) * flow;
    out[1] = (-dx / (2 * e)) * flow;
  };

  const spawn = () => {
    // Away from the edges: the bloom needs room.
    const cx = between(0.15, 0.85) * width;
    const cy = between(0.18, 0.82) * height;
    const ps = new Float32Array(PARTICLES * 2);
    const push = new Float32Array(PARTICLES);
    const r0 = between(4, 14);
    for (let i = 0; i < PARTICLES; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * r0;
      ps[i * 2] = cx + Math.cos(a) * r;
      ps[i * 2 + 1] = cy + Math.sin(a) * r;
      push[i] = between(40, 150);
    }
    const ts = new Float32Array(TENTACLES * 3);
    const turn = rand() * Math.PI * 2;
    for (let i = 0; i < TENTACLES; i++) {
      ts[i * 3] = cx;
      ts[i * 3 + 1] = cy;
      ts[i * 3 + 2] = turn + (i / TENTACLES) * Math.PI * 2 + between(-0.3, 0.3);
    }
    drops.push({
      cx,
      cy,
      born: t,
      life: between(26, 38),
      tentacleLife: between(7, 11),
      ink: inks[Math.floor(rand() * inks.length)] ?? palette.paper,
      ps,
      push,
      ts,
    });
  };

  const v = new Float32Array(2);

  return {
    time: () => t,
    step(g, dt) {
      t += dt;
      const washing = t >= washFrom;
      if (washing) {
        g.globalAlpha = Math.min(1, 1.8 * dt);
        g.fillStyle = palette.paper;
        g.fillRect(0, 0, width, height);
        if (t >= washFrom + WASH_SECONDS) {
          // A clean sheet: what fading leaves behind goes too.
          g.globalAlpha = 1;
          g.fillRect(0, 0, width, height);
          drops = [];
          washFrom = t + between(150, 210);
          nextDrop = t + 1;
        }
      } else if (t >= nextDrop && drops.length < MAX_DROPS) {
        spawn();
        nextDrop = t + between(8, 15);
      }

      drops = drops.filter(d => t - d.born < d.life);
      // Butt ends: each frame adds a segment, and round ends overlapping at low alpha read as beads.
      g.lineCap = "butt";
      for (const d of drops) {
        const age = t - d.born;
        const k = age / d.life;
        const pushNow = Math.exp(-age * 0.9);
        g.strokeStyle = d.ink;
        g.globalAlpha = 0.11 * Math.pow(1 - k, 0.7);
        g.lineWidth = 2.4 - 1.9 * k;
        g.beginPath();
        const { cx, cy } = d;
        for (let i = 0; i < PARTICLES; i++) {
          const x = d.ps[i * 2];
          const y = d.ps[i * 2 + 1];
          curl(x, y, v);
          // Outward from where the drop fell, fading: the bloom.
          const ox = x - cx;
          const oy = y - cy;
          const ol = Math.hypot(ox, oy) || 1;
          const p = d.push[i] * pushNow;
          const nx = x + (v[0] + (ox / ol) * p) * dt;
          const ny = y + (v[1] + (oy / ol) * p) * dt;
          g.moveTo(x, y);
          g.lineTo(nx, ny);
          d.ps[i * 2] = nx;
          d.ps[i * 2 + 1] = ny;
        }
        g.stroke();

        if (age < d.tentacleLife) {
          const tk = age / d.tentacleLife;
          g.strokeStyle = tentacleInk;
          g.globalAlpha = 0.16 * Math.pow(1 - tk, 0.8);
          g.lineWidth = 3.2 * Math.pow(1 - tk, 1.3) + 0.3;
          g.beginPath();
          for (let i = 0; i < TENTACLES; i++) {
            const x = d.ts[i * 3];
            const y = d.ts[i * 3 + 1];
            curl(x, y, v);
            const h0 = d.ts[i * 3 + 2];
            // Curling, every other one the other way, tighter towards the tip; the current bends it too.
            const side = i % 2 === 0 ? 1 : -1;
            const across = (Math.cos(h0) * v[1] - Math.sin(h0) * v[0]) / flow;
            const h = h0 + (side * (0.25 + 0.8 * tk) + across * 0.5) * dt;
            const speed = 52 * (1 - tk * 0.5);
            const nx = x + (Math.cos(h) * speed + v[0] * 0.5) * dt;
            const ny = y + (Math.sin(h) * speed + v[1] * 0.5) * dt;
            g.moveTo(x, y);
            g.lineTo(nx, ny);
            d.ts[i * 3] = nx;
            d.ts[i * 3 + 1] = ny;
            d.ts[i * 3 + 2] = h;
          }
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    },
  };
}

/** How long a still picture (reduced motion) is composed for, and how long it stays. */
const STILL_SECONDS = 45;
const STILL_HOLD_MS = 60_000;
/** Work per frame while composing a still picture: the page never stutters for it. */
const BUDGET_MS = 6;

export const ink: Scene = {
  id: "ink",
  start(canvas, { seed, reducedMotion, palette }) {
    const g = canvas.getContext("2d");
    if (!g) return { stop: () => {} };
    const scale = canvas.width / Math.max(1, canvas.clientWidth);
    const width = canvas.width / scale;
    const height = canvas.height / scale;
    const paint = (target: CanvasRenderingContext2D) => {
      target.setTransform(scale, 0, 0, scale, 0, 0);
      target.globalAlpha = 1;
      target.fillStyle = palette.paper;
      target.fillRect(0, 0, width, height);
    };
    paint(g);

    if (!reducedMotion) {
      const w = world(width, height, seed, palette);
      return { stop: runLoop(FPS, dt => w.step(g, dt)) };
    }

    // Reduced motion: each picture composed out of sight, a little per frame, then shown at once.
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const og = off.getContext("2d");
    if (!og) return { stop: () => {} };
    let round = 0;
    let w = world(width, height, seed, palette);
    let hold: ReturnType<typeof setTimeout> | undefined;
    let stopLoop: (() => void) | undefined;
    const compose = () => {
      paint(og);
      stopLoop = runLoop(FPS, () => {
        const until = performance.now() + BUDGET_MS;
        while (w.time() < STILL_SECONDS && performance.now() < until) w.step(og, 1 / FPS);
        if (w.time() < STILL_SECONDS) return;
        stopLoop?.();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(off, 0, 0);
        hold = setTimeout(() => {
          round += 1;
          w = world(width, height, (seed + round * 0x9e3779b9) >>> 0, palette);
          compose();
        }, STILL_HOLD_MS);
      });
    };
    compose();
    return {
      stop: () => {
        stopLoop?.();
        clearTimeout(hold);
      },
    };
  },
};
