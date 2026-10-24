// Camera, pose model and UI. The judging itself lives in judge.js.
import { MODES, angle, pickSide, createJudge } from './judge.js';

const TASKS_VERSION = '0.10.14';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const chart = $('chart'), cctx = chart.getContext('2d');

let mode = 'pushup';
let facing = 'user';
let landmarker = null, stream = null, running = false, lastVideoTime = -1;
let audioCtx = null;

let judge = createJudge(MODES[mode]);
const history = [];

function setMsg(text, kind = '') { const m = $('msg'); m.textContent = text; m.className = 'msg ' + kind; }
function addLog(text) {
  const li = document.createElement('li');
  li.textContent = new Date().toLocaleTimeString('ru-RU') + ' — ' + text;
  $('log').prepend(li);
  while ($('log').children.length > 6) $('log').lastChild.remove();
}
function renderStats() {
  $('okCount').textContent = judge.st.ok;
  $('badCount').textContent = judge.st.bad;
  $('elbowVal').textContent = judge.st.elbow == null ? '—' : Math.round(judge.st.elbow) + '°';
  $('bodyVal').textContent = MODES[mode].needBody && judge.st.body != null ? Math.round(judge.st.body) + '°' : '—';
}
function reset() {
  judge = createJudge(MODES[mode]);
  history.length = 0;
  $('log').innerHTML = '';
  setMsg(running ? 'Примите исходное положение: руки выпрямлены' : 'Ожидание…');
  renderStats(); drawChart();
}
function applyMode() {
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('hint').innerHTML = MODES[mode].hint;
  $('bodyLabel').textContent = MODES[mode].needBody ? 'линия тела' : 'не проверяется';
  reset();
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; applyMode(); }));
$('resetBtn').addEventListener('click', reset);

function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch (_) { /* no audio: counting still works */ }
}

function drawChart() {
  const w = chart.clientWidth || 600, h = 120;
  const pw = Math.round(w * devicePixelRatio), ph = Math.round(h * devicePixelRatio);
  if (chart.width !== pw || chart.height !== ph) { chart.width = pw; chart.height = ph; }
  cctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  cctx.clearRect(0, 0, w, h);
  const y = (a) => 10 + (180 - a) / 150 * (h - 20); // 180° top, 30° bottom
  const cfg = MODES[mode];
  cctx.setLineDash([6, 5]); cctx.lineWidth = 1.5;
  cctx.strokeStyle = '#6AB3F2'; cctx.beginPath(); cctx.moveTo(0, y(cfg.up)); cctx.lineTo(w, y(cfg.up)); cctx.stroke();
  cctx.strokeStyle = '#F2994A'; cctx.beginPath(); cctx.moveTo(0, y(cfg.down)); cctx.lineTo(w, y(cfg.down)); cctx.stroke();
  cctx.setLineDash([]);
  cctx.fillStyle = '#A9B8C6'; cctx.font = '12px sans-serif';
  cctx.fillText(`верх ${cfg.up}°`, 6, y(cfg.up) - 4); cctx.fillText(`низ ${cfg.down}°`, 6, y(cfg.down) - 4);
  if (history.length < 2) return;
  const now = performance.now(), span = 10000;
  cctx.strokeStyle = '#F2EFE8'; cctx.lineWidth = 2.5; cctx.beginPath();
  history.forEach((p, i) => {
    const x = w - (now - p.t) / span * w;
    i ? cctx.lineTo(x, y(p.a)) : cctx.moveTo(x, y(p.a));
  });
  cctx.stroke();
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function drawPose(lm, side) {
  const w = overlay.width, h = overlay.height;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(3, w / 200); ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    ctx.strokeStyle = 'rgba(106,179,242,.9)';
    ctx.beginPath(); ctx.moveTo(lm[a].x * w, lm[a].y * h); ctx.lineTo(lm[b].x * w, lm[b].y * h); ctx.stroke();
  }
  for (const i of [side.shoulder, side.elbow, side.wrist, side.hip, side.ankle]) {
    ctx.fillStyle = '#F2994A';
    ctx.beginPath(); ctx.arc(lm[i].x * w, lm[i].y * h, Math.max(5, w / 110), 0, Math.PI * 2); ctx.fill();
  }
}

async function loadModel() {
  setMsg('Загружаю нейросеть…');
  const { FilesetResolver, PoseLandmarker } = await import(TASKS_URL);
  const fileset = await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
  const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1 });
  try { return await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch (_) { return await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
}

async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  $('stage').classList.toggle('mirror', facing === 'user');
}

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не даёт доступ к камере. Откройте страницу по https в Chrome или Safari.');
    if (!landmarker) landmarker = await loadModel();
    await startCamera();
    $('placeholder').hidden = true;
    $('flipBtn').disabled = false;
    $('startBtn').textContent = 'Камера включена';
    running = true;
    reset();
    scheduleFrame(loop);
  } catch (err) {
    console.error(err);
    const text = err?.name === 'NotAllowedError' ? 'Доступ к камере запрещён — разрешите его в настройках браузера.' :
      err?.name === 'NotFoundError' ? 'Камера не найдена на этом устройстве.' : (err?.message || String(err));
    setMsg(text, 'bad');
    $('placeholder').textContent = text;
    $('startBtn').disabled = false;
  }
});

$('flipBtn').addEventListener('click', async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  try { await startCamera(); } catch (_) { setMsg('Не удалось переключить камеру', 'bad'); }
});

let sideKey = null, lowVisSince = 0, frames = 0, fpsT = performance.now();
const scheduleFrame = (fn) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(fn) : requestAnimationFrame(fn));

function processFrame() {
  const now = performance.now();
  const res = landmarker.detectForVideo(video, now);
  const lm = res.landmarks?.[0];
  const badge = $('badge');
  if (!lm) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    badge.hidden = false; badge.textContent = 'Человек не найден в кадре';
    return;
  }
  const cfg = MODES[mode];
  const picked = pickSide(lm, cfg.needBody, sideKey);
  sideKey = picked.key;
  const side = picked.side;
  drawPose(lm, side);
  // A bent arm often hides the wrist for a moment: keep counting and only
  // warn if the joints stay poorly visible for longer than half a second.
  if (picked.vis < 0.3) {
    if (!lowVisSince) lowVisSince = now;
    if (now - lowVisSince > 500) {
      badge.hidden = false;
      badge.textContent = cfg.needBody ? 'Встаньте сбоку целиком: плечи, руки, таз и ноги' : 'Покажите плечо, локоть и кисть сбоку';
    }
    return;
  }
  lowVisSince = 0; badge.hidden = true;
  const elbow = angle(lm[side.shoulder], lm[side.elbow], lm[side.wrist]);
  const body = cfg.needBody ? angle(lm[side.shoulder], lm[side.hip], lm[side.ankle]) : 180;
  const ev = judge.step(elbow, body, now);
  history.push({ t: now, a: judge.st.elbow });
  while (history.length && now - history[0].t > 10000) history.shift();
  if (ev) {
    setMsg(ev.text, ev.type === 'ready' ? '' : ev.type);
    if (ev.type !== 'ready') { addLog(ev.text); beep(ev.type === 'ok'); }
  }
}

function loop() {
  if (!running) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processFrame();
    renderStats(); drawChart();
    frames++;
    const now = performance.now();
    if (now - fpsT > 1000) {
      const fps = $('fps'); fps.hidden = false;
      fps.textContent = Math.round(frames * 1000 / (now - fpsT)) + ' к/с';
      frames = 0; fpsT = now;
    }
  }
  scheduleFrame(loop);
}

applyMode();
