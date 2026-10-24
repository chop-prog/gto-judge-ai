import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, angle, pickSide, oneEuro, createJudge } from '../src/judge.js';

const FPS = 30;
const STRAIGHT = 172; // elbow angle with the arms straight
const BODY_OK = 176; // shoulder–hip–ankle line of a straight body

/** Elbow and body angles frame by frame for one repetition: straight → bent to `low` → straight. */
function rep(low, { body = BODY_OK, frames = 36 } = {}) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const k = (1 - Math.cos((2 * Math.PI * i) / frames)) / 2; // 0 → 1 → 0
    out.push([STRAIGHT - (STRAIGHT - low) * k, BODY_OK - (BODY_OK - body) * k]);
  }
  return out;
}
const hold = (frames = 15, elbow = STRAIGHT, body = BODY_OK) => Array.from({ length: frames }, () => [elbow, body]);

/** Feed frames at 30 fps; returns the judge state and every event in order. */
function run(cfg, frames, noise = null) {
  const judge = createJudge(cfg);
  const events = [];
  frames.forEach(([e, b], i) => {
    const n = noise ? noise() : 0;
    const ev = judge.step(e + n, b + n, (i * 1000) / FPS);
    if (ev) events.push(ev);
  });
  return { st: judge.st, events };
}

/** Small deterministic random generator, so the noisy tests always see the same noise. */
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test('angle: right angle, straight line, and degenerate points', () => {
  assert.equal(Math.round(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })), 90);
  assert.equal(Math.round(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 180);
  assert.equal(Math.round(angle({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 45);
  assert.ok(Number.isNaN(angle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })));
});

test('nothing counts until the start position (arms straight) is taken', () => {
  const { st, events } = run(MODES.pushup, [...hold(20, 80), ...hold(10, 120)]);
  assert.equal(st.phase, 'wait');
  assert.equal(st.ok + st.bad, 0);
  assert.equal(events.length, 0);
});

test('push-ups: deep reps with a straight body are counted', () => {
  const { st, events } = run(MODES.pushup, [...hold(), ...rep(70), ...rep(80), ...rep(75), ...hold()]);
  assert.equal(events[0].type, 'ready');
  assert.equal(st.ok, 3);
  assert.equal(st.bad, 0);
});

test('push-ups: a shallow rep is rejected and says why', () => {
  const { st, events } = run(MODES.pushup, [...hold(), ...rep(70), ...rep(120), ...hold()]);
  assert.equal(st.ok, 1);
  assert.equal(st.bad, 1);
  const bad = events.find((e) => e.type === 'bad');
  assert.equal(bad.reason, 'shallow');
  assert.match(bad.text, /руки согнуты мало/);
});

test('push-ups: a sagging body is rejected even when the rep is deep', () => {
  const { st, events } = run(MODES.pushup, [...hold(), ...rep(70, { body: 140 }), ...hold()]);
  assert.equal(st.ok, 0);
  assert.equal(st.bad, 1);
  assert.equal(events.find((e) => e.type === 'bad').reason, 'body');
});

test('arm curl demo ignores the body line', () => {
  const { st } = run(MODES.arm, [...hold(), ...rep(50, { body: 90 }), ...rep(40, { body: 90 }), ...hold()]);
  assert.equal(st.ok, 2);
  assert.equal(st.bad, 0);
});

test('noisy pose estimates (±4° per frame) still give the exact count', () => {
  const r = rng(7);
  const frames = [...hold()];
  for (let i = 0; i < 10; i++) frames.push(...rep(i % 3 === 2 ? 125 : 72));
  frames.push(...hold());
  const { st } = run(MODES.pushup, frames, () => (r() - 0.5) * 8);
  assert.equal(st.ok, 7, 'seven deep reps');
  assert.equal(st.bad, 3, 'three shallow reps');
});

test('a fast rep (under a second) is still caught', () => {
  const { st } = run(MODES.pushup, [...hold(), ...rep(70, { frames: 24 }), ...rep(70, { frames: 24 }), ...hold()]);
  assert.equal(st.ok, 2);
});

test('pickSide: takes the better visible side, but does not flip on small differences', () => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.2 }));
  for (const i of [12, 14, 16, 24, 28]) lm[i].visibility = 0.9; // right side clearly visible
  assert.equal(pickSide(lm, true).key, 'right');
  for (const i of [11, 13, 15, 23, 27]) lm[i].visibility = 0.95; // left now slightly better
  assert.equal(pickSide(lm, true, 'right').key, 'right', 'sticks to the current side');
  assert.equal(pickSide(lm, true).key, 'left', 'with no current side, takes the better one');
});

test('oneEuro: removes jitter when still, follows a real move', () => {
  const f = oneEuro();
  const r = rng(3);
  let rawSq = 0, outSq = 0;
  for (let i = 0; i < 60; i++) {
    const raw = 170 + (r() - 0.5) * 10;
    const v = f(raw, (i * 1000) / FPS);
    if (i > 10) { rawSq += (raw - 170) ** 2; outSq += (v - 170) ** 2; }
  }
  const rawRms = Math.sqrt(rawSq / 49), outRms = Math.sqrt(outSq / 49);
  assert.ok(outRms < rawRms / 2, `jitter RMS ${rawRms.toFixed(1)}° → ${outRms.toFixed(1)}°`);
  let v = 170;
  for (let i = 60; i < 75; i++) v = f(80, (i * 1000) / FPS); // half a second at the new angle
  assert.ok(v < 90, `follows the move: ${v.toFixed(1)}°`);
});
