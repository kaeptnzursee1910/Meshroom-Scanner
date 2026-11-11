// Abdeckungsmodell: Ringe (Höhenstufen) × Winkelsegmente rund ums Objekt.
import { angleDiff } from './sensors.js';

export const RINGS = [
  { id: 0, name: 'Tief',  hint: 'Kamera etwa auf Objekthöhe', min: -22, max: 90 },
  { id: 1, name: 'Mitte', hint: 'leicht von oben (ca. 30°)',   min: -50, max: -22 },
  { id: 2, name: 'Hoch',  hint: 'steil von oben (ca. 60°)',    min: -90, max: -50 },
];

export function ringForElevation(elev) {
  if (elev === null || elev === undefined) return 0;
  for (const r of RINGS) if (elev > r.min && elev <= r.max) return r.id;
  return elev > 0 ? 0 : 2;
}

export class Coverage {
  constructor(stepDeg = 15) {
    this.setStep(stepDeg);
    this.shots = []; // {ring, heading}
  }
  setStep(stepDeg) {
    this.step = stepDeg;
    this.segments = Math.round(360 / stepDeg);
  }
  reset() { this.shots = []; }
  add(ring, heading) { if (heading !== null && heading !== undefined) this.shots.push({ ring, heading }); }
  load(shots) { this.shots = shots.filter((s) => s.heading !== null && s.heading !== undefined); }

  segmentOf(heading) { return Math.floor((((heading % 360) + 360) % 360) / this.step) % this.segments; }

  filled(ring) {
    const f = new Array(this.segments).fill(false);
    for (const s of this.shots) if (s.ring === ring) f[this.segmentOf(s.heading)] = true;
    return f;
  }

  ringProgress(ring) {
    const f = this.filled(ring);
    return f.filter(Boolean).length / f.length;
  }

  /** Abstand (°) zur nächsten vorhandenen Aufnahme im selben Ring */
  nearest(ring, heading) {
    let best = Infinity;
    for (const s of this.shots) if (s.ring === ring) best = Math.min(best, Math.abs(angleDiff(heading, s.heading)));
    return best;
  }

  /** Soll an dieser Position automatisch ausgelöst werden? */
  wants(ring, heading) {
    if (heading === null) return false;
    const seg = this.segmentOf(heading);
    if (this.filled(ring)[seg]) return false;
    return this.nearest(ring, heading) >= this.step * 0.6;
  }
}
