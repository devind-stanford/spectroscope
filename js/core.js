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

export const VERSION = '0.1.0';

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
