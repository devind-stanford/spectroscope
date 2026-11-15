// Spectroscope web app: camera or photo -> sampling band -> R, G, B and combined
// profiles -> wavelength calibration -> files. Everything runs in the browser.

import * as core from './core.js';
import { drawPlot, drawCalPlot } from './plot.js';
import { SOLAR } from './solar.js';

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
  snap: 'peak', refLines: 'none', cameraLabel: '', name: 'spectrum', autoSource: 'lamp', colourWb: 'd65',
  follow: true, bigOnStart: true, keepFixed: true, labelFeatures: false, bigZoom: false,
};
const LABEL_KINDS = { lamp: 'lamp', sun: 'sun' };   // which lights have lines to label
const AUTO_SOURCES = ['lamp', 'sun', 'colour'];
const FIND_EVERY_MS = 500;     // how often the live view looks for the spectrum when following it
const NOTICE_MS = 6000;        // how long warnings stay on the picture after a capture

const $ = (id) => document.getElementById(id);
const els = {};
['view', 'viewWrap', 'viewHint', 'viewBadge', 'plot', 'plotWrap', 'readout', 'notices', 'srcStatus', 'calStatus',
  'btnCamera', 'btnFreeze', 'btnPhoto', 'cameraRow', 'cameraSelect', 'resolution', 'average',
  'btnRotate', 'btnFlip', 'tilt', 'tiltOut', 'camControls', 'camNone',
  'bandPos', 'bandPosOut', 'bandH', 'bandHOut', 'x0', 'x0Out', 'x1', 'x1Out',
  'linearise', 'subtractBg', 'normalise', 'labelPeaks', 'gWeight',
  'fitSummary', 'calPlotHead', 'calPlotWrap', 'calPlot', 'calPlotNote', 'btnLabels', 'featureHead', 'featureList', 'featureNote', 'autoSource', 'btnAuto', 'autoStatus', 'colourBox', 'colourWbRow', 'colourWb', 'colourNote', 'btnKeepColours', 'btnForgetColours', 'snap', 'preset', 'nm', 'btnKeepLine', 'btnAddPoint', 'btnShift', 'pointsHead', 'pointList', 'btnClearPoints', 'refLines',
  'name', 'btnSaveAll', 'btnSaveCsv', 'btnSavePlot', 'btnSaveFrame', 'saveStatus',
  'btnDiagRefresh', 'btnDiagCopy', 'diag', 'btnResetSettings', 'btnResetCals', 'version',
  'nudgeL', 'nudgeR', 'zoomIn', 'zoomOut', 'zoomFull', 'toast', 'video', 'file',
  'ovRotate', 'ovBig', 'bigBar', 'bigCapture', 'bigFind', 'bigZoom', 'bigRotate', 'bigExit',
  'btnBig', 'btnFind', 'bigOnStart', 'keepFixed', 'follow',
].forEach((id) => { els[id] = $(id); });
const appEl = document.querySelector('.app');

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
  colourRefs: {},      // each camera's own colours, kept from a calibrated capture (see colourKey)
  myLines: [],         // wavelengths the user chose to keep in the Known line list: [{ nm }]
  kind: null,          // 'live' or 'photo'
  frozen: false,
  srcEl: null, srcW: 0, srcH: 0, dw: 0, dh: 0, p3: false,
  W: 0, H: 0, fc: null,
  stream: null, track: null, trackLabel: '', devices: [],
  raf: 0, lastTick: 0, frameCount: 0,
  avg: [], avgKey: '', edges: null,
  profile: null, norm: 1,
  cursorPx: null, view: null, geom: null, viewFit: null, zoomHold: null,
  sig: '', points: [], cal: core.fitCalibration([], 1), autoInfo: null,
  errors: [], sw: 'not registered', noticeKey: '', photoUrl: null, photoName: '', hold: null,
  comp: 0,             // extra quarter turns that undo the browser turning camera frames with the screen
  holdComp: 0,         // the same, for the captured frame
  rotatesWithScreen: null,   // does this browser turn camera frames when the screen turns? (learnt)
  big: false, lastFind: 0, findState: '', noticesUntil: 0, noticeTimer: 0,
  features: [],        // labelled features of the current spectrum: [{ px, nm, tag, lines }]
  featureKey: '',
};

// ---------------------------------------------------------------- storage

function loadStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.settings) state.settings = { ...DEFAULTS, ...d.settings };
    if (d && d.cals) state.cals = d.cals;
    if (d && d.colourRefs && typeof d.colourRefs === 'object') state.colourRefs = d.colourRefs;
    if (d && Array.isArray(d.lines)) {
      state.myLines = d.lines.map((l) => ({ nm: Number(l && l.nm) })).filter((l) => l.nm >= 200 && l.nm <= 1200);
    }
  } catch (e) { logError('storage', e); }
}

let saveTimer = 0;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ settings: state.settings, cals: state.cals, colourRefs: state.colourRefs, lines: state.myLines })); }
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
  const turned = (s.rot + frameComp()) % 180 !== 0;
  const W = turned ? dh : dw, H = turned ? dw : dh;
  if (W !== state.W) state.cursorPx = null;
  state.W = W; state.H = H;
  state.fc = frameFor(state.kind === 'photo' && state.p3);
  if (state.fc.c.width !== W || state.fc.c.height !== H) { state.fc.c.width = W; state.fc.c.height = H; }
  state.avg = []; state.edges = null; state.view = null;
  loadCalibration();
  syncOutputs();
  updateButtons();
}

/** Quarter turns (degrees) added to the source so that the analysed frame stays fixed to the
 *  phone: the live compensation, the one stored with a captured frame, or none for a photo. */
function frameComp() {
  if (state.kind !== 'live') return 0;
  return state.frozen ? state.holdComp : state.comp;
}

/** Total clockwise rotation (degrees) applied to the source. */
function frameAngle() {
  const s = state.settings;
  return s.rot + frameComp() + s.tilt;
}

/** Draw the source into the analysed frame: rotate in quarter turns, tilt, then mirror. */
function drawFrame() {
  const s = state.settings, ctx = state.fc.ctx, W = state.W, H = state.H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  if (s.flip) ctx.scale(-1, 1);
  ctx.rotate(frameAngle() * Math.PI / 180);
  ctx.drawImage(state.srcEl, -state.dw / 2, -state.dh / 2, state.dw, state.dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------------------------------------------------------------- turning the phone

/** How far the screen is turned from upright, in degrees: 0, 90 (top of the phone to the left),
 *  -90 (to the right) or 180. */
function deviceTurn() {
  const f = window.spectroscope && window.spectroscope.forceTurn;
  let a = typeof f === 'number' ? f
    : typeof window.orientation === 'number' ? window.orientation
      : (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0;
  a = ((Math.round(a / 90) * 90) % 360 + 360) % 360;
  return a === 270 ? -90 : a;
}

/** Phones turn camera frames to match the screen; this undoes that, so the picture stays fixed
 *  to the phone. Whether this browser does it is learnt from the frame shape when the screen turns. */
function liveComp(vw, vh) {
  if (!state.settings.keepFixed) return 0;
  const t = deviceTurn(), wide = vw > vh;
  if (t === 90 || t === -90) {
    if (!wide) state.rotatesWithScreen = false;            // sideways screen, upright frames: not turned
    else if (state.rotatesWithScreen === null) state.rotatesWithScreen = COARSE;
  } else if (t === 0 && wide && COARSE) {
    state.rotatesWithScreen = false;                        // upright phone giving wide frames: not turned
  }
  return state.rotatesWithScreen ? t : 0;
}

/** Turn the whole app back when a phone is held sideways, so it looks the same as upright. */
function applyScreenTurn() {
  const t = deviceTurn();
  const forced = !!(window.spectroscope && typeof window.spectroscope.forceTurn === 'number');   // test hook
  const phone = forced || (COARSE && Math.min(screen.width || 0, screen.height || 0) < 600);
  const turn = state.settings.keepFixed && phone && (t === 90 || t === -90) && window.innerWidth > window.innerHeight ? t : 0;
  const want = turn ? String(turn) : null;
  if (document.documentElement.getAttribute('data-turn') !== want) {
    if (want) document.documentElement.setAttribute('data-turn', want);
    else document.documentElement.removeAttribute('data-turn');
    requestRender();
  }
}

// ---------------------------------------------------------------- finding the spectrum

let finder = null;
/** Look for the colourful band in the analysed frame (see core.findSpectrumBox). */
function detectBand() {
  if (!state.fc || !state.W) return null;
  if (!finder) finder = document.createElement('canvas');
  const fw = 320, fh = Math.max(8, Math.round(320 * state.H / state.W));
  if (finder.width !== fw || finder.height !== fh) { finder.width = fw; finder.height = fh; }
  const fctx = finder.getContext('2d', { willReadFrequently: true });
  fctx.drawImage(state.fc.c, 0, 0, fw, fh);
  return core.findSpectrumBox(fctx.getImageData(0, 0, fw, fh).data, fw, fh);
}

/** Move the band onto a found spectrum: its middle 60 % in height, its full length plus a margin
 *  of 3 % of the frame at each end, so the dim violet and red ends are kept. */
function applyBox(box, gentle) {
  const s = state.settings;
  const target = {
    bandPos: (box.y0 + box.y1) / 2 * 100,
    bandH: core.clamp((box.y1 - box.y0) * 60, 0.3, 60),
    x0: core.clamp(box.x0 * 100 - 3, 0, 90),
    x1: core.clamp(box.x1 * 100 + 3, 10, 100),
  };
  if (target.x1 < target.x0 + 5) target.x1 = Math.min(100, target.x0 + 5);
  let changed = false;
  for (const k of ['bandPos', 'bandH', 'x0', 'x1']) {
    const d = target[k] - s[k];
    // while following, small changes are ignored so the band does not jitter
    if (Math.abs(d) <= (gentle ? { bandPos: 0.4, bandH: 0.3, x0: 0.8, x1: 0.8 }[k] : 0.05)) continue;
    s[k] = Math.round((gentle ? s[k] + 0.6 * d : target[k]) * 10) / 10;
    els[k].value = s[k];
    changed = true;
  }
  if (changed) { state.view = null; state.avg = []; syncOutputs(); renderCalibration(); saveStore(); }
  return changed;
}

/** One-shot search (button): turns the picture if the spectrum runs up and down, levels it with
 *  the tilt so it runs straight across, then places the band. */
function findSpectrum() {
  if (!state.W) { toast('Start the camera or load a photo first.'); return; }
  try {
    if (!isLive()) drawFrame();
    let box = detectBand();
    if (box && box.vertical) {
      setSetting('rot', (state.settings.rot + 90) % 360);
      drawFrame();
      box = detectBand();
    }
    // A mirrored frame turns the other way (see drawFrame), so the correction changes sign with Flip.
    // Twice, since the first turn brings more of the band into view.
    let turned = 0;
    for (let k = 0; k < 2 && box && !box.vertical && box.angle !== null && Math.abs(box.angle) > 0.3; k++) {
      const s = state.settings;
      const next = core.clamp(Math.round((s.tilt + (s.flip ? box.angle : -box.angle)) * 10) / 10, -45, 45);
      if (next === s.tilt) break;
      turned += next - s.tilt;
      els.tilt.value = next;
      setSetting('tilt', next);
      drawFrame();
      box = detectBand();
    }
    if (!box || box.vertical) {
      toast('No spectrum found. Point the spectroscope at a light and check that the rainbow is in the picture.');
      return;
    }
    applyBox(box, false);
    if (isLive()) { setSetting('follow', true); els.follow.checked = true; }
    reprocess();
    toast(Math.abs(turned) >= 0.1 ? `Band placed on the spectrum; the picture was turned ${Math.abs(turned).toFixed(1)}° to level it (Tilt ${state.settings.tilt.toFixed(1)}°).` : 'Band placed on the spectrum.', 4500);
  } catch (e) { logError('find spectrum', e); }
}

// ---------------------------------------------------------------- big view

function setBig(on) {
  state.big = !!on;
  appEl.classList.toggle('big', state.big);
  updateButtons();
  requestRender();
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
function measure(now, force, lutOverride) {
  const q = bandRect(), ctx = state.fc.ctx, s = state.settings;
  const lut = lutOverride || (s.linearise ? LUT_LIN : LUT_RAW);
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
        const comp = liveComp(v.videoWidth, v.videoHeight);
        if (v.videoWidth !== state.srcW || v.videoHeight !== state.srcH || comp !== state.comp) {
          state.srcW = v.videoWidth; state.srcH = v.videoHeight; state.comp = comp;
          configureFrame();
        }
        drawFrame();
        if (state.settings.follow && t - state.lastFind >= FIND_EVERY_MS) {
          state.lastFind = t;
          const box = detectBand();
          state.findState = !box ? 'none' : box.vertical ? 'vertical' : 'found';
          if (box && !box.vertical) applyBox(box, true);
        }
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
  if (state.big) setBig(false);
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
  state.rotatesWithScreen = null; state.comp = 0; state.noticesUntil = 0;
  els.viewHint.hidden = true;
  await refreshCameraList();
  // go back to the lens chosen last time, if this is a different one
  const want = state.settings.cameraLabel;
  if (!explicit && want && want !== state.trackLabel) {
    const d = state.devices.find((x) => x.label === want);
    if (d) return startCamera(d.deviceId, true);
  }
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(() => {}); } catch (e) { /* not offered */ }
  buildCameraControls();
  if (state.settings.bigOnStart) setBig(true);
  updateButtons();
  startLoop();
}

/** Show the warnings over the picture for a few seconds (after a capture or a photo). */
function flashNotices() {
  state.noticesUntil = performance.now() + NOTICE_MS;
  state.noticeKey = null;   // never equal to a real key, so the list is rebuilt (or emptied) on the next render
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(requestRender, NOTICE_MS + 50);
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
    state.holdComp = state.comp;   // the captured frame keeps the turn it had, whatever the phone does next
    state.frozen = true;
    flashNotices();
    if (state.big) setBig(false);   // show the controls for working on the capture
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
    flashNotices();
    buildCameraControls();
    if (state.big) setBig(false);
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
  state.points = saved && Array.isArray(saved.points)
    ? saved.points.map((p) => (p.src ? { off: Number(p.off), nm: Number(p.nm), src: String(p.src) } : { off: Number(p.off), nm: Number(p.nm) }))
    : [];
  state.autoInfo = saved && saved.auto ? saved.auto : null;
  refit(false);
}

function refit(save = true) {
  state.points.sort((a, b) => a.off - b.off);   // listed left to right, however they were added
  if (!state.points.length) state.autoInfo = null;
  state.cal = core.fitCalibration(state.points, state.W || 1);
  if (save) {
    if (state.points.length) state.cals[state.sig] = { points: state.points, auto: state.autoInfo, savedAt: new Date().toISOString() };
    else delete state.cals[state.sig];
    saveStore();
  }
  renderCalibration();
  requestRender();
}

function signed(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2); }

/** What makes a line of sunlight or of a lamp at about this wavelength, from the catalogue. */
function causeOf(kind, nm, tol = 2) {
  let best = null;
  for (const f of core.FEATURES[kind] || []) if (Math.abs(f.nm - nm) <= tol && (!best || Math.abs(f.nm - nm) < Math.abs(best.nm - nm))) best = f;
  return best;
}

function renderCalibration() {
  const cal = state.cal, list = els.pointList;
  list.textContent = '';
  state.points.forEach((p, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${p.nm.toFixed(1)} nm at pixel ${(p.off + state.W / 2).toFixed(1)}`;
    if (p.src) {
      const tag = document.createElement('small');
      tag.textContent = p.src === 'sun' ? '  from sunlight' : p.src === 'colour' ? '  from colours' : '  from lamp';
      const why = p.src === 'sun' || p.src === 'lamp' ? causeOf(p.src, p.nm) : null;
      if (why) tag.textContent += `: ${why.tag}, ${why.what}`;
      span.appendChild(tag);
    }
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
    // the range across the sampling band, not the whole frame: far outside the marked lines the fit means nothing
    const q = state.W ? bandRect() : { xa: 0, n: 1 };
    const na = pxToNm(q.xa), nb = pxToNm(q.xa + q.n - 1);
    text = `${cal.degree === 2 ? 'Curved' : 'Straight-line'} fit through ${cal.n} lines: ${slope.toFixed(3)} nm per pixel at the centre, ` +
      `${Math.min(na, nb).toFixed(0)} to ${Math.max(na, nb).toFixed(0)} nm across the band.`;
    if (cal.n > cal.degree + 1) text += ` Typical miss ${cal.rms.toFixed(2)} nm.`;
  }
  for (const w of cal.warnings) text += ' ' + w;
  els.fitSummary.textContent = text;
  els.pointsHead.textContent = `Marked lines (${state.points.length})`;
  els.pointsHead.hidden = !state.points.length;
  els.btnShift.disabled = !cal.ok;
  els.btnClearPoints.disabled = !state.points.length;
  els.calStatus.textContent = cal.ok ? 'Calibrated' : 'Not calibrated';
  els.calStatus.classList.toggle('good', cal.ok);
  updateColourBox();
  renderCalPlot();
}

/** The calibration drawn out (wavelength, departure from a straight line, nm per pixel) and what
 *  that means for resolution. Drawn while the Calibrate tab is open. */
function renderCalPlot() {
  const cal = state.cal;
  const on = cal.ok && state.W > 0;
  els.calPlotWrap.hidden = !on;
  els.calPlotNote.hidden = !on;
  els.calPlotHead.hidden = !on;
  if (!on || !els.calPlotWrap.clientWidth) return;
  const q = bandRect();
  const pts = state.points.map((p) => ({ px: p.off + state.W / 2, nm: p.nm }));
  const span = pts.length ? [Math.min(...pts.map((p) => p.px)), Math.max(...pts.map((p) => p.px))] : [q.xa, q.xa + q.n - 1];
  const { cssW, cssH, dpr } = sizeCanvas(els.calPlot, els.calPlotWrap, 3);
  const g = drawCalPlot(els.calPlot, {
    cssW, cssH, dpr, colors: themeColors(), pxA: q.xa, pxB: q.xa + q.n - 1, nmAt: pxToNm, span, points: pts,
  });
  const na = pxToNm(q.xa), nb = pxToNm(q.xa + q.n - 1);
  const [pa, pb] = g.nmPerPx;
  const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
  const per = Math.abs(hi - lo) < 0.005 ? `${lo.toFixed(2)} nm` : `${pa.toFixed(2)} nm at ${na.toFixed(0)} nm and ${pb.toFixed(2)} nm at ${nb.toFixed(0)} nm`;
  let text = `Each pixel spans ${per}. Detail finer than two pixels (${(2 * lo).toFixed(1)}${hi - lo >= 0.05 ? `–${(2 * hi).toFixed(1)}` : ''} nm) cannot show; the slit and the focus usually blur more than that.`;
  if (cal.degree === 2) text += ` Between the outermost marked lines the fit departs from a straight line by up to ${g.maxDev.toFixed(1)} nm.`;
  else text += ' With two lines the fit is a straight line; a third shows how far the real scale bends.';
  // the resolution actually reached: the width of the sharpest lamp line
  const p = state.profile;
  if (p && state.autoInfo && state.autoInfo.source === 'lamp') {
    let best = null;
    for (const pt of pts) {
      const i = pt.px - p.x0;
      if (i < 3 || i > p.n - 4) continue;
      const wpx = core.peakWidth(p.sum, i, Math.max(6, Math.round(p.n / 30)));
      if (wpx === null) continue;
      const wnm = wpx * Math.abs(pxToNm(pt.px + 0.5) - pxToNm(pt.px - 0.5));
      if (!best || wnm < best.wnm) best = { wnm, wpx, nm: pt.nm };
    }
    if (best) text += ` The sharpest lamp line here, ${best.nm.toFixed(1)} nm, is ${best.wnm.toFixed(1)} nm (${best.wpx.toFixed(1)} pixels) wide at half height: the resolution actually reached.`;
  }
  els.calPlotNote.textContent = text;
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

const AUTO_NAMES = { lamp: 'the lamp', sun: 'sunlight', colour: 'colours' };

/** Which camera a kept colour reference belongs to. Photos go through other colour processing
 *  than the live camera, so they have their own. */
function colourKey() {
  const cam = state.kind === 'live' ? (state.trackLabel || 'camera') : 'photo';
  return `${cam}|${state.p3 ? 'p3' : 'srgb'}`;
}

function keptColours() {
  const k = state.colourRefs[colourKey()];
  return k && Array.isArray(k.r) && Array.isArray(k.trust) ? k : null;
}

/** The profile in linear units, as colour calibration needs, even when the sRGB curve is left on. */
function linearProfile() {
  const p = state.profile;
  if (!p || state.settings.linearise || !state.fc) return p;
  const m = measure(performance.now(), true, LUT_LIN);
  return { ...p, r: m.r, g: m.g, b: m.b, clip: m.clip };
}

function colourReference() {
  return keptColours() || core.colourModel({ white: state.settings.colourWb, space: state.p3 ? 'p3' : 'srgb' });
}

function dateText(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'earlier';
}

/** Show the colour options when calibrating from colours, and say which colours will be used. */
function updateColourBox() {
  const on = els.autoSource.value === 'colour';
  els.colourBox.hidden = !on;
  if (!on) return;
  const kept = keptColours();
  const FROM = { sun: 'a sunlight calibration', lamp: 'a lamp calibration', hand: 'marked lines' };
  els.colourWbRow.hidden = !!kept;
  els.btnForgetColours.hidden = !kept;
  els.colourNote.textContent = kept
    ? `Uses this camera's own colours, kept on ${dateText(kept.savedAt)} from ${FROM[kept.from] || 'a calibrated capture'}. Expect errors of a few nm while the white balance stays about the same.`
    : 'Uses the colours a standard camera gives each wavelength, with the white balance chosen here. Expect errors of about 10 nm. For a better result, calibrate once with a lamp, sunlight or a laser, then point at a white light and tap Keep these colours.';
  els.btnKeepColours.disabled = !calOk() || !!(state.autoInfo && state.autoInfo.source === 'colour');
}

/** Keep the colours of the white light in view, under the current (non-colour) calibration. */
function keepColours(quiet) {
  const p = linearProfile();
  if (!p || !calOk()) { if (!quiet) toast('Calibrate first, with a lamp, sunlight or marked lines.'); return false; }
  if (state.autoInfo && state.autoInfo.source === 'colour') { if (!quiet) toast('This calibration came from colours itself. Calibrate with a lamp, sunlight or marked lines first.'); return false; }
  const from = state.autoInfo ? state.autoInfo.source : 'hand';
  const res = core.colourReferenceFrom(p, (i) => pxToNm(p.x0 + i), { savedAt: new Date().toISOString(), from });
  if (!res.ok) { if (!quiet) toast(res.message, 6000); return false; }
  state.colourRefs[colourKey()] = res.ref;
  saveStore();
  updateColourBox();
  if (!quiet) toast(`Kept these colours: blue turns green at ${res.crossings[0].toFixed(1)} nm, green turns red at ${res.crossings[1].toFixed(1)} nm.`, 6000);
  return true;
}

/** Calibrate from a known light: finds the lines, replaces the marked list, shows lines to compare. */
function runAuto() {
  const src0 = state.profile;
  if (!src0) { toast('Start the camera or load a photo first.'); return; }
  const src = AUTO_SOURCES.includes(els.autoSource.value) ? els.autoSource.value : 'lamp';
  const p = src === 'colour' ? linearProfile() : src0;
  const say = (text) => { els.autoStatus.textContent = text; };
  // a mirrored spectrum is recognised from its colours: red on the left
  if (p.peakRaw >= 20 && core.redBlueTrend(p.r, p.b) < -0.3) {
    say('The spectrum runs from red on the left to blue on the right. Tap Flip left-right in the Source tab, then try again.');
    toast('Flip the spectrum first.');
    return;
  }
  els.btnAuto.disabled = true;
  say('Working…');
  setTimeout(() => {   // let the button and the text update before the search runs
    let res, ref = null;
    try {
      if (src === 'colour') { ref = colourReference(); res = core.autoCalibrateColour(p, p.x0, state.W, ref); }
      else {
        // the colours settle ties between matches: this camera's kept colours, or a standard
        // camera in daylight (the camera balances a lamp or the sky to about white)
        ref = keptColours() || core.colourModel({ white: 'd65', space: state.p3 ? 'p3' : 'srgb' });
        const opts = { rgb: linearProfile(), colourRef: ref };
        res = src === 'sun' ? core.autoCalibrateSun(p.sum, p.x0, state.W, SOLAR, opts) : core.autoCalibrateLamp(p.sum, p.x0, state.W, opts);
      }
    } catch (e) {
      logError('auto-calibrate', e);
      res = { ok: false, message: 'Auto-calibration failed with an error. See More, Diagnostics.', warnings: [] };
    }
    els.btnAuto.disabled = false;
    if (!res.ok) { say(res.message); toast('Auto-calibration did not work. See the Calibrate tab.'); return; }
    if (state.points.length && !window.confirm(`Replace the ${state.points.length} marked line${state.points.length > 1 ? 's' : ''} with the automatic calibration?`)) {
      say('Not applied: the marked lines were kept.');
      return;
    }
    state.points = res.points.map((q) => ({ off: q.off, nm: q.nm, src: q.src }));
    state.autoInfo = { source: src, match: res.r === undefined ? null : Math.round(res.r * 1000) / 1000, lines: res.points.length, at: new Date().toISOString() };
    const round3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);
    state.autoInfo.colours = ref.kind === 'model' ? `standard camera model, white balance ${ref.white}, ${ref.space}` : `kept ${ref.savedAt || ''} from ${ref.from || 'a calibrated capture'}`;
    if (src === 'colour') state.autoInfo.colour_mismatch = round3(res.mismatch);
    else { state.autoInfo.colour_mismatch = round3(res.colourMismatch); state.autoInfo.colours_decided = !!res.coloursDecided; }
    refit();
    const extra = [];
    // sunlight is a white light with a known calibration: keep its colours for later, if none are kept yet
    if (src === 'sun' && !keptColours() && keepColours(true)) extra.push('Its colours were also kept, for calibrating from colours later.');
    if (p.hRows < 6) extra.push(`The band is only ${p.hRows} row${p.hRows > 1 ? 's' : ''} tall, which makes the curves noisy: level the spectrum with Find spectrum or Tilt, then use a taller band.`);
    say([res.message, ...res.warnings, ...extra].join(' '));
    if (src !== 'colour') {
      els.refLines.value = src === 'sun' ? 'sun' : 'fluor';
      setSetting('refLines', els.refLines.value);
      els.snap.value = src === 'sun' ? 'dip' : 'peak';
      setSetting('snap', els.snap.value);
      setLabels(true);   // name what makes the lines that were found
    }
    updateColourBox();
    toast(`Calibrated from ${AUTO_NAMES[src]}.`);
  }, 30);
}

/** Turn the feature labels on or off. */
function setLabels(on) {
  setSetting('labelFeatures', !!on);
  els.btnLabels.setAttribute('aria-pressed', String(!!on));
  state.featureKey = null;   // rebuild the list on the next render
  requestRender();
}

/** Which catalogue the labels use: the light chosen under Light, if it has lines. */
function labelKind() {
  return LABEL_KINDS[els.autoSource.value] || null;
}

/** Find and name the features of the current spectrum (when labels are on), and list them. */
function updateFeatures() {
  const s = state.settings, p = state.profile, kind = labelKind();
  let list = [], note = '';
  if (s.labelFeatures) {
    if (!calOk()) note = 'Calibrate first: the labels need wavelengths.';
    else if (!kind) note = 'A white LED or a bulb has no lines to name. Choose Fluorescent lamp or Sunlight under Light to label their lines.';
    else if (p) {
      list = core.labelFeatures(p.sum, (i) => pxToNm(p.x0 + i), kind, p.clip).map((f) => ({ ...f, px: p.x0 + f.i }));
      if (!list.length) note = `No ${kind === 'sun' ? 'dark lines of sunlight' : 'lamp lines'} stand out here.`;
    }
  }
  state.features = list;
  const key = `${s.labelFeatures}|${kind}|${note}|` + list.map((f) => `${f.tag}${f.nm.toFixed(1)}`).join(',');
  if (key === state.featureKey) return;
  state.featureKey = key;
  els.featureList.textContent = '';
  for (const f of list) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = f.tag;
    li.appendChild(b);
    li.appendChild(document.createTextNode(`found at ${f.nm.toFixed(1)} nm. ` + f.lines.map((l) => `The ${l.name} at ${l.nm.toFixed(1)} nm, from ${l.what}`).join('. ') + '.'));
    els.featureList.appendChild(li);
  }
  els.featureHead.hidden = !list.length;
  els.featureList.hidden = !list.length;
  els.featureNote.hidden = !note;
  els.featureNote.textContent = note;
}

/** The labelled feature at the cursor, if any (within two nm or three pixels). */
function featureAt(px) {
  if (px === null || !state.features.length) return null;
  const per = calOk() ? Math.abs(pxToNm(px + 0.5) - pxToNm(px - 0.5)) : 1;
  const tol = Math.max(3, 2 / Math.max(per, 1e-6));
  let best = null;
  for (const f of state.features) if (Math.abs(f.px - px) <= tol && (!best || Math.abs(f.px - px) < Math.abs(best.px - px))) best = f;
  return best;
}

function shiftToMatch() {
  if (!calOk()) return;
  if (state.cursorPx === null) { toast('Tap the plot on the line first.'); return; }
  const nm = readNm();
  if (nm === null) return;
  const at = core.calOffset(state.cal, nm);
  if (at === null) { toast('That wavelength is outside this calibration.'); return; }
  const d = (state.cursorPx - state.W / 2) - at;
  state.points = state.points.map((p) => ({ ...p, off: p.off + d }));
  refit();
  toast(`Calibration moved by ${d.toFixed(1)} pixels.`);
}

function lineText(nm) { return String(Math.round(nm * 100) / 100); }

/** Fill the Known line and Show lines lists: the user's own kept wavelengths first, then the built-in groups. */
function buildLineLists() {
  const chosen = els.preset.value;
  const add = (parent, value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    parent.appendChild(o);
  };
  els.preset.textContent = '';
  els.refLines.textContent = '';
  add(els.preset, '', 'Choose…');
  add(els.refLines, 'none', 'None');
  if (state.myLines.length) {
    const og = document.createElement('optgroup');
    og.label = 'My lines';
    for (const l of state.myLines) add(og, `my:${lineText(l.nm)}`, `${lineText(l.nm)} nm`);
    els.preset.appendChild(og);
    add(els.refLines, 'my', 'My lines');
  }
  for (const g of core.LINE_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.name;
    for (const line of g.lines) add(og, `${g.id}:${line.nm}`, `${line.nm} nm, ${line.name}`);
    els.preset.appendChild(og);
    add(els.refLines, g.id, g.name);
  }
  els.preset.value = chosen;
  if (els.preset.selectedIndex < 0) els.preset.value = '';
  if (state.settings.refLines === 'my' && !state.myLines.length) state.settings.refLines = 'none';
  els.refLines.value = state.settings.refLines;
  els.btnKeepLine.textContent = els.preset.value.startsWith('my:') ? 'Forget' : 'Keep';
}

/** Keep the typed wavelength in the user's own list, or drop the kept one that is selected. */
function keepOrForgetLine() {
  let select = '';
  if (els.preset.value.startsWith('my:')) {
    const nm = Number(els.preset.value.slice(3));
    state.myLines = state.myLines.filter((l) => Math.abs(l.nm - nm) > 0.005);
    toast(`${lineText(nm)} nm removed from My lines.`);
  } else {
    const nm = readNm();
    if (nm === null) return;
    const v = Math.round(nm * 100) / 100;
    if (!state.myLines.some((l) => Math.abs(l.nm - v) < 0.005)) state.myLines.push({ nm: v });
    state.myLines.sort((a, b) => a.nm - b.nm);
    select = `my:${lineText(v)}`;
    toast(`${lineText(v)} nm kept under My lines.`);
  }
  saveStore();
  els.preset.value = select;   // not in the list yet when just kept; buildLineLists() falls back to "Choose"
  buildLineLists();
  els.preset.value = select;
  els.btnKeepLine.textContent = select ? 'Forget' : 'Keep';
  requestRender();
}

// ---------------------------------------------------------------- drawing

function sizeCanvas(cv, wrap, maxDpr) {
  // the layout size, not the on-screen box: the two differ when the app is turned on a sideways phone
  const r = { width: wrap.clientWidth, height: wrap.clientHeight };
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { cssW: r.width, cssH: r.height, dpr };
}

/** Is the big view zoomed onto the spectrum? */
function zoomed() {
  return state.big && !!state.settings.bigZoom && !!state.profile;
}

/** The part of the analysed frame the picture shows: all of it, or (zoomed) the band's length with
 *  a margin, centred on the band and as tall as the view's shape allows. While the band is being
 *  dragged the zoomed part stays put, so the picture does not slide under the finger. */
function viewRect(cw, ch) {
  const W = state.W, H = state.H;
  if (!zoomed()) return { sx: 0, sy: 0, sw: W, sh: H };
  if (state.zoomHold) return state.zoomHold;
  const p = state.profile, aspect = ch / cw;
  let sw = Math.max(p.n * 1.1 + 12, W / 10);              // at most 10 times larger
  let sh = Math.max(sw * aspect, p.hRows * 1.5 + 12);     // the band and some of the picture around it
  sw = Math.max(sw, sh / aspect);
  if (sw > W) { sw = W; sh = Math.min(H, Math.max(sh, sw * aspect)); }
  if (sh > H) { sh = H; sw = Math.min(W, Math.max(sw, sh / aspect)); }
  const sx = core.clamp(p.x0 + p.n / 2 - sw / 2, 0, W - sw), sy = core.clamp(p.y0 + p.hRows / 2 - sh / 2, 0, H - sh);
  return { sx, sy, sw, sh };
}

function drawView() {
  const { dpr } = sizeCanvas(els.view, els.viewWrap, 2);
  const cv = els.view, ctx = viewCtx, cw = cv.width, ch = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  state.viewFit = null;
  if (!state.W || !state.fc) return;
  const r = viewRect(cw, ch);
  const k = Math.min(cw / r.sw, ch / r.sh);
  const dw = r.sw * k, dh = r.sh * k, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  state.viewFit = { k: k / dpr, dx: dx / dpr, dy: dy / dpr, rect: r };
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.fc.c, r.sx, r.sy, r.sw, r.sh, dx, dy, dw, dh);
  const p = state.profile;
  if (!p) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
  const X = (fx) => dx + (fx - r.sx) * k, Y = (fy) => dy + (fy - r.sy) * k;
  const x = X(p.x0), w = p.n * k, y = Y(p.y0), h = Math.max(1, p.hRows * k);
  // outline drawn just outside the band, dark under light so it shows on any picture
  for (const [color, lw] of [['rgba(0,0,0,0.7)', 3 * dpr], ['#ffffff', dpr]]) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.strokeRect(x - dpr, y - 1.5 * dpr, w + 2 * dpr, h + 3 * dpr);
  }
  if (p.strips && p.strips.length) {
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = dpr;
    for (const [sy, sh] of p.strips) ctx.strokeRect(x, Y(sy), w, sh * k);
    ctx.setLineDash([]);
  }
  if (state.cursorPx !== null) {
    const cx = X(state.cursorPx + 0.5);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(cx, y - 12 * dpr); ctx.lineTo(cx, y - 3 * dpr);
    ctx.moveTo(cx, y + h + 3 * dpr); ctx.lineTo(cx, y + h + 12 * dpr);
    ctx.stroke();
  }
  ctx.restore();
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
  updateFeatures();
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
  let refLines = [];
  if (cal && s.refLines === 'my') refLines = state.myLines.map((l) => ({ nm: l.nm, label: String(Math.round(l.nm)) }));
  else if (cal) { const group = core.LINE_GROUPS.find((g) => g.id === s.refLines); if (group) refLines = group.lines; }
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
    refLines,
    peaks,
    features: state.features.map((f) => ({ px: f.px, tag: f.tag })),
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
  ro.feat = document.createElement('span');   // the labelled feature under the cursor, before the values
  ro.vals.appendChild(ro.feat);
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
  const f = featureAt(state.cursorPx);
  ro.feat.textContent = f ? `  ${f.tag}, ${f.lines.map((l) => l.what).filter((v, j, a) => a.indexOf(v) === j).join('; ')} ` : '';
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
    else if (state.frozen) t = `Captured ${size}`;
    else t = `Live ${size}`;
  }
  if (els.srcStatus.textContent !== t) els.srcStatus.textContent = t;
  // brightest part of the band, as a share of full scale: the thing to watch while setting exposure.
  // While live this small label is the only brightness warning, so nothing else on screen moves.
  const clipped = !!p && core.clippedRanges(p.clip).length > 0;
  let badge = p ? `Peak ${Math.round(p.peakRaw / 2.55)}%${clipped ? ', too bright' : p.peakRaw < 40 ? ', dim' : ''}` : '';
  if (isLive() && state.settings.follow) {
    if (state.findState === 'none') badge = 'Looking for the spectrum' + (badge ? ` · ${badge}` : '');
    else if (state.findState === 'vertical') badge = 'Spectrum is upright: tap ⟳ 90°';
  }
  if (els.viewBadge.textContent !== badge) els.viewBadge.textContent = badge;
  els.viewBadge.hidden = !badge;
  els.viewBadge.classList.toggle('warn', clipped);

  const notes = [];
  // the written warnings appear only for a few seconds after a capture or a photo, over the picture
  if (p && !isLive() && performance.now() < state.noticesUntil) {
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
    row.addEventListener('click', () => { state.noticesUntil = 0; requestRender(); });
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
  els.btnFreeze.textContent = state.frozen ? 'Back to live' : 'Capture';
  els.bigCapture.textContent = state.frozen ? 'Back to live' : 'Capture';
  els.btnBig.disabled = !on;
  els.btnFlip.setAttribute('aria-pressed', String(!!state.settings.flip));
  els.ovRotate.hidden = !state.W;
  els.ovBig.hidden = !on || state.big;
  els.bigZoom.setAttribute('aria-pressed', String(!!state.settings.bigZoom));
  els.bigZoom.textContent = state.settings.bigZoom ? 'Zoom out' : 'Zoom in';
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
  els.autoSource.value = AUTO_SOURCES.includes(s.autoSource) ? s.autoSource : 'lamp';
  els.colourWb.value = core.WHITE_BALANCES.some((w) => w.id === s.colourWb) ? s.colourWb : 'd65';
  els.btnLabels.setAttribute('aria-pressed', String(!!s.labelFeatures));
  state.featureKey = null;
  updateColourBox();
  for (const id of ['follow', 'bigOnStart', 'keepFixed']) els[id].checked = !!s[id];
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
  if (key === 'x0' || key === 'x1') { state.view = null; renderCalibration(); }
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
  // Rotating works on a captured frame too: the capture keeps the untouched camera picture
  const rotate90 = () => setSetting('rot', (state.settings.rot + 90) % 360);
  els.btnRotate.addEventListener('click', rotate90);
  els.ovRotate.addEventListener('click', rotate90);
  els.bigRotate.addEventListener('click', rotate90);
  els.btnFlip.addEventListener('click', () => setSetting('flip', !state.settings.flip));
  els.bigCapture.addEventListener('click', toggleFreeze);
  els.bigFind.addEventListener('click', findSpectrum);
  els.bigZoom.addEventListener('click', () => {
    const on = !state.settings.bigZoom;
    setSetting('bigZoom', on);
    updateButtons();
    const p = state.profile;
    if (on && !p) toast('Find spectrum first: the zoom shows the band and the picture just around it.');
    else if (on && p.n > 0.8 * state.W) toast('The band runs across nearly the whole picture, so there is little to zoom into. Find spectrum fits the band to the spectrum.');
  });
  els.btnFind.addEventListener('click', findSpectrum);
  els.bigExit.addEventListener('click', () => setBig(false));
  els.ovBig.addEventListener('click', () => setBig(true));
  els.btnBig.addEventListener('click', () => setBig(true));
  els.follow.addEventListener('change', () => { setSetting('follow', els.follow.checked); state.findState = ''; });
  els.bigOnStart.addEventListener('change', () => setSetting('bigOnStart', els.bigOnStart.checked));
  els.keepFixed.addEventListener('change', () => {
    setSetting('keepFixed', els.keepFixed.checked);
    state.rotatesWithScreen = null;
    applyScreenTurn();
  });

  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    const key = c.dataset.series;
    setSetting(key, !state.settings[key]);
    c.setAttribute('aria-pressed', String(state.settings[key]));
  }));

  // Positions inside a canvas come from offsetX / offsetY, which are in the canvas's own
  // coordinates even when the app is turned back on a sideways phone (see applyScreenTurn).
  const local = (e, el) => {
    if (typeof e.offsetX === 'number' && typeof e.offsetY === 'number') return { x: e.offsetX, y: e.offsetY };
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // drag on the picture to move the band
  let dragging = false;
  const moveBand = (e) => {
    const f = state.viewFit;
    if (!f) return;
    const row = (local(e, els.view).y - f.dy) / f.k + f.rect.sy;
    const v = core.clamp(Math.round(row / state.H * 1000) / 10, 0, 100);
    els.bandPos.value = v;
    setSetting('bandPos', v);
  };
  const endDrag = () => {
    dragging = false;
    if (state.zoomHold) { state.zoomHold = null; requestRender(); }
  };
  els.view.addEventListener('pointerdown', (e) => {
    if (!state.viewFit) return;
    dragging = true;
    if (zoomed()) state.zoomHold = state.viewFit.rect;
    try { els.view.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    if (state.settings.follow && isLive()) {
      setSetting('follow', false);
      els.follow.checked = false;
      toast('Band placed by hand. Find spectrum puts it back on automatic.');
    }
    moveBand(e);
    e.preventDefault();
  });
  els.view.addEventListener('pointermove', (e) => { if (dragging) moveBand(e); });
  els.view.addEventListener('pointerup', endDrag);
  els.view.addEventListener('pointercancel', endDrag);

  // touch the plot to place the cursor; it snaps when the finger lifts
  let plotting = false;
  const moveCursor = (e, done) => {
    const g = state.geom, p = state.profile;
    if (!g || !p) return;
    const frac = core.clamp((local(e, els.plot).x - g.left) / Math.max(1, g.right - g.left), 0, 1);
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
  buildLineLists();
  els.preset.addEventListener('change', () => {
    const [group, nm] = els.preset.value.split(':');
    els.btnKeepLine.textContent = group === 'my' ? 'Forget' : 'Keep';
    if (!nm) return;
    els.nm.value = nm;
    if (group === 'my') return;                      // your own lines: leave the snap choice as it is
    const mode = group === 'sun' ? 'dip' : 'peak';   // sunlight lines are dark, lamp and laser lines bright
    els.snap.value = mode;
    setSetting('snap', mode);
  });
  els.nm.addEventListener('input', () => { els.preset.value = ''; els.btnKeepLine.textContent = 'Keep'; });
  els.btnKeepLine.addEventListener('click', keepOrForgetLine);
  els.btnAddPoint.addEventListener('click', addPoint);
  els.btnAuto.addEventListener('click', runAuto);
  els.btnLabels.addEventListener('click', () => setLabels(!state.settings.labelFeatures));
  els.autoSource.addEventListener('change', () => { setSetting('autoSource', els.autoSource.value); updateColourBox(); state.featureKey = null; });
  els.colourWb.textContent = '';
  for (const w of core.WHITE_BALANCES) { const o = document.createElement('option'); o.value = w.id; o.textContent = w.name; els.colourWb.appendChild(o); }
  els.colourWb.addEventListener('change', () => setSetting('colourWb', els.colourWb.value));
  els.btnKeepColours.addEventListener('click', () => keepColours(false));
  els.btnForgetColours.addEventListener('click', () => {
    if (!window.confirm('Forget the colours kept for this camera? Calibrating from colours then uses the standard camera model.')) return;
    delete state.colourRefs[colourKey()];
    saveStore(); updateColourBox();
  });
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
    if (!window.confirm('Delete every saved calibration and kept colours on this device?')) return;
    state.cals = {}; state.points = []; state.colourRefs = {};
    refit(); updateColourBox();
  });

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  if (window.ResizeObserver) {
    const obs = new ResizeObserver(() => requestRender());
    obs.observe(els.viewWrap); obs.observe(els.plotWrap);
    new ResizeObserver(() => renderCalPlot()).observe(els.calPlotWrap);
  }
  window.addEventListener('resize', () => { applyScreenTurn(); requestRender(); });
  window.addEventListener('orientationchange', () => { applyScreenTurn(); setTimeout(applyScreenTurn, 300); });
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', applyScreenTurn);
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { colorCache = null; requestRender(); renderCalPlot(); });
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
  if (name === 'calibrate') renderCalPlot();
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
      points: state.points.map((q) => ({ px_offset: q.off, nm: q.nm, source: q.src || 'hand' })),
      rms_nm: cal.ok ? cal.rms : null,
      automatic: state.autoInfo,
    },
    labelled_features: state.features.map((f) => ({
      label: f.tag, nm: Math.round(f.nm * 10) / 10, pixel: Math.round(f.px * 10) / 10,
      lines: f.lines.map((l) => ({ nm: l.nm, name: l.name, cause: l.what })),
    })),
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
    turning: { screen_turn: deviceTurn(), window_orientation: typeof window.orientation === 'number' ? window.orientation : null,
      screen_orientation: screen.orientation ? `${screen.orientation.type} ${screen.orientation.angle}` : null,
      app_turned: document.documentElement.getAttribute('data-turn'), frames_turn_with_screen: state.rotatesWithScreen,
      live_compensation: state.comp, capture_compensation: state.holdComp },
    band_finder: state.findState,
    settings: state.settings,
    calibrations_saved: Object.keys(state.cals),
    colours_kept: Object.fromEntries(Object.entries(state.colourRefs).map(([k, v]) => [k, `${v.savedAt || '?'} from ${v.from || '?'}`])),
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
window.spectroscope = { state, core, reprocess, loadPhoto, render, applyScreenTurn, findSpectrum, setBig, forceTurn: undefined };
applyScreenTurn();
