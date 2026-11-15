// Draws the spectrum plot on a canvas. Everything is drawn in CSS pixels; the canvas
// backing store is scaled by the device pixel ratio before drawing.

import { clamp, niceStep, clippedRanges } from './core.js';

const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const MARGIN = { left: 40, right: 10, top: 16, bottom: 46 };
const STRIP_H = 10;

let stripCanvas = null;

function tickDecimals(step) {
  if (step >= 1) return Number.isInteger(step) ? 0 : 1;
  const mantissa = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9) + (Math.abs(mantissa - 2.5) < 0.01 ? 1 : 0));
}

/** model:
 *   cssW, cssH, dpr           canvas size in CSS px and the pixel ratio
 *   x0, n                     first frame column of the profile and its length
 *   series                    [{ y, show, color, width, tag }]  tag = short direct label or ''
 *   raw, clip                 mean colour per column (3 bytes each) and clipped fraction
 *   view                      [firstPx, lastPx] frame columns shown
 *   pxToNm, nmToPx            functions, or null when not calibrated
 *   cursorPx                  frame column of the cursor, or null
 *   calPoints                 [{ px }]
 *   refLines                  [{ nm, label }]
 *   peaks                     [{ px, text }]
 *   features                  [{ px, tag }]  labelled lines (what causes them), or []
 *   yLabel, colors
 * Returns the plot rectangle and x-range, for turning touches into columns. */
export function drawPlot(canvas, m) {
  const ctx = canvas.getContext('2d');
  const { cssW, cssH, dpr, colors } = m;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const left = MARGIN.left, right = cssW - MARGIN.right, top = MARGIN.top, bottom = cssH - MARGIN.bottom;
  const plotW = Math.max(10, right - left), plotH = Math.max(10, bottom - top);
  const geom = { left, right, top, bottom, xa: 0, xb: 1 };
  ctx.font = FONT;
  ctx.textBaseline = 'alphabetic';

  if (!m.n) {
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.fillText('The spectrum appears here', left + plotW / 2, top + plotH / 2);
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, bottom + 0.5); ctx.lineTo(right, bottom + 0.5); ctx.stroke();
    return geom;
  }

  const xa = m.view[0], xb = Math.max(m.view[1], xa + 1);
  geom.xa = xa; geom.xb = xb;
  const X = (px) => left + (px - xa) / (xb - xa) * plotW;
  const ia = clamp(Math.floor(xa - m.x0), 0, m.n - 1), ib = clamp(Math.ceil(xb - m.x0), 0, m.n - 1);

  // y range from what is visible
  let ymax = 0;
  for (const s of m.series) {
    if (!s.show) continue;
    for (let i = ia; i <= ib; i++) if (s.y[i] > ymax) ymax = s.y[i];
  }
  if (!(ymax > 0)) ymax = 1;
  const features = m.features || [];
  const yTop = ymax * (features.length ? 1.34 : m.peaks.length ? 1.22 : 1.1);
  const Y = (v) => bottom - (v / yTop) * plotH;

  // clipped columns
  const ranges = clippedRanges(m.clip);
  let clipLabelX = null;
  ctx.fillStyle = colors.warnWash;
  for (const [a, b] of ranges) {
    const x1 = clamp(X(m.x0 + a - 0.5), left, right), x2 = clamp(X(m.x0 + b + 0.5), left, right);
    if (x2 <= x1) continue;
    ctx.fillRect(x1, top, Math.max(1, x2 - x1), plotH);
    if (clipLabelX === null) clipLabelX = x1;
  }

  // horizontal gridlines and y ticks
  const yStep = niceStep(yTop, Math.max(2, Math.round(plotH / 34)));
  const yDec = tickDecimals(yStep);
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let v = 0; v <= yTop + 1e-12; v += yStep) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? colors.axis : colors.grid;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.fillText(v.toFixed(yDec), left - 5, y + 3.5);
  }

  // reference lines (their letters give way to the feature labels, which take the same place)
  if (m.nmToPx && m.refLines.length) {
    ctx.textAlign = 'center';
    let row = 0;
    for (const line of m.refLines) {
      const px = m.nmToPx(line.nm);
      if (px === null || px < xa || px > xb) continue;
      const x = Math.round(X(px)) + 0.5;
      ctx.strokeStyle = colors.ref;
      ctx.beginPath(); ctx.moveTo(x, top + (features.length ? 0 : 22)); ctx.lineTo(x, bottom); ctx.stroke();
      if (!features.length) {
        ctx.fillStyle = colors.ink2;
        ctx.fillText(line.label, x, top + 9 + (row % 2) * 11);
      }
      row++;
    }
  }

  // curves
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top - 2, plotW, plotH + 3); ctx.clip();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const s of m.series) {
    if (!s.show) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    for (let i = ia; i <= ib; i++) {
      const x = X(m.x0 + i), y = Y(s.y[i]);
      if (i === ia) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // a letter beside each channel's highest point, so identity never rests on colour alone
  // (set beside the peak, so it stays clear of a peak label above it)
  for (const s of m.series) {
    if (!s.show || !s.tag) continue;
    let best = ia;
    for (let i = ia; i <= ib; i++) if (s.y[i] > s.y[best]) best = i;
    if (!(s.y[best] > 0.04 * ymax)) continue;
    const at = X(m.x0 + best), onLeft = at > right - 18;
    const x = at + (onLeft ? -5 : 5), y = clamp(Y(s.y[best]) + 9, top + 9, bottom - 3);
    ctx.textAlign = onLeft ? 'right' : 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = colors.bg;
    ctx.strokeText(s.tag, x, y);
    ctx.fillStyle = colors.ink2;
    ctx.fillText(s.tag, x, y);
  }

  // features and what causes them: short labels in up to three rows along the top, each with a
  // thin leader down to its line on the combined curve. Placed first, so peak labels keep clear.
  const sum = m.series.find((s) => !s.tag) || m.series[0];
  const rowsEnd = [-Infinity, -Infinity, -Infinity];
  const placed = [];   // label boxes [x0, x1, y0, y1]
  const overlaps = (q) => placed.some((b) => q[0] < b[1] && q[1] > b[0] && q[2] < b[3] && q[3] > b[2]);
  const tags = [];
  ctx.textAlign = 'center';
  for (const f of features) {
    if (f.px < xa || f.px > xb) continue;
    const x = X(f.px), tw = ctx.measureText(f.tag).width;
    let row = rowsEnd.findIndex((end) => x - tw / 2 > end + 4);
    if (row < 0) row = rowsEnd.indexOf(Math.min(...rowsEnd));
    rowsEnd[row] = x + tw / 2;
    const ty = top + 9 + row * 12;
    tags.push({ f, x, ty });
    placed.push([x - tw / 2 - 2, x + tw / 2 + 2, ty - 10, ty + 3]);
  }

  // peak labels, most prominent first; one that would overlap another label is left out
  for (const p of m.peaks) {
    if (p.px < xa || p.px > xb) continue;
    const x = clamp(X(p.px), left + 14, right - 14), y = Math.max(top + 9, Y(p.height) - 6);
    const tw = ctx.measureText(p.text).width, box = [x - tw / 2 - 2, x + tw / 2 + 2, y - 10, y + 3];
    if (overlaps(box)) continue;
    placed.push(box);
    ctx.lineWidth = 3; ctx.strokeStyle = colors.bg;
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = colors.ink;
    ctx.fillText(p.text, x, y);
  }

  for (const { f, x, ty } of tags) {
    const v = sum.y[clamp(Math.round(f.px - m.x0), 0, m.n - 1)];
    const yc = Y(v);
    if (yc > ty + 6) {
      ctx.strokeStyle = colors.ref; ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, ty + 3); ctx.lineTo(Math.round(x) + 0.5, yc - 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 3; ctx.strokeStyle = colors.bg;
    ctx.strokeText(f.tag, x, ty);
    ctx.fillStyle = colors.ink;
    ctx.fillText(f.tag, x, ty);
  }

  // marked calibration lines
  ctx.fillStyle = colors.accent;
  ctx.strokeStyle = colors.accent;
  for (const p of m.calPoints) {
    if (p.px < xa || p.px > xb) continue;
    const x = X(p.px);
    ctx.beginPath(); ctx.moveTo(x - 5, top - 8); ctx.lineTo(x + 5, top - 8); ctx.lineTo(x, top); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, bottom); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (clipLabelX !== null) {
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.ink2;
    ctx.fillText('clipped', Math.min(clipLabelX + 3, right - 44), bottom - 5);
  }

  // strip of the band's own colours, aligned with the x axis
  if (m.raw && ib > ia) {
    if (!stripCanvas) stripCanvas = document.createElement('canvas');
    const w = ib - ia + 1;
    if (stripCanvas.width !== w || stripCanvas.height !== 1) { stripCanvas.width = w; stripCanvas.height = 1; }
    const sctx = stripCanvas.getContext('2d');
    const img = sctx.createImageData(w, 1);
    for (let i = 0; i < w; i++) {
      img.data[4 * i] = m.raw[3 * (ia + i)];
      img.data[4 * i + 1] = m.raw[3 * (ia + i) + 1];
      img.data[4 * i + 2] = m.raw[3 * (ia + i) + 2];
      img.data[4 * i + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const x1 = X(m.x0 + ia - 0.5), x2 = X(m.x0 + ib + 0.5);
    ctx.save();
    ctx.beginPath(); ctx.rect(left, bottom + 3, plotW, STRIP_H); ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(left, bottom + 3, plotW, STRIP_H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(stripCanvas, x1, bottom + 3, x2 - x1, STRIP_H);
    ctx.restore();
  }

  // x ticks
  ctx.textAlign = 'center';
  ctx.fillStyle = colors.muted;
  ctx.strokeStyle = colors.axis;
  const want = Math.max(2, Math.round(plotW / 58));
  const tickY = bottom + 3 + STRIP_H;
  const drawTick = (px, text) => {
    if (px === null || px < xa - 1e-6 || px > xb + 1e-6) return;
    const x = Math.round(X(px)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, tickY); ctx.lineTo(x, tickY + 4); ctx.stroke();
    ctx.fillText(text, clamp(x, left + 8, right - 8), tickY + 15);
  };
  if (m.pxToNm) {
    const nA = m.pxToNm(xa), nB = m.pxToNm(xb);
    const lo = Math.min(nA, nB), hi = Math.max(nA, nB);
    const step = niceStep(hi - lo, want);
    const dec = tickDecimals(step);
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) drawTick(m.nmToPx(t), t.toFixed(dec));
  } else {
    const step = Math.max(1, niceStep(xb - xa, want));
    for (let t = Math.ceil(xa / step) * step; t <= xb + 1e-9; t += step) drawTick(t, String(Math.round(t)));
  }
  ctx.fillStyle = colors.ink2;
  ctx.fillText(m.pxToNm ? 'Wavelength (nm)' : 'Position (pixel column) - not calibrated', left + plotW / 2, cssH - 5);
  ctx.save();
  ctx.translate(10, top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(m.yLabel, 0, 0);
  ctx.restore();

  // cursor
  if (m.cursorPx !== null && m.cursorPx >= xa && m.cursorPx <= xb) {
    const x = Math.round(X(m.cursorPx)) + 0.5;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, bottom + 3 + STRIP_H); ctx.stroke();
    ctx.fillStyle = colors.ink;
    ctx.beginPath(); ctx.arc(x, top - 6, 3.5, 0, 2 * Math.PI); ctx.fill();
  }
  return geom;
}

/** The calibration itself, in three panels over the band's pixel columns: wavelength, how far it
 *  departs from a straight line, and nanometres per pixel. Outside the marked lines the fit is
 *  extrapolated, so the curves are dashed there.
 *  model: cssW, cssH, dpr, colors, pxA, pxB (columns across the band), nmAt(px),
 *         span [first, last marked column], points [{ px, nm }].
 *  Returns { line: [slope, intercept], maxDev, nmPerPx: [at pxA, at pxB] }. */
export function drawCalPlot(canvas, m) {
  const ctx = canvas.getContext('2d');
  const { cssW, cssH, dpr, colors } = m;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.font = FONT;
  const left = 46, right = cssW - 12, bottomAxis = 30;
  const plotW = Math.max(10, right - left);
  const pxA = m.pxA, pxB = Math.max(m.pxB, m.pxA + 1);
  const X = (px) => left + (px - pxA) / (pxB - pxA) * plotW;
  const N = 160, xs = [], nm = [], per = [];
  for (let k = 0; k <= N; k++) {
    const px = pxA + (pxB - pxA) * k / N;
    xs.push(px); nm.push(m.nmAt(px)); per.push(Math.abs(m.nmAt(px + 0.5) - m.nmAt(px - 0.5)));
  }
  // the straight line closest to the curve between the marked lines
  const [sa, sb] = [Math.max(pxA, m.span[0]), Math.min(pxB, m.span[1])];
  let n0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k <= 200; k++) {
    const px = sa + (sb - sa) * k / 200, v = m.nmAt(px);
    n0++; sx += px; sy += v; sxx += px * px; sxy += px * v;
  }
  const den = n0 * sxx - sx * sx;
  const slope = den > 0 ? (n0 * sxy - sx * sy) / den : 0, icpt = (sy - slope * sx) / n0;
  const line = (px) => slope * px + icpt;
  const dev = nm.map((v, k) => v - line(xs[k]));
  const ptDev = m.points.map((p) => ({ px: p.px, v: p.nm - line(p.px) }));
  let maxDev = 0;
  for (let k = 0; k <= N; k++) if (xs[k] >= sa && xs[k] <= sb) maxDev = Math.max(maxDev, Math.abs(dev[k]));

  const panels = [
    { title: 'Wavelength (nm)', y: nm, pts: m.points.map((p) => ({ px: p.px, v: p.nm })), ref: line },
    { title: 'Departure from a straight line (nm)', y: dev, pts: ptDev, zero: true },
    { title: 'Nanometres per pixel', y: per, pts: [] },
  ];
  const gap = 16, ph = Math.max(30, (cssH - bottomAxis - 4 - panels.length * gap) / panels.length);
  let y0 = 4;
  const inSpan = (px) => px >= m.span[0] - 0.5 && px <= m.span[1] + 0.5;
  for (const p of panels) {
    const top = y0 + gap, bottom = top + ph;
    let lo = Infinity, hi = -Infinity;
    for (const v of p.y) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const q of p.pts) { lo = Math.min(lo, q.v); hi = Math.max(hi, q.v); }
    if (p.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!(hi - lo > 1e-9)) { const c = Number.isFinite(lo) ? lo : 0; lo = c - (p.zero ? 0.5 : Math.max(0.01, Math.abs(c) * 0.02)); hi = c + (p.zero ? 0.5 : Math.max(0.01, Math.abs(c) * 0.02)); }
    const pad = 0.08 * (hi - lo);
    lo -= pad; hi += pad;
    const Y = (v) => bottom - (v - lo) / (hi - lo) * ph;
    // title, grid and y ticks
    ctx.textAlign = 'left'; ctx.fillStyle = colors.ink2;
    ctx.fillText(p.title, left, top - 5);
    const step = niceStep(hi - lo, Math.max(2, Math.round(ph / 26)));
    const dec = tickDecimals(step);
    ctx.textAlign = 'right'; ctx.lineWidth = 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = p.zero && Math.abs(v) < step / 2 ? colors.axis : colors.grid;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillStyle = colors.muted;
      ctx.fillText((Math.abs(v) < step / 1e6 ? 0 : v).toFixed(dec), left - 5, y + 3.5);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top - 1, plotW, ph + 2); ctx.clip();
    if (p.ref) {   // the straight line, for comparison
      ctx.strokeStyle = colors.muted; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(pxA), Y(p.ref(pxA))); ctx.lineTo(X(pxB), Y(p.ref(pxB))); ctx.stroke();
      ctx.setLineDash([]);
    }
    // the curve: solid between the marked lines, dashed where it is extrapolated
    ctx.strokeStyle = colors.ink; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const solid of [true, false]) {
      ctx.setLineDash(solid ? [] : [3, 4]);
      ctx.beginPath();
      let on = false;
      for (let k = 0; k <= N; k++) {
        const want = inSpan(xs[k]) === solid;
        const x = X(xs[k]), y = Y(p.y[k]);
        if (want) { if (on) ctx.lineTo(x, y); else ctx.moveTo(x, y); on = true; }
        else if (on) { ctx.lineTo(x, y); on = false; }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    // marked lines: dots with a ring of the background, so they stand off the curve
    for (const q of p.pts) {
      const x = X(q.px), y = Y(q.v);
      ctx.fillStyle = colors.bg;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = colors.accent;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
    }
    y0 = bottom;
  }
  // x axis: pixel columns of the frame
  const axisY = y0 + 3;
  ctx.strokeStyle = colors.axis; ctx.fillStyle = colors.muted; ctx.textAlign = 'center';
  const xstep = Math.max(1, niceStep(pxB - pxA, Math.max(2, Math.round(plotW / 60))));
  for (let t = Math.ceil(pxA / xstep) * xstep; t <= pxB + 1e-9; t += xstep) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + 4); ctx.stroke();
    ctx.fillText(String(Math.round(t)), clamp(x, left + 10, right - 10), axisY + 15);
  }
  ctx.fillStyle = colors.ink2;
  ctx.fillText('Pixel column', left + plotW / 2, cssH - 3);
  return { line: [slope, icpt], maxDev, nmPerPx: [per[0], per[N]] };
}
