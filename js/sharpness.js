// Schärfe- und Helligkeitsmessung auf einem verkleinerten Videobild.
// Schärfe = Varianz des Laplace-Filters (hoch = viele Kanten = scharf).

export function measureFrame(rgba, w, h) {
  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    gray[i] = v;
    sum += v;
  }
  let lsum = 0, lsq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      lsum += l; lsq += l * l; n++;
    }
  }
  const mean = lsum / n;
  return { sharpness: lsq / n - mean * mean, brightness: sum / gray.length };
}

/**
 * Adaptive Schwelle: ein Bild gilt als scharf, wenn es mindestens `strictness` (0..1)
 * des 90-%-Perzentils der letzten Messungen erreicht. So funktioniert es unabhängig
 * davon, wie viel Struktur das Objekt hat.
 */
export class SharpnessTracker {
  constructor(size = 90) {
    this.size = size;
    this.values = [];
    this.current = 0;
  }
  push(v) {
    this.current = v;
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
  }
  reference() {
    if (this.values.length < 10) return null;
    const s = [...this.values].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.9)];
  }
  isSharp(strictness) {
    const ref = this.reference();
    if (ref === null) return false;
    return this.current >= ref * strictness && this.current > 5;
  }
  ratio() {
    const ref = this.reference();
    return ref ? Math.min(1.5, this.current / ref) : 0;
  }
}
