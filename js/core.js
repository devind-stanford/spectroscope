// Analysis functions for the spectroscope app. No DOM access here, so the same
// code runs in the app and in the tests.
//
// Conventions
//   - A "profile" is one value per image column inside the sampling band.
//   - Calibration positions are pixel OFFSETS from the centre of the frame
//     (offset = column - frameWidth / 2), so trimming the left or right edge
//     of the band never changes the calibration.
//   - Polynomial coefficients are stored highest power first:
//     wavelength_nm = c[0] * offset^2 + c[1] * offset + c[2]   (or c[0] * offset + c[1]).

export const VERSION = '0.3.0';

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 256-entry table: 8-bit pixel code -> value proportional to light (0..1).
 *  With `linearise` the sRGB transfer curve is undone; without it the code is just scaled. */
export function makeLut(linearise) {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = linearise ? (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) : v;
  }
  return lut;
}

/** Average every column of an RGBA block (w x h pixels).
 *  Returns r, g, b (after the lookup table), the fraction of pixels in each column that are
 *  at full scale in any channel, the mean displayed colour of each column, and the largest
 *  mean pixel code (0..255). */
export function columnMeans(data, w, h, lut, clipLevel = 254) {
  const r = new Float64Array(w), g = new Float64Array(w), b = new Float64Array(w);
  const sr = new Float64Array(w), sg = new Float64Array(w), sb = new Float64Array(w);
  const clip = new Float32Array(w);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      r[x] += lut[R]; g[x] += lut[G]; b[x] += lut[B];
      sr[x] += R; sg[x] += G; sb[x] += B;
      if (R >= clipLevel || G >= clipLevel || B >= clipLevel) clip[x] += 1;
    }
  }
  const raw = new Uint8ClampedArray(w * 3);
  const inv = 1 / h;
  let peakRaw = 0;
  for (let x = 0; x < w; x++) {
    r[x] *= inv; g[x] *= inv; b[x] *= inv; clip[x] *= inv;
    const a = sr[x] * inv, c = sg[x] * inv, d = sb[x] * inv;
    raw[3 * x] = a; raw[3 * x + 1] = c; raw[3 * x + 2] = d;
    if (a > peakRaw) peakRaw = a;
    if (c > peakRaw) peakRaw = c;
    if (d > peakRaw) peakRaw = d;
  }
  return { r, g, b, clip, raw, peakRaw };
}

/** Mean R+G+B pixel code of every row of an RGBA block. */
export function rowBrightness(data, w, h) {
  const rows = new Float64Array(h);
  for (let y = 0, i = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++, i += 4) s += data[i] + data[i + 1] + data[i + 2];
    rows[y] = s / w;
  }
  return rows;
}

function median(values) {
  const a = Array.from(values).sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** Top and bottom rows of the bright spectrum band that contains row `centre`.
 *  The edge is where brightness falls halfway between the outer rows (background) and the
 *  band's peak near `centre`. Returns null when no band stands out. */
export function bandEdges(rows, centre) {
  const h = rows.length;
  if (h < 8) return null;
  const c = clamp(Math.round(centre), 0, h - 1);
  const edge = Math.max(1, Math.floor(h / 10));
  const outer = [];
  for (let i = 0; i < edge; i++) { outer.push(rows[i]); outer.push(rows[h - 1 - i]); }
  const bg = median(outer);
  const half = Math.max(1, Math.floor(h / 20));
  let peak = -Infinity;
  for (let i = Math.max(0, c - half); i <= Math.min(h - 1, c + half); i++) peak = Math.max(peak, rows[i]);
  if (!(peak - bg > 0.05 * Math.max(peak, 1e-9))) return null;
  const threshold = bg + 0.5 * (peak - bg);
  let top = c;
  while (top > 0 && rows[top] >= threshold) top--;
  let bottom = c;
  while (bottom < h - 1 && rows[bottom] >= threshold) bottom++;
  return { top, bottom, background: bg, peak };
}

/** Find the spectrum in a small RGBA copy of the frame (w x h pixels): the colourful band, which
 *  the white zero order and grey stray light are not. Returns null when nothing colourful stands
 *  out, { vertical: true } when the band runs up and down, or the band's box as fractions of the
 *  frame: { vertical: false, x0, x1, y0, y1 } (x1, y1 exclusive). */
export function findSpectrumBox(data, w, h) {
  const n = w * h, score = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    score[i] = c;
    hist[c]++;
  }
  // how colourful the most colourful 0.5 % of the picture is
  let acc = 0, top = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= 0.005 * n) { top = v; break; } }
  if (top < 20) return null;
  const thr = Math.max(12, 0.25 * top);
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (score[i] >= thr) { rows[y] += score[i]; cols[x] += score[i]; }
    }
  }
  const spread = (a) => {   // pixels holding the central 80 % of the colour
    let tot = 0;
    for (let i = 0; i < a.length; i++) tot += a[i];
    if (!(tot > 0)) return 0;
    let s = 0, lo = 0, hi = a.length - 1;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (s >= 0.1 * tot) { lo = i; break; } }
    s = 0;
    for (let i = a.length - 1; i >= 0; i--) { s += a[i]; if (s >= 0.1 * tot) { hi = i; break; } }
    return hi - lo + 1;
  };
  if (spread(rows) > spread(cols)) return { vertical: true };

  // rows: around the most colourful row, out to where colour falls below 30 % of it
  const rs = gaussianSmooth(rows, 1);
  let yp = 0;
  for (let y = 1; y < h; y++) if (rs[y] > rs[yp]) yp = y;
  let y0 = yp, y1 = yp;
  while (y0 > 0 && rs[y0 - 1] >= 0.3 * rs[yp]) y0--;
  while (y1 < h - 1 && rs[y1 + 1] >= 0.3 * rs[yp]) y1++;
  // columns: colour inside those rows, including the dim violet and red ends, less the colour
  // noise that video adds everywhere (measured in the rows away from the band)
  let half = 0, med = 0;
  for (let v = 0; v < 256; v++) { half += hist[v]; if (half >= 0.5 * n) { med = v; break; } }
  const pix = Math.max(8, 2 * med + 4);
  const cb = new Float64Array(w), bg = new Float64Array(w);
  const m = y1 - y0 + 1;
  let nb = 0;
  for (let y = 0; y < h; y++) {
    const inBand = y >= y0 && y <= y1;
    const away = y < y0 - m || y > y1 + m;
    if (!inBand && !away) continue;
    if (away) nb++;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      if (score[i] < pix) continue;
      if (inBand) cb[x] += score[i]; else bg[x] += score[i];
    }
  }
  if (nb > 0) {
    const bgs = gaussianSmooth(bg, 3);
    for (let x = 0; x < w; x++) cb[x] = Math.max(0, cb[x] - bgs[x] * m / nb);
  }
  const cs = gaussianSmooth(cb, 1.5);
  let xp = 0;
  for (let x = 1; x < w; x++) if (cs[x] > cs[xp]) xp = x;
  if (!(cs[xp] > 0)) return null;
  const on = (x) => cs[x] >= 0.06 * cs[xp];
  const gap = Math.max(2, Math.round(0.12 * w));   // dark gaps between lamp lines are bridged
  let xa = xp, xb = xp;
  for (let x = xp - 1, miss = 0; x >= 0; x--) { if (on(x)) { xa = x; miss = 0; } else if (++miss > gap) break; }
  for (let x = xp + 1, miss = 0; x < w; x++) { if (on(x)) { xb = x; miss = 0; } else if (++miss > gap) break; }
  if (xb - xa < 4) return null;
  return { vertical: false, x0: xa / w, x1: (xb + 1) / w, y0: y0 / h, y1: (y1 + 1) / h };
}

/** Gaussian blur of a 1-D array (edges repeat the end value). sigma in samples. */
export function gaussianSmooth(y, sigma) {
  const n = y.length;
  const out = new Float64Array(n);
  if (!(sigma > 0.05)) { for (let i = 0; i < n; i++) out[i] = y[i]; return out; }
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * rad + 1);
  let s = 0;
  for (let j = -rad; j <= rad; j++) { const v = Math.exp(-0.5 * j * j / (sigma * sigma)); k[j + rad] = v; s += v; }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -rad; j <= rad; j++) acc += y[clamp(i + j, 0, n - 1)] * k[j + rad];
    out[i] = acc / s;
  }
  return out;
}

/** Sub-sample position of the maximum or minimum at sample i, from a parabola through
 *  the three samples around it. */
export function refineExtremum(y, i) {
  if (i < 1 || i > y.length - 2) return i;
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const den = a - 2 * b + c;
  if (den === 0) return i;
  return i + clamp(0.5 * (a - c) / den, -0.5, 0.5);
}

/** Move `pos` (a fractional sample index) onto the strongest peak or dip within
 *  +/- halfWindow samples. The straight line joining the window's two ends is removed first,
 *  so a line sitting on a sloping background is still found. Returns the position unchanged
 *  (snapped: false) when the window holds no peak or dip. */
export function snapFeature(y, pos, mode, halfWindow, sigma = 1) {
  if (mode !== 'peak' && mode !== 'dip') return { pos, snapped: false };
  const n = y.length;
  const lo = Math.max(1, Math.floor(pos - halfWindow));
  const hi = Math.min(n - 2, Math.ceil(pos + halfWindow));
  if (hi - lo < 2) return { pos, snapped: false };
  const ys = gaussianSmooth(y, sigma);
  const slope = (ys[hi] - ys[lo]) / (hi - lo);
  const sign = mode === 'peak' ? 1 : -1;
  const resid = new Float64Array(n);
  let best = -1, bestV = -Infinity, level = 0;
  for (let i = lo - 1; i <= hi + 1; i++) {
    resid[i] = sign * (ys[i] - (ys[lo] + slope * (i - lo)));
    level = Math.max(level, Math.abs(ys[i]));
    if (i >= lo && i <= hi && resid[i] > bestV) { bestV = resid[i]; best = i; }
  }
  // a bump smaller than a ten-thousandth of the signal is rounding, not a line
  if (best <= lo || best >= hi || !(bestV > 1e-4 * level)) return { pos, snapped: false };
  return { pos: refineExtremum(resid, best), snapped: true };
}

/** Local maxima of y that stand at least `minProminence` above their surroundings and are
 *  at least `minDistance` samples apart (the taller one wins). Sorted by position. */
export function findPeaks(y, { minProminence = 0, minDistance = 1 } = {}) {
  const n = y.length;
  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    if (y[i] > y[i - 1] && y[i] >= y[i + 1]) {
      let j = i;
      while (j < n - 1 && y[j + 1] === y[i]) j++;
      if (j < n - 1 && y[j + 1] < y[i]) candidates.push((i + j) >> 1);
      i = j;
    }
  }
  const found = [];
  for (const p of candidates) {
    const h = y[p];
    let lmin = h, rmin = h;
    for (let k = p - 1; k >= 0 && y[k] <= h; k--) if (y[k] < lmin) lmin = y[k];
    for (let k = p + 1; k < n && y[k] <= h; k++) if (y[k] < rmin) rmin = y[k];
    const prominence = h - Math.max(lmin, rmin);
    if (prominence >= minProminence) found.push({ i: p, height: h, prominence });
  }
  found.sort((a, b) => b.height - a.height);
  const kept = [];
  for (const p of found) if (kept.every((q) => Math.abs(q.i - p.i) >= minDistance)) kept.push(p);
  kept.sort((a, b) => a.i - b.i);
  return kept;
}

/** Least-squares polynomial. Returns coefficients in ascending powers, or null if the
 *  points do not determine one. Keep x within about -1..1 for accuracy. */
export function polyfit(xs, ys, degree) {
  const m = degree + 1;
  if (xs.length < m) return null;
  const A = [];
  for (let i = 0; i < m; i++) A.push(new Float64Array(m + 1));
  for (let k = 0; k < xs.length; k++) {
    const p = [1];
    for (let i = 1; i < m; i++) p.push(p[i - 1] * xs[k]);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += p[i] * p[j];
      A[i][m] += p[i] * ys[k];
    }
  }
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let j = col; j <= m; j++) A[r][j] -= f * A[col][j];
    }
  }
  const c = [];
  for (let i = 0; i < m; i++) c.push(A[i][m] / A[i][i]);
  return c;
}

/** Fit wavelength against pixel offset from the frame centre.
 *  points: [{ off, nm }]. Two points give a straight line, three or more a quadratic.
 *  Returns { ok, degree, coeffs (highest power first), residuals, rms, warnings, message }. */
export function fitCalibration(points, frameWidth) {
  const pts = points.filter((p) => Number.isFinite(p.off) && Number.isFinite(p.nm));
  const out = { ok: false, n: pts.length, degree: 0, coeffs: null, residuals: [], rms: 0, warnings: [], message: '' };
  if (pts.length < 2) {
    out.message = pts.length ? 'One line marked. Mark at least one more.' : 'No lines marked yet.';
    return out;
  }
  const half = Math.max(1, frameWidth / 2);
  const sorted = pts.slice().sort((a, b) => a.off - b.off);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].off - sorted[i - 1].off < 1) {
      out.message = 'Two marked lines sit on the same pixel. Delete one of them.';
      return out;
    }
  }
  const xs = pts.map((p) => p.off / half), ys = pts.map((p) => p.nm);
  let degree = Math.min(2, pts.length - 1);
  let c = polyfit(xs, ys, degree);
  if (c && degree === 2) {
    // the curve must keep rising (or keep falling) across the whole frame
    const dLeft = c[1] - 2 * c[2], dRight = c[1] + 2 * c[2];
    if (!(dLeft * dRight > 0)) {
      out.warnings.push('The curved fit turned back on itself inside the frame, so a straight line is used. Check the marked wavelengths.');
      degree = 1;
      c = polyfit(xs, ys, 1);
    } else if (Math.abs(c[2]) > 0.35 * Math.abs(c[1])) {
      out.warnings.push('The fit is strongly curved. One of the marked wavelengths may be wrong.');
    }
  }
  if (!c) { out.message = 'These points do not give a usable fit.'; return out; }
  if (c[1] < 0) out.warnings.push('Wavelength falls from left to right. Use Flip so that blue is on the left.');
  out.coeffs = degree === 2 ? [c[2] / (half * half), c[1] / half, c[0]] : [c[1] / half, c[0]];
  out.degree = degree;
  out.ok = true;
  let ss = 0;
  out.residuals = pts.map((p) => { const d = p.nm - calNm(out, p.off); ss += d * d; return d; });
  out.rms = Math.sqrt(ss / pts.length);
  return out;
}

/** Wavelength (nm) at a pixel offset from the frame centre. */
export function calNm(cal, off) {
  const c = cal.coeffs;
  let v = 0;
  for (let i = 0; i < c.length; i++) v = v * off + c[i];
  return v;
}

/** Pixel offset from the frame centre at a wavelength (the branch that passes through
 *  the frame), or null if the wavelength is never reached. */
export function calOffset(cal, nm) {
  const c = cal.coeffs;
  if (c.length === 2) return (nm - c[1]) / c[0];
  const [a, b, d] = c;
  const linear = (nm - d) / b;
  if (Math.abs(a) < 1e-15) return linear;
  const disc = b * b - 4 * a * (d - nm);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const x1 = (-b + s) / (2 * a), x2 = (-b - s) / (2 * a);
  return Math.abs(x1 - linear) <= Math.abs(x2 - linear) ? x1 : x2;
}

/** Approximate screen colour of a wavelength (Dan Bruton's piecewise approximation),
 *  as [r, g, b] in 0..1. Fades towards the ends of the visible range. */
export function wavelengthToRgb(nm) {
  const w = clamp(nm, 380, 750);
  let r = 0, g = 0, b = 0;
  if (w < 440) { r = -(w - 440) / 60; b = 1; }
  else if (w < 490) { g = (w - 440) / 50; b = 1; }
  else if (w < 510) { g = 1; b = -(w - 510) / 20; }
  else if (w < 580) { r = (w - 510) / 70; g = 1; }
  else if (w < 645) { r = 1; g = -(w - 645) / 65; }
  else { r = 1; }
  let f = 1;
  if (w < 420) f = 0.3 + 0.7 * (w - 380) / 40;
  else if (w > 700) f = 0.3 + 0.7 * (750 - w) / 50;
  if (nm < 380 || nm > 750) f = 0.3;
  return [r * f, g * f, b * f];
}

/** A round step (1, 2, 2.5, 5 x 10^k) that gives about `target` ticks across `span`. */
export function niceStep(span, target) {
  if (!(span > 0)) return 1;
  const rough = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / mag;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * mag;
}

/** Runs of columns where more than `threshold` of the band's pixels are at full scale.
 *  Returns [[first, last], ...] as indices into the profile; runs closer than `gap` merge. */
export function clippedRanges(clip, threshold = 0.01, gap = 3) {
  const ranges = [];
  let start = -1, last = -1;
  for (let i = 0; i < clip.length; i++) {
    if (clip[i] > threshold) {
      if (start < 0) start = i;
      else if (i - last > gap) { ranges.push([start, last]); start = i; }
      last = i;
    }
  }
  if (start >= 0) ranges.push([start, last]);
  return ranges;
}

/** Correlation between column position and (red - blue). Negative means red is on the left. */
export function redBlueTrend(r, b) {
  const n = r.length;
  if (n < 8) return 0;
  let mx = (n - 1) / 2, my = 0;
  for (let i = 0; i < n; i++) my += r[i] - b[i];
  my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx, dy = r[i] - b[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : 0;
}

function fmt(v) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  return String(Number(v.toPrecision(6)));
}

/** CSV text with the same leading columns as the desktop app:
 *  pixel[, wavelength_nm], R, G, B, intensity, then clipped_fraction. */
export function buildCsv({ x0, r, g, b, intensity, clip, nm }) {
  const head = ['pixel'];
  if (nm) head.push('wavelength_nm');
  head.push('R', 'G', 'B', 'intensity', 'clipped_fraction');
  const lines = [head.join(',')];
  for (let i = 0; i < r.length; i++) {
    const row = [String(x0 + i)];
    if (nm) row.push(nm[i].toFixed(3));
    row.push(fmt(r[i]), fmt(g[i]), fmt(b[i]), fmt(intensity[i]), fmt(clip[i]));
    lines.push(row.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** True if the first bytes of an image file say its colours are Display P3
 *  (an embedded "Display P3" colour profile, or HEIF colour primaries code 12). */
export function bytesMentionDisplayP3(bytes) {
  const ascii = [68, 105, 115, 112, 108, 97, 121, 32, 80, 51];           // "Display P3"
  const nclx = [99, 111, 108, 114, 110, 99, 108, 120];                   // "colrnclx"
  const n = bytes.length;
  for (let i = 0; i < n - 20; i++) {
    if (bytes[i] === 68) {
      let k = 1;
      while (k < 10 && bytes[i + k] === ascii[k]) k++;
      if (k === 10) return true;
      // the same text stored as 16-bit characters ("D", 0, "i", 0, ... or 0, "D", 0, "i", ...)
      k = 1;
      while (k < 10 && bytes[i + 2 * k] === ascii[k] && bytes[i + 2 * k - 1] === 0) k++;
      if (k === 10) return true;
    } else if (bytes[i] === 99) {
      let k = 1;
      while (k < 8 && bytes[i + k] === nclx[k]) k++;
      if (k === 8 && bytes[i + 8] === 0 && bytes[i + 9] === 12) return true;
    }
  }
  return false;
}

/** Known lines for calibration and for the reference markers. Laser wavelengths are
 *  nominal: a cheap diode can be several nm away from its label. The O2 entries are bands,
 *  several nm wide, so they suit checking better than fitting. */
export const LINE_GROUPS = [
  { id: 'sun', name: 'Sunlight (dark lines)', lines: [
    { nm: 393.4, label: 'K', name: 'Ca II K' },
    { nm: 396.8, label: 'H', name: 'Ca II H' },
    { nm: 430.8, label: 'G', name: 'G band' },
    { nm: 486.1, label: 'F', name: 'Hydrogen beta' },
    { nm: 517.3, label: 'b', name: 'Magnesium b' },
    { nm: 527.0, label: 'E', name: 'Iron E' },
    { nm: 589.3, label: 'D', name: 'Sodium D' },
    { nm: 656.3, label: 'C', name: 'Hydrogen alpha' },
    { nm: 687.5, label: 'B', name: 'Oxygen B band' },
    { nm: 761.0, label: 'A', name: 'Oxygen A band' },
  ] },
  { id: 'fluor', name: 'Fluorescent lamp (bright lines)', lines: [
    { nm: 404.7, label: '405', name: 'Mercury violet' },
    { nm: 435.8, label: '436', name: 'Mercury blue' },
    { nm: 487.7, label: '488', name: 'Terbium blue-green' },
    { nm: 546.1, label: '546', name: 'Mercury green' },
    { nm: 578.0, label: '578', name: 'Mercury yellow pair' },
    { nm: 611.6, label: '612', name: 'Europium red' },
  ] },
  { id: 'neon', name: 'Neon lamp (bright lines)', lines: [
    { nm: 585.2, label: '585', name: 'Neon 585.2' },
    { nm: 614.3, label: '614', name: 'Neon 614.3' },
    { nm: 640.2, label: '640', name: 'Neon 640.2' },
    { nm: 703.2, label: '703', name: 'Neon 703.2' },
  ] },
  { id: 'laser', name: 'Lasers (nominal)', lines: [
    { nm: 405, label: '405', name: 'Violet diode' },
    { nm: 450, label: '450', name: 'Blue diode' },
    { nm: 532, label: '532', name: 'Green DPSS' },
    { nm: 632.8, label: '633', name: 'Helium-neon' },
    { nm: 650, label: '650', name: 'Red diode' },
  ] },
  { id: 'other', name: 'Other', lines: [
    { nm: 589.3, label: 'Na', name: 'Sodium lamp or salt flame' },
    { nm: 670.8, label: 'Li', name: 'Lithium flame' },
  ] },
];

// ---------------------------------------------------------------- automatic calibration
//
// Both functions take the combined profile y (one value per band column), the frame column of
// its first sample (x0) and the frame width W, and return
//   { ok, points: [{ off, nm, src }], message, warnings, reversed, ... }
// with points in the same form as hand-marked lines (offset from the frame centre).

/** Lines a fluorescent tube or compact lamp shows at a few nm resolution. w weights how much a
 *  match counts; strong marks the lines nearly every lamp has. The green mercury line merges with
 *  terbium lines at 542-544 nm in tri-phosphor lamps. */
export const LAMP_LINES = [
  { nm: 404.7, w: 0.7, strong: false },
  { nm: 435.8, w: 1.0, strong: true },
  { nm: 487.7, w: 0.6, strong: false },
  { nm: 546.1, w: 1.0, strong: true },
  { nm: 578.0, w: 0.4, strong: false },
  { nm: 611.6, w: 1.0, strong: true },
];

/** Dark features of sunlight used to mark a sunlight calibration (placed where the fit puts them). */
export const SUN_MARKS = [393.4, 430.8, 486.1, 517.3, 589.3, 656.3, 687.5, 760.8];

const SLOPE_RANGE = [0.02, 6];   // nm per pixel that any spectroscope and camera could plausibly give

function lampPeaks(y) {
  const n = y.length;
  const ys = gaussianSmooth(y, Math.max(0.8, n / 2500));
  let top = 0;
  for (let i = 0; i < n; i++) if (ys[i] > top) top = ys[i];
  if (!(top > 0)) return { peaks: [], top: 0 };
  const found = findPeaks(ys, { minProminence: 0.015 * top, minDistance: 3 });
  found.sort((a, b) => b.prominence - a.prominence);
  const peaks = found.slice(0, 18).map((p) => ({ x: refineExtremum(ys, p.i), prom: p.prominence / top }));
  peaks.sort((a, b) => a.x - b.x);
  return { peaks, top };
}

/** Pair each lamp line with the nearest unclaimed peak within tol (nm) under map (x -> nm). */
function matchLamp(peaks, map, tol) {
  const claims = [];
  for (let li = 0; li < LAMP_LINES.length; li++) {
    let best = -1, bd = tol;
    for (let pi = 0; pi < peaks.length; pi++) {
      const d = Math.abs(map(peaks[pi].x) - LAMP_LINES[li].nm);
      if (d < bd) { bd = d; best = pi; }
    }
    if (best >= 0) claims.push({ li, pi: best, d: bd });
  }
  claims.sort((a, b) => a.d - b.d);
  const taken = new Set(), out = [];
  for (const c of claims) if (!taken.has(c.pi)) { taken.add(c.pi); out.push(c); }
  return out.sort((a, b) => a.li - b.li);
}

function scoreLamp(peaks, matches, map, tol) {
  let s = 0;
  const used = new Set(matches.map((m) => m.pi));
  for (const m of matches) s += LAMP_LINES[m.li].w * (1 - 0.5 * (m.d / tol) ** 2) + 0.3 * Math.sqrt(peaks[m.pi].prom);
  // a strong peak that the lamp pattern cannot explain counts against the match
  for (let pi = 0; pi < peaks.length; pi++) {
    if (used.has(pi) || peaks[pi].prom < 0.25) continue;
    const nm = map(peaks[pi].x);
    if (nm > 395 && nm < 625) s -= 0.5;
  }
  return s;
}

/** Fit nm against sample position (straight line for up to 3 pairs, quadratic from 4). */
function fitMap(pairs) {
  const xs = pairs.map((p) => p.x), ys = pairs.map((p) => p.nm);
  const mid = 0.5 * (Math.min(...xs) + Math.max(...xs)), half = Math.max(1, 0.5 * (Math.max(...xs) - Math.min(...xs)));
  const u = xs.map((x) => (x - mid) / half);
  let deg = pairs.length >= 4 ? 2 : 1;
  let c = polyfit(u, ys, deg);
  if (c && deg === 2 && Math.abs(c[2]) > 0.45 * Math.abs(c[1])) { deg = 1; c = polyfit(u, ys, 1); }
  if (!c) return null;
  return (x) => { const v = (x - mid) / half; return deg === 2 ? c[0] + c[1] * v + c[2] * v * v : c[0] + c[1] * v; };
}

/** Calibrate from a fluorescent lamp: try every pair of detected peaks as every pair of lamp
 *  lines, keep the straight-line guess that explains the most peaks, then refine. */
export function autoCalibrateLamp(y, x0, W) {
  const fail = (message, extra = {}) => ({ ok: false, points: [], message, warnings: [], reversed: false, ...extra });
  const { peaks } = lampPeaks(y);
  if (peaks.length < 3) return fail('Too few bright lines. Point the spectroscope at a fluorescent lamp (LED lights have no lines) and place the band on the spectrum.');
  const hyps = [];
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 0; j < peaks.length; j++) {
      if (i === j) continue;
      const dx = peaks[j].x - peaks[i].x;
      for (let a = 0; a < LAMP_LINES.length; a++) {
        for (let b = a + 1; b < LAMP_LINES.length; b++) {
          const s = (LAMP_LINES[b].nm - LAMP_LINES[a].nm) / dx;
          const as = Math.abs(s);
          if (as < SLOPE_RANGE[0] || as > SLOPE_RANGE[1]) continue;
          const xi = peaks[i].x, ni = LAMP_LINES[a].nm;
          const map = (x) => ni + s * (x - xi);
          const tol = Math.max(2.5, 3 * as);
          const m = matchLamp(peaks, map, tol);
          if (m.length < 3) continue;
          hyps.push({ score: scoreLamp(peaks, m, map, tol), s, map, n: m.length });
        }
      }
    }
  }
  if (!hyps.length) return fail('No set of peaks matches the lamp pattern. Check that the light is a fluorescent lamp and that the band covers the whole spectrum.');
  hyps.sort((p, q) => q.score - p.score);
  const best = hyps[0];
  const xmid = 0.5 * (peaks[0].x + peaks[peaks.length - 1].x);
  const rival = hyps.find((h) => Math.abs(h.map(xmid) - best.map(xmid)) > 8 || Math.abs(h.s / best.s - 1) > 0.06);
  if (rival && rival.score > 0.92 * best.score && rival.n >= best.n) {
    return fail('Two different matches fit the lamp lines about equally well. Widen the band to include the whole spectrum, or mark the lines by hand.');
  }
  if (best.s < 0) return fail('The spectrum runs from red on the left to blue on the right. Tap Flip left-right in the Source tab, then try again.', { reversed: true });

  // refine: fit through the matched lines, match again with a tighter tolerance, repeat
  let map = best.map, matches = [];
  for (let it = 0; it < 3; it++) {
    const tol = Math.max(1.5, 2 * Math.abs(best.s));
    matches = matchLamp(peaks, map, it === 0 ? Math.max(2.5, 3 * Math.abs(best.s)) : tol);
    const f = fitMap(matches.map((m) => ({ x: peaks[m.pi].x, nm: LAMP_LINES[m.li].nm })));
    if (!f) break;
    map = f;
  }
  const strong = matches.filter((m) => LAMP_LINES[m.li].strong).length;
  const nms = matches.map((m) => LAMP_LINES[m.li].nm);
  if (matches.length < 3 || strong < 2 || Math.max(...nms) - Math.min(...nms) < 100) {
    return fail('Not enough lamp lines were found to calibrate. Make the spectrum brighter or the band wider, or mark the lines by hand.');
  }
  const warnings = [];
  if (matches.length === 3) warnings.push('Only three lamp lines were found, so the fit is a straight line. Check the marked lines against the plot.');
  return {
    ok: true, reversed: false, warnings,
    points: matches.map((m) => ({ off: x0 + peaks[m.pi].x - W / 2, nm: LAMP_LINES[m.li].nm, src: 'lamp' })),
    lines: matches.length,
    message: `Found ${matches.length} lamp lines: ${nms.map((v) => v.toFixed(1)).join(', ')} nm.`,
  };
}

/** log y minus its local average (a weighted Gaussian of width sigma samples). Keeps narrow dips
 *  and removes slow changes such as the camera's colour response, which multiply the spectrum. */
function highPass(y, w, sigma) {
  const n = y.length;
  let top = 0;
  for (let i = 0; i < n; i++) if (y[i] > top) top = y[i];
  const floor = 1e-6 * (top || 1);
  const ly = new Float64Array(n), lw = new Float64Array(n);
  for (let i = 0; i < n; i++) { ly[i] = Math.log(Math.max(y[i], floor)); lw[i] = ly[i] * w[i]; }
  const num = gaussianSmooth(lw, sigma), den = gaussianSmooth(w, sigma);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = w[i] > 0 && den[i] > 1e-6 ? ly[i] - num[i] / den[i] : 0;
  return out;
}

/** Weights for scoring: 0 outside [a, b] (sample indices), else w. */
function window(w, a, b) {
  const out = new Float64Array(w.length);
  for (let i = Math.max(0, Math.ceil(a)); i <= Math.min(w.length - 1, Math.floor(b)); i++) out[i] = w[i];
  return out;
}

function interp1(arr, pos) {
  if (pos <= 0) return arr[0];
  const n = arr.length;
  if (pos >= n - 1) return arr[n - 1];
  const i = Math.floor(pos), f = pos - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

/** Weighted Pearson correlation of a and b. */
function wcorr(a, b, w, i0, i1) {
  let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = i0; i <= i1; i++) {
    const v = w[i];
    if (!v) continue;
    const x = a[i], y = b[i];
    sw += v; sa += v * x; sb += v * y; saa += v * x * x; sbb += v * y * y; sab += v * x * y;
  }
  if (sw <= 0) return { r: 0, sw: 0 };
  const va = saa - sa * sa / sw, vb = sbb - sb * sb / sw, cab = sab - sa * sb / sw;
  return { r: va > 0 && vb > 0 ? cab / Math.sqrt(va * vb) : 0, sw };
}

/** Minimise f over a few parameters (Nelder-Mead simplex). */
function nelderMead(f, start, steps, iters = 300) {
  const n = start.length;
  let pts = [start.slice()];
  for (let i = 0; i < n; i++) { const p = start.slice(); p[i] += steps[i]; pts.push(p); }
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]); vals = order.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += pts[i][k] / n;
    const along = (t) => c.map((v, k) => v + t * (pts[n][k] - v));
    const r = along(-1), fr = f(r);
    if (fr < vals[0]) {
      const e = along(-2), fe = f(e);
      if (fe < fr) { pts[n] = e; vals[n] = fe; } else { pts[n] = r; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = r; vals[n] = fr; }
    else {
      const k = along(0.5), fk = f(k);
      if (fk < vals[n]) { pts[n] = k; vals[n] = fk; }
      else {
        for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, kk) => pts[0][kk] + 0.5 * (v - pts[0][kk])); vals[i] = f(pts[i]); }
      }
    }
  }
  let bi = 0;
  for (let i = 1; i <= n; i++) if (vals[i] < vals[bi]) bi = i;
  return { x: pts[bi], f: vals[bi] };
}

/** Calibrate from sunlight or sky light: slide and stretch a reference sunlight spectrum over the
 *  measured curve until their dark lines line up best, then refine with a gentle curvature.
 *  solar: { start, step, values } on a 1 nm grid (see solar.js). */
export function autoCalibrateSun(y, x0, W, solar) {
  const fail = (message, extra = {}) => ({ ok: false, points: [], message, warnings: [], reversed: false, ...extra });
  const n = y.length;
  let ymax = 0;
  for (let i = 0; i < n; i++) if (y[i] > ymax) ymax = y[i];
  if (!(ymax > 0)) return fail('There is no spectrum in the band.');
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (y[i] > 0.1 * ymax) { if (first < 0) first = i; last = i; }
  const nLit = last - first + 1;
  if (nLit < 60) return fail('The lit part of the spectrum is too short. Widen the band or move the phone closer to the eyepiece.');
  // full weight above 20 % of the peak; scored only from 10 nm inside the fully weighted part, away
  // from the steep ends of the camera's response, which the high-pass cannot remove
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = clamp((y[i] / ymax - 0.1) / 0.1, 0, 1);
  let fullA = -1, fullB = -1;
  for (let i = 0; i < n; i++) if (w[i] >= 0.999) { if (fullA < 0) fullA = i; fullB = i; }
  if (fullA < 0) return fail('There is no spectrum in the band.');

  const HP_NM = 6;      // width of the local average, nm
  const EDGE_NM = 10;   // margin left out of the score at each end
  const T0 = solar.start, tv = solar.values;
  const tplFor = (fwhm) => highPass(gaussianSmooth(tv, fwhm / 2.355 / solar.step), new Float64Array(tv.length).fill(1), HP_NM / solar.step);
  const tpl = tplFor(5.5);

  // Coarse search: scale (nm per pixel) on a 0.8 % grid, offset in whole nm, both directions.
  // Sunlight through a phone or webcam lights roughly 380-680 nm above 10 % of the peak, so the
  // lit part is taken to span 230 to 450 nm.
  const sLo = 230 / nLit, sHi = 450 / nLit;
  // Only blue-on-the-left is searched: a mirrored solar pattern matches too easily by chance, so a
  // reversed spectrum is recognised from its colours instead (see redBlueTrend), before this is called.
  const results = [];
  for (const rev of [false]) {
    const yy = rev ? Float64Array.from(y).reverse() : y, ww = rev ? Float64Array.from(w).reverse() : w;
    const f0 = rev ? n - 1 - last : first;
    const fa = rev ? n - 1 - fullB : fullA, fb = rev ? n - 1 - fullA : fullB;
    for (let s = sLo; s <= sHi; s *= 1.008) {
      const sig = 0.6 / s;
      const ys = sig > 0.5 ? gaussianSmooth(yy, sig) : yy;
      const L = Math.floor((nLit - 1) * s) + 1;
      const ob = new Float64Array(L), wb = new Float64Array(L);
      for (let k = 0; k < L; k++) { const pos = f0 + k / s; ob[k] = interp1(ys, pos); wb[k] = interp1(ww, pos); }
      const hp = highPass(ob, wb, HP_NM);
      const ws = window(wb, (fa - f0) * s + EDGE_NM, (fb - f0) * s - EDGE_NM);
      for (let c = 330; c <= 480; c++) {
        // template sample for obs sample k is (c + k - T0)
        const k0 = Math.max(0, T0 - c), k1 = Math.min(L - 1, T0 + tv.length - 1 - c);
        if (k1 - k0 < 100) continue;
        let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let k = k0; k <= k1; k++) {
          const v = ws[k];
          if (!v) continue;
          const a = hp[k], b = tpl[c + k - T0];
          sw += v; sa += v * a; sb += v * b; saa += v * a * a; sbb += v * b * b; sab += v * a * b;
        }
        if (sw < 100) continue;
        const va = saa - sa * sa / sw, vb = sbb - sb * sb / sw;
        const r = va > 0 && vb > 0 ? (sab - sa * sb / sw) / Math.sqrt(va * vb) : 0;
        results.push({ r, s, c, rev });
      }
    }
  }
  if (!results.length) return fail('The spectrum could not be compared with sunlight.');
  results.sort((p, q) => q.r - p.r);
  const best = results[0];
  // the best answer that is clearly different from the winner (another place or another scale)
  const rival = results.find((h) => h.rev !== best.rev || Math.abs((h.c + h.s * nLit / 2) - (best.c + best.s * nLit / 2)) > 10 || Math.abs(h.s / best.s - 1) > 0.08);
  if (best.rev) return fail('The spectrum runs from red on the left to blue on the right. Tap Flip left-right in the Source tab, then try again.', { reversed: true, r: best.r });

  // refine on the pixel grid: wavelength = a0 + a1 u + a2 u^2, with u = -1..1 across the lit part
  const mid = 0.5 * (first + last), half = 0.5 * (last - first);
  const ysm = 0.6 / best.s > 0.5 ? gaussianSmooth(y, 0.6 / best.s) : y;
  const hpPx = highPass(ysm, w, HP_NM / best.s);
  const wPx = window(w, fullA + EDGE_NM / best.s, fullB - EDGE_NM / best.s);
  let fit = null;
  for (const fwhm of [4, 5.5, 8]) {
    const t = fwhm === 5.5 ? tpl : tplFor(fwhm);
    const tmp = new Float64Array(n);
    const cost = (p) => {
      const [a0, a1, a2] = p;
      if (!(Math.abs(a2) < 0.45 * Math.abs(a1))) return 2;
      for (let i = first; i <= last; i++) { const u = (i - mid) / half; tmp[i] = interp1(t, (a0 + a1 * u + a2 * u * u - T0) / solar.step); }
      return -wcorr(hpPx, tmp, wPx, first, last).r + 0.002 * (a2 / 5) ** 2;
    };
    const start = [best.c + best.s * (mid - first), best.s * half, 0];
    const r = nelderMead(cost, start, [1.5, 0.02 * start[1], 1.5], 400);
    if (!fit || r.f < fit.f) fit = { ...r, fwhm };
  }
  const [a0, a1, a2] = fit.x;
  const r = -fit.f;
  const debug = { best, rival: rival || null, refined: { a0, a1, a2, r, fwhm: fit.fwhm, first, last } };
  if (r < 0.3) return fail(`The dark lines of sunlight could not be found (match ${r.toFixed(2)}). Point at blue sky or a white sheet in sunlight, keep Peak below 90 %, and try again.`, { r, debug });
  if (rival && rival.r > best.r - 0.03) {
    return fail(`Two different matches fit sunlight about equally well (${best.r.toFixed(2)} and ${rival.r.toFixed(2)}). Widen the band to include the whole spectrum and try again.`, { r, debug });
  }
  const lamAt = (x) => { const u = (x - mid) / half; return a0 + a1 * u + a2 * u * u; };
  const lo = lamAt(first), hi = lamAt(last);
  if (lo < 340 || lo > 460 || hi < 600 || hi > 820) {
    return fail(`The best sunlight match puts the spectrum at ${lo.toFixed(0)}-${hi.toFixed(0)} nm, which is not plausible. Is this sunlight?`, { r, debug });
  }
  const xOf = (nm) => {
    // invert the quadratic on the branch inside the lit range
    if (Math.abs(a2) < 1e-12) return mid + half * (nm - a0) / a1;
    const disc = a1 * a1 - 4 * a2 * (a0 - nm);
    if (disc < 0) return null;
    const u1 = (-a1 + Math.sqrt(disc)) / (2 * a2), u2 = (-a1 - Math.sqrt(disc)) / (2 * a2);
    const u = Math.abs(u1) <= Math.abs(u2) ? u1 : u2;
    return mid + half * u;
  };
  // Final step: with the pattern aligned, find each strong dark feature on its own and calibrate
  // through them, as for lamp lines. Each feature's wavelength is where the reference spectrum,
  // blurred to the same resolution, has its dip (blended lines move at low resolution), so both
  // sides are measured the same way.
  const tb = gaussianSmooth(tv, fit.fwhm / 2.355 / solar.step);
  const found = [];
  for (const nm of SUN_MARKS) {
    const tp = snapFeature(tb, (nm - T0) / solar.step, 'dip', 6 / solar.step, 0.5);
    if (!tp.snapped) continue;
    const eff = T0 + tp.pos * solar.step;
    const xp = xOf(eff);
    if (xp === null || xp < first || xp > last) continue;
    const op = snapFeature(ysm, xp, 'dip', 6 / best.s, 0.5);
    if (!op.snapped || Math.abs(lamAt(op.pos) - eff) > 4) continue;
    found.push({ x: op.pos, nm: Math.round(eff * 10) / 10, catalogue: nm });
  }
  // drop features that disagree with the rest (a dip lost in noise, or a camera artefact)
  let used = found.slice();
  for (;;) {
    if (used.length < 4) break;
    const cal = fitCalibration(used.map((p) => ({ off: p.x - n / 2, nm: p.nm })), n);
    if (!cal.ok) break;
    let worst = 0;
    for (let i = 1; i < used.length; i++) if (Math.abs(cal.residuals[i]) > Math.abs(cal.residuals[worst])) worst = i;
    if (Math.abs(cal.residuals[worst]) <= Math.max(1.5, 3 * cal.rms) || used.length <= 4) break;
    used.splice(worst, 1);
  }
  const warnings = [];
  let points;
  if (used.length >= 3) {
    points = used.map((p) => ({ off: x0 + p.x - W / 2, nm: p.nm, src: 'sun' }));
    if (used.length === 3) warnings.push('Only three dark lines were found on their own, so the fit is a straight line.');
  } else {
    // too few separate dips: mark the features where the pattern match puts them
    points = [];
    for (const nm of SUN_MARKS) {
      if (nm < lo + 3 || nm > hi - 3) continue;
      const x = xOf(nm);
      if (x !== null) points.push({ off: x0 + x - W / 2, nm, src: 'sun' });
    }
    warnings.push('Few dark lines stood out on their own; the calibration comes from the pattern match alone.');
  }
  if (points.length < 3) return fail('Too little of the spectrum is lit to calibrate from sunlight.', { r });
  if (r < 0.45) warnings.push('The match is weak. Check the marked lines against the dark lines in the plot.');
  return {
    ok: true, reversed: false, warnings, points, r, fwhm: fit.fwhm, lines: points.length, debug: { ...debug, found },
    message: `Matched the sunlight pattern (match ${r.toFixed(2)} out of 1) and found ${points.length} dark lines between ${lo.toFixed(0)} and ${hi.toFixed(0)} nm.`,
  };
}
