// The judge: pure logic with no DOM or camera, so it runs the same in the browser and in tests.
//
// Input per video frame: two joint angles measured from MediaPipe's pose landmarks —
// the elbow (shoulder–elbow–wrist) and the body line (shoulder–hip–ankle).
// Output: events when a repetition is counted, rejected (with the reason), or the start position
// is reached.

/** Demo thresholds in degrees. A real product would load them from the official ГТО methodology. */
export const MODES = {
  pushup: {
    up: 155, down: 95, start: 140, bodyMin: 155, needBody: true,
    hint: '<b>Как снимать:</b> поставьте телефон на пол сбоку в 1,5–2 м, чтобы в кадре были плечи, руки, таз и ноги. Засчитывается повтор, если руки согнуты меньше 95°, затем выпрямлены больше 155°, а тело всё время прямое.',
  },
  arm: {
    up: 150, down: 70, start: 135, bodyMin: 0, needBody: false,
    hint: '<b>Демо за столом:</b> сядьте боком к камере, чтобы было видно плечо, локоть и кисть. Выпрямите руку, затем согните её полностью и снова выпрямите — это один повтор. Если согнуть руку не до конца, повтор не засчитается.',
  },
};

/** Angle ABC in degrees, from three points with x/y (the vertex is b). NaN if two points coincide. */
export function angle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const m = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!m) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180 / Math.PI;
}

/** MediaPipe Pose landmark indices for each side of the body. */
export const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, ankle: 28 },
};

/**
 * Pick the side of the body the camera sees better. Sticks to the current side unless the other
 * one is clearly better, so the angle does not jump between the left and the right arm.
 */
export function pickSide(lm, needBody, current = null) {
  const score = (s) => {
    const ids = needBody ? [s.shoulder, s.elbow, s.wrist, s.hip, s.ankle] : [s.shoulder, s.elbow, s.wrist];
    return ids.reduce((sum, i) => sum + (lm[i]?.visibility ?? 0), 0) / ids.length;
  };
  const l = score(SIDES.left), r = score(SIDES.right);
  let key = l >= r ? 'left' : 'right';
  if (current && current !== key && Math.abs(l - r) < 0.15) key = current;
  return { key, side: SIDES[key], vis: key === 'left' ? l : r };
}

/** One Euro filter: strong smoothing when still, almost no lag when moving fast. */
export function oneEuro(minCutoff = 1.2, beta = 0.04, dCutoff = 1.0) {
  let x = null, dx = 0, t = null;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return (v, now) => {
    if (x == null || isNaN(x) || isNaN(v)) { x = v; t = now; dx = 0; return v; }
    const dt = Math.max((now - t) / 1000, 1 / 120); t = now;
    dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x;
  };
}

/**
 * The repetition state machine: wait for the start position (arms straight), then each time the
 * arms bend below `start` a repetition begins; when they straighten above `up` again it is judged
 * on the deepest elbow angle and the lowest body-line angle seen during it.
 */
export function createJudge(cfg) {
  const st = { phase: 'wait', repActive: false, minElbow: 180, minBody: 180, ok: 0, bad: 0, elbow: null, body: null };
  const fElbow = oneEuro(), fBody = oneEuro();
  function step(elbowRaw, bodyRaw, now = performance.now()) {
    st.elbow = fElbow(elbowRaw, now);
    if (cfg.needBody) st.body = fBody(bodyRaw, now);
    const e = st.elbow, b = cfg.needBody ? st.body : 180;
    let event = null;
    if (st.phase === 'wait') {
      if (e > cfg.up) { st.phase = 'up'; event = { type: 'ready', text: 'Исходное положение принято — начинайте' }; }
      return event;
    }
    if (!st.repActive && e < cfg.start) {
      st.repActive = true; st.minElbow = e; st.minBody = b;
    }
    if (st.repActive) {
      st.minElbow = Math.min(st.minElbow, e);
      st.minBody = Math.min(st.minBody, b);
      if (e > cfg.up) {
        st.repActive = false;
        if (st.minElbow > cfg.down) {
          st.bad++; event = { type: 'bad', reason: 'shallow', text: `Не засчитано: руки согнуты мало (${Math.round(st.minElbow)}°, нужно меньше ${cfg.down}°)` };
        } else if (cfg.needBody && st.minBody < cfg.bodyMin) {
          st.bad++; event = { type: 'bad', reason: 'body', text: `Не засчитано: тело не прямое (${Math.round(st.minBody)}°) — прогиб или таз вверх` };
        } else {
          st.ok++; event = { type: 'ok', text: `Засчитано: ${st.ok}` };
        }
      }
    }
    return event;
  }
  return { st, step };
}
