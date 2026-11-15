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
  const yTop = ymax * (m.peaks.length ? 1.22 : 1.1);
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

  // reference lines
  if (m.nmToPx && m.refLines.length) {
    ctx.textAlign = 'center';
    let row = 0;
    for (const line of m.refLines) {
      const px = m.nmToPx(line.nm);
      if (px === null || px < xa || px > xb) continue;
      const x = Math.round(X(px)) + 0.5;
      ctx.strokeStyle = colors.ref;
      ctx.beginPath(); ctx.moveTo(x, top + 22); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = colors.ink2;
      ctx.fillText(line.label, x, top + 9 + (row % 2) * 11);
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

  // peak labels
  ctx.textAlign = 'center';
  for (const p of m.peaks) {
    if (p.px < xa || p.px > xb) continue;
    const x = clamp(X(p.px), left + 14, right - 14), y = Math.max(top + 9, Y(p.height) - 6);
    ctx.lineWidth = 3; ctx.strokeStyle = colors.bg;
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = colors.ink;
    ctx.fillText(p.text, x, y);
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
