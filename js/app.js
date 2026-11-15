// Spectroscope web app: camera or photo -> sampling band -> R, G, B and combined
// profiles -> wavelength calibration -> files. Everything runs in the browser.

import * as core from './core.js';
import { drawPlot } from './plot.js';

const LS_KEY = 'spectroscope.v1';
const MAX_PHOTO_SIDE = 4096;   // larger photos are scaled so the long side is this many pixels
const LIVE_MIN_DT = 90;        // ms between processed live frames (about 10 per second)
const EDGE_REFRESH_MS = 1000;  // how often the live view re-finds the top and bottom of the spectrum
const BG_GAP = 0.028;          // stray-light strips: gap from the spectrum, as a fraction of frame height
const BG_STRIP = 0.056;        // and their height (30 and 60 rows on a 1080-row frame, as in the desktop app)
const RES = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };

const DEFAULTS = {
  rot: 0, flip: false, tilt: 0,
  bandPos: 50, bandH: 2, x0: 0, x1: 100,
  linearise: true, subtractBg: false, normalise: true, labelPeaks: false,
  gWeight: 1, average: 4, resolution: '1080',
  showSum: true, showR: true, showG: true, showB: true,
  snap: 'peak', refLines: 'none', cameraLabel: '', name: 'spectrum',
};

const $ = (id) => document.getElementById(id);
const els = {};
['view', 'viewWrap', 'viewHint', 'viewBadge', 'plot', 'plotWrap', 'readout', 'notices', 'srcStatus', 'calStatus',
  'btnCamera', 'btnFreeze', 'btnPhoto', 'cameraRow', 'cameraSelect', 'resolution', 'average',
  'btnRotate', 'btnFlip', 'tilt', 'tiltOut', 'camControls', 'camNone',
  'bandPos', 'bandPosOut', 'bandH', 'bandHOut', 'x0', 'x0Out', 'x1', 'x1Out',
  'linearise', 'subtractBg', 'normalise', 'labelPeaks', 'gWeight',
  'fitSummary', 'snap', 'preset', 'nm', 'btnAddPoint', 'btnShift', 'pointList', 'btnClearPoints', 'refLines',
  'name', 'btnSaveAll', 'btnSaveCsv', 'btnSavePlot', 'btnSaveFrame', 'saveStatus',
  'btnDiagRefresh', 'btnDiagCopy', 'diag', 'btnResetSettings', 'btnResetCals', 'version',
  'nudgeL', 'nudgeR', 'zoomIn', 'zoomOut', 'zoomFull', 'toast', 'video', 'file',
].forEach((id) => { els[id] = $(id); });

const LUT_LIN = core.makeLut(true), LUT_RAW = core.makeLut(false);
const COARSE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
const viewCtx = els.view.getContext('2d');

/** Can a canvas hold Display P3 pixels? iPhone photos use that colour space, and reading them
 *  through an sRGB canvas would cut off the most saturated colours. */
const P3_OK = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { colorSpace: 'display-p3' });
    return !!(ctx && ctx.getContextAttributes && ctx.getContextAttributes().colorSpace === 'display-p3');
  } catch (e) { return false; }
})();

const state = {
  settings: { ...DEFAULTS },
  cals: {},            // saved calibration points, one entry per camera + frame size + orientation
  kind: null,          // 'live' or 'photo'
  frozen: false,
  srcEl: null, srcW: 0, srcH: 0, dw: 0, dh: 0, p3: false,
  W: 0, H: 0, fc: null,
  stream: null, track: null, trackLabel: '', devices: [],
  raf: 0, lastTick: 0, frameCount: 0,
  avg: [], avgKey: '', edges: null,
  profile: null, norm: 1,
  cursorPx: null, view: null, geom: null, viewFit: null,
  sig: '', points: [], cal: core.fitCalibration([], 1),
  errors: [], sw: 'not registered', noticeKey: '', photoUrl: null, photoName: '', hold: null,
};

// ---------------------------------------------------------------- storage

function loadStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.settings) state.settings = { ...DEFAULTS, ...d.settings };
    if (d && d.cals) state.cals = d.cals;
  } catch (e) { logError('storage', e); }
}

let saveTimer = 0;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ settings: state.settings, cals: state.cals })); }
    catch (e) { logError('storage', e); }
  }, 250);
}

// ---------------------------------------------------------------- messages

function logError(where, e) {
  const msg = `${where}: ${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`;
  const last = state.errors[state.errors.length - 1];
  if (last && last.msg === msg) { last.count++; return; }
  state.errors.push({ t: new Date().toISOString(), msg, count: 1 });
  if (state.errors.length > 20) state.errors.shift();
}

let toastTimer = 0;
function toast(text, ms = 3500) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

window.addEventListener('error', (ev) => {
  logError('error', ev.error || ev.message);
  toast('Something went wrong. See More, Diagnostics.');
});
window.addEventListener('unhandledrejection', (ev) => logError('promise', ev.reason));

// ---------------------------------------------------------------- frame

const frames = {};
function frameFor(p3) {
  const key = p3 ? 'p3' : 'srgb';
  if (!frames[key]) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', p3 ? { colorSpace: 'display-p3', willReadFrequently: true } : { willReadFrequently: true });
    frames[key] = { c, ctx };
  }
  const other = frames[p3 ? 'srgb' : 'p3'];
  if (other && other.c.width > 1) { other.c.width = 1; other.c.height = 1; }   // give its memory back
  return frames[key];
}

function isLive() {
  return state.kind === 'live' && !state.frozen && !!state.stream;
}

function signature() {
  const s = state.settings;
  const cam = state.kind === 'live' ? (state.trackLabel || 'camera') : 'photo';
  return `${cam}|${state.W}x${state.H}|r${s.rot}${s.flip ? 'f' : ''}`;
}

/** Work out the size of the analysed frame from the source size and the rotation. */
function configureFrame() {
  const s = state.settings;
  let dw = state.srcW, dh = state.srcH;
  const long = Math.max(dw, dh);
  if (state.kind === 'photo' && long > MAX_PHOTO_SIDE) {
    const k = MAX_PHOTO_SIDE / long;
    dw = Math.max(1, Math.round(dw * k));
    dh = Math.max(1, Math.round(dh * k));
  }
  state.dw = dw; state.dh = dh;
  const turned = s.rot % 180 !== 0;
  const W = turned ? dh : dw, H = turned ? dw : dh;
  if (W !== state.W) state.cursorPx = null;
  state.W = W; state.H = H;
  state.fc = frameFor(state.kind === 'photo' && state.p3);
  if (state.fc.c.width !== W || state.fc.c.height !== H) { state.fc.c.width = W; state.fc.c.height = H; }
  state.avg = []; state.edges = null; state.view = null;
  loadCalibration();
  syncOutputs();
}

/** Draw the source into the analysed frame: rotate in quarter turns, tilt, then mirror. */
function drawFrame() {
  const s = state.settings, ctx = state.fc.ctx, W = state.W, H = state.H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  if (s.flip) ctx.scale(-1, 1);
  ctx.rotate((s.rot + s.tilt) * Math.PI / 180);
  ctx.drawImage(state.srcEl, -state.dw / 2, -state.dh / 2, state.dw, state.dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function bandRect() {
  const s = state.settings, W = state.W, H = state.H;
  const xa = core.clamp(Math.round(s.x0 / 100 * W), 0, Math.max(0, W - 2));
  const xb = core.clamp(Math.round(s.x1 / 100 * W), xa + 2, W);
  const hRows = core.clamp(Math.round(s.bandH / 100 * H), 1, H);
  const y0 = core.clamp(Math.round(s.bandPos / 100 * H - hRows / 2), 0, H - hRows);
  return { xa, n: xb - xa, y0, hRows };
}

let probe = null;
/** Top and bottom rows of the visible spectrum around the band, from a squeezed copy of the frame. */
function findEdges(q) {
  if (!probe) { probe = document.createElement('canvas'); probe.getContext('2d', { willReadFrequently: true }); }
  const pw = 16, ph = Math.min(state.H, 540);
  if (probe.width !== pw || probe.height !== ph) { probe.width = pw; probe.height = ph; }
  const pctx = probe.getContext('2d');
  pctx.drawImage(state.fc.c, q.xa, 0, q.n, state.H, 0, 0, pw, ph);
  const rows = core.rowBrightness(pctx.getImageData(0, 0, pw, ph).data, pw, ph);
  const k = state.H / ph;
  const e = core.bandEdges(rows, (q.y0 + q.hRows / 2) / k);
  return e ? { top: Math.floor(e.top * k), bottom: Math.ceil(e.bottom * k) } : null;
}

/** Rows used to measure stray light: one strip above and one below the visible spectrum. */
function backgroundStrips(q, now, force) {
  const H = state.H;
  const key = `${q.xa},${q.n},${q.y0},${q.hRows}`;
  if (force || !state.edges || state.edges.key !== key || now - state.edges.t > EDGE_REFRESH_MS) {
    state.edges = { key, t: now, val: findEdges(q) };
  }
  let top = q.y0, bottom = q.y0 + q.hRows;
  const e = state.edges.val;
  if (e) { top = Math.min(top, e.top); bottom = Math.max(bottom, e.bottom); }
  const gap = Math.max(2, Math.round(BG_GAP * H)), hs = Math.max(2, Math.round(BG_STRIP * H));
  const strips = [];
  if (top - gap - hs >= 0) strips.push([top - gap - hs, hs]);
  if (bottom + gap + hs <= H) strips.push([bottom + gap, hs]);
  return strips;
}

/** One measurement of the current frame: column averages inside the band, less stray light. */
function measure(now, force) {
  const q = bandRect(), ctx = state.fc.ctx, s = state.settings;
  const lut = s.linearise ? LUT_LIN : LUT_RAW;
  const m = core.columnMeans(ctx.getImageData(q.xa, q.y0, q.n, q.hRows).data, q.n, q.hRows, lut);
  let strips = [];
  if (s.subtractBg) {
    strips = backgroundStrips(q, now, force);
    if (strips.length) {
      const br = new Float64Array(q.n), bg = new Float64Array(q.n), bb = new Float64Array(q.n);
      for (const [y, h] of strips) {
        const t = core.columnMeans(ctx.getImageData(q.xa, y, q.n, h).data, q.n, h, lut);
        for (let i = 0; i < q.n; i++) { br[i] += t.r[i]; bg[i] += t.g[i]; bb[i] += t.b[i]; }
      }
      const k = 1 / strips.length;
      for (let i = 0; i < q.n; i++) {
        m.r[i] = Math.max(0, m.r[i] - br[i] * k);
        m.g[i] = Math.max(0, m.g[i] - bg[i] * k);
        m.b[i] = Math.max(0, m.b[i] - bb[i] * k);
      }
    }
  }
  return { xa: q.xa, n: q.n, y0: q.y0, hRows: q.hRows, r: m.r, g: m.g, b: m.b, clip: m.clip, raw: m.raw, peakRaw: m.peakRaw, strips };
}

function pushMeasurement(m) {
  const s = state.settings;
  const key = [m.xa, m.n, m.y0, m.hRows, s.linearise, s.subtractBg, state.W, state.H].join();
  if (key !== state.avgKey) { state.avg = []; state.avgKey = key; }
  state.avg.push(m);
  const keep = isLive() ? Math.max(1, Number(s.average) || 1) : 1;
  while (state.avg.length > keep) state.avg.shift();
  buildProfile();
}

/** Average the stored measurements into the profile that is plotted and saved. */
function buildProfile() {
  const list = state.avg;
  if (!list.length) return;
  const last = list[list.length - 1], n = last.n, k = 1 / list.length;
  const r = new Float64Array(n), g = new Float64Array(n), b = new Float64Array(n), sum = new Float64Array(n);
  const clip = new Float32Array(n);
  for (const m of list) {
    for (let i = 0; i < n; i++) { r[i] += m.r[i]; g[i] += m.g[i]; b[i] += m.b[i]; clip[i] += m.clip[i]; }
  }
  const gw = Number(state.settings.gWeight) || 1;
  for (let i = 0; i < n; i++) {
    r[i] *= k; g[i] *= k; b[i] *= k; clip[i] *= k;
    sum[i] = r[i] + gw * g[i] + b[i];
  }
  state.profile = { x0: last.xa, n, y0: last.y0, hRows: last.hRows, r, g, b, sum, clip, raw: last.raw, peakRaw: last.peakRaw, frames: list.length, strips: last.strips };
}

/** Redo the analysis after a setting changed. A live camera picks the change up on its next frame. */
function reprocess() {
  if (!state.srcEl || !state.W) return;
  if (isLive()) { state.avg = []; return; }
  try {
    drawFrame();
    state.avg = [];
    pushMeasurement(measure(performance.now(), true));
  } catch (e) {
    logError('analysis', e);
    if (state.p3) {            // fall back to the ordinary colour space
      state.p3 = false;
      configureFrame();
      return reprocess();
    }
  }
  requestRender();
}

// ---------------------------------------------------------------- camera

function liveLoop(t) {
  state.raf = 0;
  if (!isLive()) return;
  if (t - state.lastTick >= LIVE_MIN_DT) {
    state.lastTick = t;
    const v = els.video;
    if (v.readyState >= 2 && v.videoWidth > 0) {
      try {
        if (v.videoWidth !== state.srcW || v.videoHeight !== state.srcH) {
          state.srcW = v.videoWidth; state.srcH = v.videoHeight;
          configureFrame();
        }
        drawFrame();
        pushMeasurement(measure(t, false));
        state.frameCount++;
        render();
      } catch (e) { logError('live frame', e); }
    }
  }
  state.raf = requestAnimationFrame(liveLoop);
}

function startLoop() {
  if (!state.raf) state.raf = requestAnimationFrame(liveLoop);
}

function cameraError(e) {
  const n = e && e.name;
  let msg = 'The camera could not be opened.';
  if (n === 'NotAllowedError' || n === 'SecurityError') msg = 'Camera access was refused. Allow the camera for this page (on iPhone: Settings, Apps, Safari, Camera), then try again.';
  else if (n === 'NotFoundError' || n === 'OverconstrainedError') msg = 'No camera was found.';
  else if (n === 'NotReadableError' || n === 'AbortError') msg = 'The camera is busy in another app, or could not start.';
  toast(msg, 7000);
  logError('camera', e || 'unknown');
}

function onTrackEnded() {
  if (state.frozen) return;
  stopCamera();
  toast('The camera stopped. Tap Start camera to continue.');
  updateButtons();
}

function stopCamera() {
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => { t.removeEventListener('ended', onTrackEnded); t.stop(); });
  }
  state.stream = null; state.track = null;
  els.video.srcObject = null;
}

async function startCamera(deviceId, explicit) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This browser cannot open the camera here. The page has to be opened over https.', 7000);
    return;
  }
  stopCamera();
  const [w, h] = RES[state.settings.resolution] || RES[1080];
  const size = { width: { ideal: w }, height: { ideal: h } };
  const tries = [];
  if (deviceId) tries.push({ ...size, deviceId: { exact: deviceId } });
  tries.push({ ...size, facingMode: { ideal: 'environment' } });
  tries.push(true);
  let stream = null, lastErr = null;
  for (const video of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); break; }
    catch (e) { lastErr = e; if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; }
  }
  if (!stream) { cameraError(lastErr); updateButtons(); return; }
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.trackLabel = state.track.label || '';
  state.track.addEventListener('ended', onTrackEnded);
  els.video.srcObject = stream;
  try { await els.video.play(); } catch (e) { logError('video.play', e); }
  state.kind = 'live'; state.frozen = false; state.srcEl = els.video; state.p3 = false;
  state.srcW = 0; state.srcH = 0; state.profile = null; state.avg = [];
  els.viewHint.hidden = true;
  await refreshCameraList();
  // go back to the lens chosen last time, if this is a different one
  const want = state.settings.cameraLabel;
  if (!explicit && want && want !== state.trackLabel) {
    const d = state.devices.find((x) => x.label === want);
    if (d) return startCamera(d.deviceId, true);
  }
  buildCameraControls();
  updateButtons();
  startLoop();
}

async function refreshCameraList() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    state.devices = devs;
    const sel = els.cameraSelect;
    sel.textContent = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}`;
      sel.appendChild(o);
    });
    const cur = state.track && state.track.getSettings ? state.track.getSettings().deviceId : '';
    if (cur) sel.value = cur;
    els.cameraRow.hidden = devs.length < 2;
  } catch (e) { logError('enumerateDevices', e); }
}

function toggleFreeze() {
  if (state.kind !== 'live' || !state.stream) return;
  if (!state.frozen) {
    const v = els.video;
    if (!v.videoWidth) return;
    // keep the untouched frame, so rotation, tilt and the band can still be changed afterwards
    const c = state.hold || (state.hold = document.createElement('canvas'));
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    state.srcEl = c;
    state.frozen = true;
  } else if (state.track && state.track.readyState === 'ended') {
    // the camera was taken away while the frame was frozen (for example the app went to the background)
    stopCamera();
    toast('The camera stopped. Tap Start camera to continue.');
  } else {
    state.srcEl = els.video;
    state.frozen = false;
    state.avg = [];
    startLoop();
  }
  updateButtons();
  requestRender();
}

const CONTROL_KEYS = ['exposureMode', 'exposureTime', 'exposureCompensation', 'iso', 'whiteBalanceMode', 'colorTemperature',
  'focusMode', 'focusDistance', 'zoom', 'torch', 'brightness', 'contrast', 'saturation', 'sharpness'];
const CONTROL_NAMES = {
  exposureMode: 'Exposure mode', exposureTime: 'Exposure time', exposureCompensation: 'Exposure shift', iso: 'ISO',
  whiteBalanceMode: 'White balance', colorTemperature: 'Colour temp.', focusMode: 'Focus mode', focusDistance: 'Focus distance',
  zoom: 'Zoom', torch: 'Torch', brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation', sharpness: 'Sharpness',
};
// a value only takes effect when its mode is set to manual
const NEEDS_MANUAL = { exposureTime: 'exposureMode', iso: 'exposureMode', colorTemperature: 'whiteBalanceMode', focusDistance: 'focusMode' };

/** Show whatever manual controls this camera and browser offer. Many phones offer none. */
function buildCameraControls() {
  const box = els.camControls;
  box.textContent = '';
  let count = 0;
  const t = state.track;
  if (t) {
    let caps = {}, sett = {};
    try { if (t.getCapabilities) caps = t.getCapabilities() || {}; } catch (e) { logError('getCapabilities', e); }
    try { if (t.getSettings) sett = t.getSettings() || {}; } catch (e) { logError('getSettings', e); }
    for (const key of CONTROL_KEYS) {
      const c = caps[key];
      if (c === undefined || c === null) continue;
      const row = document.createElement('div');
      const label = document.createElement('label');
      const out = document.createElement('output');
      label.textContent = CONTROL_NAMES[key];
      let input;
      if (Array.isArray(c)) {
        if (c.length < 2) continue;
        row.className = 'row field';
        input = document.createElement('select');
        for (const v of c) { const o = document.createElement('option'); o.value = v; o.textContent = v; input.appendChild(o); }
        if (sett[key] !== undefined) input.value = sett[key];
        input.addEventListener('change', () => applyControl(key, input.value, caps, null));
      } else if (typeof c === 'object' && typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min) {
        row.className = 'row slider';
        input = document.createElement('input');
        input.type = 'range';
        input.min = c.min; input.max = c.max;
        input.step = c.step > 0 ? c.step : (c.max - c.min) / 100;
        input.value = typeof sett[key] === 'number' ? sett[key] : c.min;
        out.textContent = formatControl(Number(input.value));
        input.addEventListener('input', () => { out.textContent = formatControl(Number(input.value)); });
        input.addEventListener('change', () => applyControl(key, Number(input.value), caps, out));
      } else if (c === true) {
        row.className = 'row field';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!sett[key];
        input.addEventListener('change', () => applyControl(key, input.checked, caps, null));
      } else continue;
      input.id = 'cam_' + key;
      label.htmlFor = input.id;
      row.appendChild(label);
      row.appendChild(input);
      if (input.type === 'range') row.appendChild(out);
      box.appendChild(row);
      count++;
    }
  }
  els.camNone.hidden = count > 0;
  if (!count && t) els.camNone.textContent = 'This camera offers no manual exposure, colour or focus control here. For steadier brightness, take the photo in the Camera app with exposure locked (press and hold on the picture), then load it.';
}

function formatControl(v) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

async function applyControl(key, value, caps, out) {
  const t = state.track;
  if (!t) return;
  const set = { [key]: value };
  const mode = NEEDS_MANUAL[key];
  if (mode && Array.isArray(caps[mode]) && caps[mode].includes('manual')) {
    set[mode] = 'manual';
    const sel = $('cam_' + mode);
    if (sel) sel.value = 'manual';
  }
  try {
    await t.applyConstraints({ advanced: [set] });
    const now = t.getSettings ? t.getSettings() : {};
    if (out && typeof now[key] === 'number') out.textContent = formatControl(now[key]);
    state.avg = [];
  } catch (e) {
    toast(`Could not change ${CONTROL_NAMES[key].toLowerCase()}.`);
    logError('applyConstraints ' + key, e);
  }
}

// ---------------------------------------------------------------- photo

async function detectP3(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    return core.bytesMentionDisplayP3(buf);
  } catch (e) { return false; }
}

async function loadPhoto(file) {
  if (!file) return;
  try {
    const p3 = P3_OK && await detectP3(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('This file could not be read as an image.'));
      img.src = url;
    });
    stopCamera();
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = url;
    state.photoName = file.name || 'photo';
    state.kind = 'photo'; state.frozen = false; state.srcEl = img; state.p3 = p3;
    state.srcW = img.naturalWidth; state.srcH = img.naturalHeight;
    state.profile = null;
    els.viewHint.hidden = true;
    configureFrame();
    reprocess();
    buildCameraControls();
    updateButtons();
  } catch (e) {
    toast(e && e.message ? e.message : 'That image could not be loaded.');
    logError('photo', e);
  }
}

// ---------------------------------------------------------------- calibration

function calOk() { return !!(state.cal && state.cal.ok); }
function pxToNm(px) { return core.calNm(state.cal, px - state.W / 2); }
function nmToPx(nm) { const o = core.calOffset(state.cal, nm); return o === null ? null : o + state.W / 2; }

function loadCalibration() {
  state.sig = signature();
  const saved = state.cals[state.sig];
  state.points = saved && Array.isArray(saved.points) ? saved.points.map((p) => ({ off: Number(p.off), nm: Number(p.nm) })) : [];
  refit(false);
}

function refit(save = true) {
  state.cal = core.fitCalibration(state.points, state.W || 1);
  if (save) {
    if (state.points.length) state.cals[state.sig] = { points: state.points, savedAt: new Date().toISOString() };
    else delete state.cals[state.sig];
    saveStore();
  }
  renderCalibration();
  requestRender();
}

function signed(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2); }

function renderCalibration() {
  const cal = state.cal, list = els.pointList;
  list.textContent = '';
  state.points.forEach((p, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${p.nm.toFixed(1)} nm at pixel ${(p.off + state.W / 2).toFixed(1)}`;
    if (cal.ok && cal.n > cal.degree + 1) {
      const small = document.createElement('small');
      small.textContent = `  misses by ${signed(cal.residuals[i])} nm`;
      span.appendChild(small);
    }
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'del'; del.textContent = 'Remove';
    del.addEventListener('click', () => { state.points.splice(i, 1); refit(); });
    li.appendChild(span); li.appendChild(del);
    list.appendChild(li);
  });
  let text = cal.message;
  if (cal.ok) {
    const slope = Math.abs(cal.coeffs[cal.coeffs.length - 2]);
    text = `${cal.degree === 2 ? 'Curved' : 'Straight-line'} fit through ${cal.n} lines: ${slope.toFixed(3)} nm per pixel at the centre, ` +
      `${pxToNm(0).toFixed(0)} to ${pxToNm(state.W - 1).toFixed(0)} nm across the frame.`;
    if (cal.n > cal.degree + 1) text += ` Typical miss ${cal.rms.toFixed(2)} nm.`;
  }
  for (const w of cal.warnings) text += ' ' + w;
  els.fitSummary.textContent = text;
  els.btnShift.disabled = !cal.ok;
  els.btnClearPoints.disabled = !state.points.length;
  els.calStatus.textContent = cal.ok ? 'Calibrated' : 'Not calibrated';
  els.calStatus.classList.toggle('good', cal.ok);
}

function readNm() {
  const v = parseFloat(els.nm.value);
  if (!Number.isFinite(v) || v < 200 || v > 1200) { toast('Type a wavelength between 200 and 1200 nm.'); return null; }
  return v;
}

function addPoint() {
  if (!state.profile) { toast('Start the camera or load a photo first.'); return; }
  if (state.cursorPx === null) { toast('Tap the plot on the line first.'); return; }
  const nm = readNm();
  if (nm === null) return;
  const off = state.cursorPx - state.W / 2;
  const i = state.points.findIndex((p) => Math.abs(p.off - off) < 1);
  if (i >= 0) state.points[i] = { off, nm }; else state.points.push({ off, nm });
  refit();
}

function shiftToMatch() {
  if (!calOk()) return;
  if (state.cursorPx === null) { toast('Tap the plot on the line first.'); return; }
  const nm = readNm();
  if (nm === null) return;
  const at = core.calOffset(state.cal, nm);
  if (at === null) { toast('That wavelength is outside this calibration.'); return; }
  const d = (state.cursorPx - state.W / 2) - at;
  state.points = state.points.map((p) => ({ off: p.off + d, nm: p.nm }));
  refit();
  toast(`Calibration moved by ${d.toFixed(1)} pixels.`);
}

// ---------------------------------------------------------------- drawing

function sizeCanvas(cv, wrap, maxDpr) {
  const r = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { cssW: r.width, cssH: r.height, dpr };
}

function drawView() {
  const { dpr } = sizeCanvas(els.view, els.viewWrap, 2);
  const cv = els.view, ctx = viewCtx, cw = cv.width, ch = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  state.viewFit = null;
  if (!state.W || !state.fc) return;
  const k = Math.min(cw / state.W, ch / state.H);
  const dw = state.W * k, dh = state.H * k, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  state.viewFit = { k: k / dpr, dx: dx / dpr, dy: dy / dpr };
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.fc.c, dx, dy, dw, dh);
  const p = state.profile;
  if (!p) return;
  const x = dx + p.x0 * k, w = p.n * k, y = dy + p.y0 * k, h = Math.max(1, p.hRows * k);
  // outline drawn just outside the band, dark under light so it shows on any picture
  for (const [color, lw] of [['rgba(0,0,0,0.7)', 3 * dpr], ['#ffffff', dpr]]) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.strokeRect(x - dpr, y - 1.5 * dpr, w + 2 * dpr, h + 3 * dpr);
  }
  if (p.strips && p.strips.length) {
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = dpr;
    for (const [sy, sh] of p.strips) ctx.strokeRect(x, dy + sy * k, w, sh * k);
    ctx.setLineDash([]);
  }
  if (state.cursorPx !== null) {
    const cx = dx + (state.cursorPx + 0.5) * k;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(cx, y - 12 * dpr); ctx.lineTo(cx, y - 3 * dpr);
    ctx.moveTo(cx, y + h + 3 * dpr); ctx.lineTo(cx, y + h + 12 * dpr);
    ctx.stroke();
  }
}

let colorCache = null;
function themeColors() {
  if (colorCache) return colorCache;
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  colorCache = {
    bg: v('--surface'), ink: v('--ink'), ink2: v('--ink2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
    warnWash: v('--warn-wash'), ref: v('--ref'), accent: v('--mark'), r: v('--series-r'), g: v('--series-g'), b: v('--series-b'),
  };
  return colorCache;
}

function drawSpectrum() {
  const { cssW, cssH, dpr } = sizeCanvas(els.plot, els.plotWrap, 3);
  const p = state.profile, s = state.settings, colors = themeColors();
  if (!p) { state.geom = drawPlot(els.plot, { cssW, cssH, dpr, n: 0, colors }); return; }
  const full = [p.x0, p.x0 + p.n - 1];
  let view = full;
  if (state.view) {
    const a = core.clamp(state.view[0], full[0], full[1]), b = core.clamp(state.view[1], full[0], full[1]);
    if (b - a >= 4) view = [a, b]; else state.view = null;
  }
  let norm = 1;
  if (s.normalise) {
    let mx = 0;
    for (let i = 0; i < p.n; i++) if (p.sum[i] > mx) mx = p.sum[i];
    if (mx > 0) norm = 1 / mx;
  }
  state.norm = norm;
  const scaled = (a) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * norm; return o; };
  const cal = calOk();
  let peaks = [];
  if (s.labelPeaks) {
    const ys = core.gaussianSmooth(p.sum, Math.max(1, p.n / 1500));
    let top = 0;
    for (let i = 0; i < p.n; i++) if (ys[i] > top) top = ys[i];
    const found = core.findPeaks(ys, { minProminence: 0.03 * top, minDistance: Math.max(3, Math.round(p.n / 150)) });
    found.sort((a, b) => b.prominence - a.prominence);
    peaks = found.slice(0, 8).map((f) => {
      const px = p.x0 + core.refineExtremum(ys, f.i);
      return { px, height: f.height * norm, text: cal ? pxToNm(px).toFixed(1) : String(Math.round(px)) };
    });
  }
  const group = core.LINE_GROUPS.find((g) => g.id === s.refLines);
  state.geom = drawPlot(els.plot, {
    cssW, cssH, dpr, colors,
    x0: p.x0, n: p.n, raw: p.raw, clip: p.clip, view,
    series: [
      { y: scaled(p.r), show: s.showR, color: colors.r, width: 1.5, tag: 'R' },
      { y: scaled(p.g), show: s.showG, color: colors.g, width: 1.5, tag: 'G' },
      { y: scaled(p.b), show: s.showB, color: colors.b, width: 1.5, tag: 'B' },
      { y: scaled(p.sum), show: s.showSum, color: colors.ink, width: 2, tag: '' },
    ],
    pxToNm: cal ? pxToNm : null, nmToPx: cal ? nmToPx : null,
    cursorPx: state.cursorPx,
    calPoints: state.points.map((q) => ({ px: q.off + state.W / 2 })),
    refLines: cal && group ? group.lines : [],
    peaks,
    yLabel: s.normalise ? 'Relative signal' : 'Signal',
  });
}

const ro = {};
function buildReadout() {
  const box = els.readout;
  box.textContent = '';
  ro.hint = document.createElement('span');
  ro.hint.textContent = 'Tap the plot to read a value.';
  ro.vals = document.createElement('span');
  ro.vals.hidden = true;
  ro.pos = document.createElement('b');
  ro.px = document.createElement('span');
  ro.vals.appendChild(ro.pos);
  ro.vals.appendChild(ro.px);
  for (const [name, cls] of [['sum', 'k'], ['r', 'k kR'], ['g', 'k kG'], ['b', 'k kB']]) {
    const key = document.createElement('span');
    key.className = cls;
    ro[name] = document.createElement('b');
    ro.vals.appendChild(key);
    ro.vals.appendChild(ro[name]);
  }
  box.appendChild(ro.hint);
  box.appendChild(ro.vals);
}

function updateReadout() {
  const p = state.profile;
  const on = !!p && state.cursorPx !== null;
  ro.hint.hidden = on;
  ro.vals.hidden = !on;
  if (!on) return;
  const i = core.clamp(Math.round(state.cursorPx - p.x0), 0, p.n - 1);
  if (calOk()) {
    ro.pos.textContent = `${pxToNm(state.cursorPx).toFixed(1)} nm`;
    ro.px.textContent = `  px ${state.cursorPx.toFixed(1)}`;
  } else {
    ro.pos.textContent = `px ${state.cursorPx.toFixed(1)}`;
    ro.px.textContent = '';
  }
  const k = state.norm;
  ro.sum.textContent = (p.sum[i] * k).toFixed(3);
  ro.r.textContent = (p.r[i] * k).toFixed(3);
  ro.g.textContent = (p.g[i] * k).toFixed(3);
  ro.b.textContent = (p.b[i] * k).toFixed(3);
}

function rangeText(a, b) {
  const p = state.profile;
  if (calOk()) {
    const n1 = pxToNm(p.x0 + a), n2 = pxToNm(p.x0 + b);
    return `${Math.min(n1, n2).toFixed(0)}–${Math.max(n1, n2).toFixed(0)} nm`;
  }
  return `pixels ${p.x0 + a}–${p.x0 + b}`;
}

function updateStatus() {
  let t = 'No image yet';
  const p = state.profile;
  if (state.W) {
    const size = `${state.W}×${state.H}`;
    if (state.kind === 'photo') t = `Photo ${size}${state.p3 ? ' P3' : ''}`;
    else if (state.frozen) t = `Frozen ${size}`;
    else t = `Live ${size}`;
  }
  if (els.srcStatus.textContent !== t) els.srcStatus.textContent = t;
  // brightest part of the band, as a share of full scale: the thing to watch while setting exposure
  const badge = p ? `Peak ${Math.round(p.peakRaw / 2.55)}%${p.frames > 1 ? `, ${p.frames} frames` : ''}` : '';
  if (els.viewBadge.textContent !== badge) els.viewBadge.textContent = badge;
  els.viewBadge.hidden = !badge;

  const notes = [];
  if (p) {
    const ranges = core.clippedRanges(p.clip);
    if (ranges.length) {
      const shown = ranges.slice(0, 3).map(([a, b]) => rangeText(a, b)).join(', ');
      notes.push(['warn', `Too bright at ${shown}${ranges.length > 3 ? ' and more' : ''}: pixels there are at full scale, so the top is cut off. Lower the exposure or the light.`]);
    } else if (p.peakRaw < 40) {
      notes.push(['info', `Weak signal: the brightest part of the band is ${Math.round(p.peakRaw / 2.55)}% of full scale. Use more light, a longer exposure or more averaging.`]);
    }
    if (state.settings.subtractBg && !(p.strips && p.strips.length)) {
      notes.push(['info', 'No room above or below the spectrum to measure stray light, so nothing was subtracted.']);
    }
    if (!state.points.length && p.peakRaw >= 40 && core.redBlueTrend(p.r, p.b) < -0.25) {
      notes.push(['info', 'Red seems to be on the left. If the spectrum is reversed, tap Flip left-right in the Source tab.']);
    }
  }
  const key = notes.map((n) => n.join(':')).join('|');
  if (key === state.noticeKey) return;
  state.noticeKey = key;
  els.notices.textContent = '';
  for (const [kind, text] of notes) {
    const row = document.createElement('p');
    row.className = 'notice ' + kind;
    const ico = document.createElement('span');
    ico.className = 'ico'; ico.setAttribute('aria-hidden', 'true');
    ico.textContent = kind === 'warn' ? '!' : 'i';
    const body = document.createElement('span');
    body.textContent = (kind === 'warn' ? 'Warning. ' : '') + text;
    row.appendChild(ico); row.appendChild(body);
    els.notices.appendChild(row);
  }
}

function render() {
  try {
    drawView();
    drawSpectrum();
    updateReadout();
    updateStatus();
  } catch (e) { logError('render', e); }
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// ---------------------------------------------------------------- controls

function updateButtons() {
  const on = !!state.stream;
  els.btnCamera.textContent = on ? 'Stop camera' : 'Start camera';
  els.btnCamera.classList.toggle('primary', !on);
  els.btnFreeze.disabled = !on;
  els.btnFreeze.textContent = state.frozen ? 'Resume' : 'Freeze';
  els.btnFlip.setAttribute('aria-pressed', String(!!state.settings.flip));
}

function syncOutputs() {
  const s = state.settings;
  els.bandPosOut.textContent = `${Number(s.bandPos).toFixed(1)}%`;
  els.bandHOut.textContent = state.H ? `${Math.max(1, Math.round(s.bandH / 100 * state.H))} rows` : `${Number(s.bandH).toFixed(1)}%`;
  els.x0Out.textContent = `${Number(s.x0).toFixed(1)}%`;
  els.x1Out.textContent = `${Number(s.x1).toFixed(1)}%`;
  els.tiltOut.textContent = `${Number(s.tilt).toFixed(1)}°`;
}

function syncControls() {
  const s = state.settings;
  for (const id of ['bandPos', 'bandH', 'x0', 'x1', 'tilt']) els[id].value = s[id];
  for (const id of ['linearise', 'subtractBg', 'normalise', 'labelPeaks']) els[id].checked = !!s[id];
  els.gWeight.value = String(s.gWeight);
  els.average.value = String(s.average);
  els.resolution.value = String(s.resolution);
  els.snap.value = s.snap;
  els.refLines.value = s.refLines;
  els.name.value = s.name;
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(!!s[c.dataset.series])));
  syncOutputs();
  updateButtons();
}

const REMEASURE = new Set(['bandPos', 'bandH', 'x0', 'x1', 'linearise', 'subtractBg', 'tilt']);

function setSetting(key, value) {
  const s = state.settings;
  s[key] = value;
  if (key === 'x0' && s.x1 < s.x0 + 5) { s.x1 = Math.min(100, s.x0 + 5); els.x1.value = s.x1; }
  if (key === 'x1' && s.x0 > s.x1 - 5) { s.x0 = Math.max(0, s.x1 - 5); els.x0.value = s.x0; }
  if (key === 'x0' || key === 'x1') state.view = null;
  saveStore();
  syncOutputs();
  if (key === 'rot' || key === 'flip') { if (state.W) { configureFrame(); reprocess(); } updateButtons(); }
  else if (REMEASURE.has(key)) reprocess();
  else if (key === 'gWeight') buildProfile();
  requestRender();
}

function bindRange(id) {
  els[id].addEventListener('input', () => setSetting(id, Number(els[id].value)));
}

function wire() {
  ['bandPos', 'bandH', 'x0', 'x1', 'tilt'].forEach(bindRange);
  document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
    const input = els[b.dataset.for];
    const step = Number(input.step) || 1;
    const v = core.clamp(Number(input.value) + Number(b.dataset.dir) * step, Number(input.min), Number(input.max));
    input.value = String(Math.round(v * 1000) / 1000);
    setSetting(b.dataset.for, Number(input.value));
  }));
  ['linearise', 'subtractBg', 'normalise', 'labelPeaks'].forEach((id) => els[id].addEventListener('change', () => setSetting(id, els[id].checked)));
  els.gWeight.addEventListener('change', () => setSetting('gWeight', Number(els.gWeight.value)));
  els.average.addEventListener('change', () => setSetting('average', Number(els.average.value)));
  els.snap.addEventListener('change', () => setSetting('snap', els.snap.value));
  els.refLines.addEventListener('change', () => setSetting('refLines', els.refLines.value));
  els.name.addEventListener('input', () => setSetting('name', els.name.value));
  els.resolution.addEventListener('change', () => {
    setSetting('resolution', els.resolution.value);
    if (state.stream) startCamera(state.track && state.track.getSettings ? state.track.getSettings().deviceId : null, true);
  });

  els.btnCamera.addEventListener('click', () => {
    if (state.stream) { stopCamera(); updateButtons(); buildCameraControls(); }
    else startCamera(null, false);
  });
  els.btnFreeze.addEventListener('click', toggleFreeze);
  els.btnPhoto.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => { const f = els.file.files && els.file.files[0]; els.file.value = ''; loadPhoto(f); });
  els.cameraSelect.addEventListener('change', () => {
    const d = state.devices.find((x) => x.deviceId === els.cameraSelect.value);
    if (d) { state.settings.cameraLabel = d.label || ''; saveStore(); startCamera(d.deviceId, true); }
  });
  els.btnRotate.addEventListener('click', () => setSetting('rot', (state.settings.rot + 90) % 360));
  els.btnFlip.addEventListener('click', () => setSetting('flip', !state.settings.flip));

  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    const key = c.dataset.series;
    setSetting(key, !state.settings[key]);
    c.setAttribute('aria-pressed', String(state.settings[key]));
  }));

  // drag on the picture to move the band
  let dragging = false;
  const moveBand = (e) => {
    const f = state.viewFit;
    if (!f) return;
    const r = els.view.getBoundingClientRect();
    const row = (e.clientY - r.top - f.dy) / f.k;
    const v = core.clamp(Math.round(row / state.H * 1000) / 10, 0, 100);
    els.bandPos.value = v;
    setSetting('bandPos', v);
  };
  els.view.addEventListener('pointerdown', (e) => { dragging = true; try { els.view.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } moveBand(e); e.preventDefault(); });
  els.view.addEventListener('pointermove', (e) => { if (dragging) moveBand(e); });
  ['pointerup', 'pointercancel'].forEach((n) => els.view.addEventListener(n, () => { dragging = false; }));

  // touch the plot to place the cursor; it snaps when the finger lifts
  let plotting = false;
  const moveCursor = (e, done) => {
    const g = state.geom, p = state.profile;
    if (!g || !p) return;
    const r = els.plot.getBoundingClientRect();
    const frac = core.clamp((e.clientX - r.left - g.left) / Math.max(1, g.right - g.left), 0, 1);
    let px = g.xa + frac * (g.xb - g.xa);
    if (done && state.settings.snap !== 'off') {
      // look about a fingertip either side: 14 screen pixels, converted to image columns
      const half = Math.max(4, 14 * (g.xb - g.xa) / Math.max(1, g.right - g.left));
      px = p.x0 + core.snapFeature(p.sum, px - p.x0, state.settings.snap, half, Math.max(0.8, p.n / 2000)).pos;
    }
    state.cursorPx = core.clamp(px, p.x0, p.x0 + p.n - 1);
    requestRender();
  };
  els.plot.addEventListener('pointerdown', (e) => { plotting = true; try { els.plot.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } moveCursor(e, false); e.preventDefault(); });
  els.plot.addEventListener('pointermove', (e) => { if (plotting) moveCursor(e, false); });
  els.plot.addEventListener('pointerup', (e) => { if (plotting) { plotting = false; moveCursor(e, true); } });
  els.plot.addEventListener('pointercancel', () => { plotting = false; });

  const nudge = (d) => {
    const p = state.profile;
    if (!p) return;
    const cur = state.cursorPx === null ? p.x0 + p.n / 2 : state.cursorPx;
    state.cursorPx = core.clamp(cur + d, p.x0, p.x0 + p.n - 1);
    requestRender();
  };
  els.nudgeL.addEventListener('click', () => nudge(-1));
  els.nudgeR.addEventListener('click', () => nudge(1));
  const zoom = (f) => {
    const p = state.profile;
    if (!p) return;
    const full = [p.x0, p.x0 + p.n - 1], cur = state.view || full;
    const c = state.cursorPx !== null ? state.cursorPx : (cur[0] + cur[1]) / 2;
    const half = Math.max(10, (cur[1] - cur[0]) / 2 * f);
    if (2 * half >= full[1] - full[0]) state.view = null;
    else {
      let a = c - half, b = c + half;
      if (a < full[0]) { b += full[0] - a; a = full[0]; }
      if (b > full[1]) { a -= b - full[1]; b = full[1]; }
      state.view = [Math.max(full[0], a), b];
    }
    requestRender();
  };
  els.zoomIn.addEventListener('click', () => zoom(0.5));
  els.zoomOut.addEventListener('click', () => zoom(2));
  els.zoomFull.addEventListener('click', () => { state.view = null; requestRender(); });

  // calibration
  for (const g of core.LINE_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.name;
    for (const line of g.lines) {
      const o = document.createElement('option');
      o.value = `${g.id}:${line.nm}`;
      o.textContent = `${line.nm} nm, ${line.name}`;
      og.appendChild(o);
    }
    els.preset.appendChild(og);
    const r = document.createElement('option');
    r.value = g.id; r.textContent = g.name;
    els.refLines.appendChild(r);
  }
  els.preset.addEventListener('change', () => {
    const [group, nm] = els.preset.value.split(':');
    if (!nm) return;
    els.nm.value = nm;
    const mode = group === 'sun' ? 'dip' : 'peak';   // sunlight lines are dark, lamp and laser lines bright
    els.snap.value = mode;
    setSetting('snap', mode);
  });
  els.btnAddPoint.addEventListener('click', addPoint);
  els.btnShift.addEventListener('click', shiftToMatch);
  els.btnClearPoints.addEventListener('click', () => {
    if (state.points.length && window.confirm('Remove every marked line for this camera and orientation?')) { state.points = []; refit(); }
  });

  // saving
  els.btnSaveAll.addEventListener('click', () => save(['csv', 'json', 'plot', 'frame']));
  els.btnSaveCsv.addEventListener('click', () => save(['csv', 'json']));
  els.btnSavePlot.addEventListener('click', () => save(['plot']));
  els.btnSaveFrame.addEventListener('click', () => save(['frame']));

  // more
  els.btnDiagRefresh.addEventListener('click', () => { els.diag.textContent = diagnostics(); });
  els.btnDiagCopy.addEventListener('click', copyDiagnostics);
  els.btnResetSettings.addEventListener('click', () => {
    if (!window.confirm('Put every setting back to its starting value? Calibrations are kept.')) return;
    state.settings = { ...DEFAULTS };
    saveStore(); syncControls();
    if (state.W) { configureFrame(); reprocess(); }
    requestRender();
  });
  els.btnResetCals.addEventListener('click', () => {
    if (!window.confirm('Delete every saved calibration on this device?')) return;
    state.cals = {}; state.points = [];
    refit();
  });

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  if (window.ResizeObserver) {
    const obs = new ResizeObserver(() => requestRender());
    obs.observe(els.viewWrap); obs.observe(els.plotWrap);
  }
  window.addEventListener('resize', requestRender);
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { colorCache = null; requestRender(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.stream && state.track && state.track.readyState === 'ended') onTrackEnded();
    else if (isLive()) startLoop();
    requestRender();
  });
}

function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'more') els.diag.textContent = diagnostics();
  requestRender();
}

// ---------------------------------------------------------------- saving

function stamp() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function baseName() {
  const raw = String(state.settings.name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${raw || 'spectrum'}_${stamp()}`;
}

function dataUrlToBlob(url) {
  const comma = url.indexOf(',');
  const mime = url.slice(5, url.indexOf(';'));
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function settingsRecord() {
  const p = state.profile, s = state.settings, cal = state.cal;
  let camera = null;
  if (state.kind === 'live' && state.track && state.track.getSettings) {
    try { camera = { ...state.track.getSettings() }; delete camera.deviceId; delete camera.groupId; } catch (e) { camera = null; }
  }
  return {
    app: 'spectroscope-web', version: core.VERSION, saved_at: new Date().toISOString(), name: s.name,
    source: {
      kind: state.kind, frozen: state.frozen, camera_label: state.kind === 'live' ? state.trackLabel : '',
      source_size: [state.srcW, state.srcH], frame_size: [state.W, state.H], display_p3: state.p3,
      rotation_deg: s.rot, flipped: s.flip, tilt_deg: s.tilt, camera_settings: camera,
    },
    band: { first_column: p.x0, columns: p.n, first_row: p.y0, rows: p.hRows, frames_averaged: p.frames },
    processing: {
      srgb_gamma_undone: s.linearise, stray_light_subtracted: s.subtractBg && !!(p.strips && p.strips.length),
      stray_light_strips_rows: p.strips || [], intensity: s.gWeight === 1 ? 'R + G + B' : `R + ${s.gWeight} G + B`,
      peak_pixel_code: Math.round(p.peakRaw * 10) / 10,
      clipped_columns: core.clippedRanges(p.clip).map(([a, b]) => [p.x0 + a, p.x0 + b]),
    },
    calibration: {
      calibrated: !!cal.ok,
      note: 'wavelength_nm = polynomial in (pixel - frame_width / 2); coefficients highest power first',
      wavelength_coeffs: cal.ok ? cal.coeffs : null,
      points: state.points.map((q) => ({ px_offset: q.off, nm: q.nm })),
      rms_nm: cal.ok ? cal.rms : null,
    },
  };
}

function makeFiles(kinds, base) {
  const p = state.profile, files = [];
  for (const kind of kinds) {
    if (kind === 'csv') {
      let nm = null;
      if (calOk()) { nm = new Float64Array(p.n); for (let i = 0; i < p.n; i++) nm[i] = pxToNm(p.x0 + i); }
      const text = core.buildCsv({ x0: p.x0, r: p.r, g: p.g, b: p.b, intensity: p.sum, clip: p.clip, nm });
      files.push(new File([text], `${base}.csv`, { type: 'text/csv' }));
    } else if (kind === 'json') {
      files.push(new File([JSON.stringify(settingsRecord(), null, 2)], `${base}_settings.json`, { type: 'application/json' }));
    } else if (kind === 'plot') {
      files.push(new File([dataUrlToBlob(els.plot.toDataURL('image/png'))], `${base}_plot.png`, { type: 'image/png' }));
    } else if (kind === 'frame') {
      files.push(new File([dataUrlToBlob(state.fc.c.toDataURL('image/jpeg', 0.92))], `${base}_image.jpg`, { type: 'image/jpeg' }));
    }
  }
  return files;
}

function save(kinds) {
  if (!state.profile) { toast('Start the camera or load a photo first.'); return; }
  let files;
  try { files = makeFiles(kinds, baseName()); }
  catch (e) { logError('save', e); toast('The files could not be made.'); return; }
  // On a phone, hand the files to the share sheet. It has to be called directly from the tap.
  if (COARSE && navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files }).then(
      () => { els.saveStatus.textContent = `Handed ${files.length} file${files.length > 1 ? 's' : ''} to the share sheet.`; },
      (e) => {
        if (e && e.name === 'AbortError') { els.saveStatus.textContent = 'Cancelled.'; return; }
        logError('share', e);
        download(files);
      },
    );
    return;
  }
  download(files);
}

function download(files) {
  files.forEach((f, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a');
      a.href = url; a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, i * 300);
  });
  els.saveStatus.textContent = `Saved ${files.map((f) => f.name).join(', ')} to this device's downloads.`;
}

// ---------------------------------------------------------------- diagnostics

function diagnostics() {
  const t = state.track;
  const tidy = (o) => { if (!o) return o; const c = { ...o }; delete c.deviceId; delete c.groupId; return c; };
  let caps = null, sett = null, supported = [];
  try { if (t && t.getCapabilities) caps = tidy(t.getCapabilities()); } catch (e) { caps = 'error'; }
  try { if (t && t.getSettings) sett = tidy(t.getSettings()); } catch (e) { sett = 'error'; }
  try { supported = Object.keys(navigator.mediaDevices.getSupportedConstraints()); } catch (e) { supported = []; }
  const v = els.video;
  let share = false;
  try { share = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] })); } catch (e) { share = false; }
  return JSON.stringify({
    app: core.VERSION,
    time: new Date().toISOString(),
    browser: navigator.userAgent,
    home_screen_app: !!(navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)),
    secure_context: window.isSecureContext,
    screen: `${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}`,
    window: `${window.innerWidth}x${window.innerHeight}`,
    p3_canvas: P3_OK, can_share_files: share, touch: COARSE, offline_copy: state.sw,
    source: {
      kind: state.kind, frozen: state.frozen, source_size: `${state.srcW}x${state.srcH}`, frame_size: `${state.W}x${state.H}`,
      display_p3: state.p3, live_frames_processed: state.frameCount,
      video: { ready: v.readyState, size: `${v.videoWidth}x${v.videoHeight}`, paused: v.paused },
    },
    camera: { label: state.trackLabel, cameras_listed: state.devices.map((d) => d.label), settings: sett, capabilities: caps, constraints_known: supported },
    settings: state.settings,
    calibrations_saved: Object.keys(state.cals),
    errors: state.errors,
  }, null, 1);
}

function copyDiagnostics() {
  const text = diagnostics();
  els.diag.textContent = text;
  const fallback = () => {
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(els.diag);
    sel.removeAllRanges(); sel.addRange(range);
    toast('Text selected. Use Copy from the menu.');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Copied.'), fallback);
  else fallback();
}

// ---------------------------------------------------------------- start

loadStore();
buildReadout();
wire();
syncControls();
renderCalibration();
els.version.textContent = `Version ${core.VERSION}`;
requestRender();

if ('serviceWorker' in navigator && !location.search.includes('nosw') &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').then(
    () => { state.sw = 'ready'; },
    (e) => { state.sw = 'failed'; logError('service worker', e); },
  );
}

// for the test scripts and for poking around in a desktop browser console
window.spectroscope = { state, core, reprocess, loadPhoto, render };
