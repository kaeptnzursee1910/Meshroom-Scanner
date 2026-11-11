// Lage- und Bewegungssensoren.
// Aus alpha/beta/gamma (W3C DeviceOrientation, Z-X'-Y''-Euler) wird die Blickrichtung
// der Rückkamera (Geräte-Achse -Z) in Weltkoordinaten berechnet. Das ist – anders als
// das rohe alpha – auch bei aufrecht gehaltenem Handy (beta ≈ 90°) stabil.

const DEG = Math.PI / 180;

/** @returns {{heading:number, elevation:number}} heading 0..360°, elevation -90..90° (negativ = nach unten) */
export function cameraDirection(alpha, beta, gamma) {
  const a = (alpha || 0) * DEG, b = (beta || 0) * DEG, g = (gamma || 0) * DEG;
  const sA = Math.sin(a), cA = Math.cos(a);
  const sB = Math.sin(b), cB = Math.cos(b);
  const sG = Math.sin(g), cG = Math.cos(g);
  // -1 * dritte Spalte der Rotationsmatrix R = Rz(a)·Rx(b)·Ry(g)
  const x = -(cG * sA * sB + cA * sG);
  const y = -(sA * sG - cA * cG * sB);
  const z = -(cB * cG);
  let heading = Math.atan2(x, y) / DEG;
  if (heading < 0) heading += 360;
  const elevation = Math.asin(Math.max(-1, Math.min(1, z))) / DEG;
  return { heading, elevation };
}

/** Kleinste Winkeldifferenz a-b in Grad (-180..180) */
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export class Sensors {
  constructor() {
    this.available = false;
    this.heading = null;
    this.elevation = null;
    this.rotationRate = 0;      // °/s, geglättet
    this.lastMotion = 0;
    this.listeners = new Set();
    this._onOrientation = this._onOrientation.bind(this);
    this._onMotion = this._onMotion.bind(this);
  }

  /** Muss auf iOS aus einem Klick-Handler heraus aufgerufen werden. */
  async start() {
    // iOS (und neuere Chrome-Versionen) verlangen eine Berechtigung. Wird sie verweigert,
    // registrieren wir die Listener trotzdem – es kommen dann eben keine Ereignisse.
    const ask = async (cls) => {
      if (typeof cls === 'undefined' || typeof cls.requestPermission !== 'function') return 'granted';
      try {
        return await Promise.race([cls.requestPermission(), new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
      } catch (e) {
        console.warn('Sensor-Berechtigung', e);
        return 'error';
      }
    };
    this.permission = await ask(window.DeviceOrientationEvent);
    await ask(window.DeviceMotionEvent);
    // Android/Chrome liefert mit "deviceorientationabsolute" kompassbezogene Werte.
    // Dann bleibt die Abdeckungskarte auch nach einem Neuladen der Seite gültig.
    this.absolute = 'ondeviceorientationabsolute' in window;
    this._event = this.absolute ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(this._event, this._onOrientation);
    window.addEventListener('devicemotion', this._onMotion);
    return true;
  }

  stop() {
    if (this._event) window.removeEventListener(this._event, this._onOrientation);
    window.removeEventListener('devicemotion', this._onMotion);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _onOrientation(e) {
    if (e.alpha === null && e.beta === null) return;
    const d = cameraDirection(e.alpha, e.beta, e.gamma);
    this.available = true;
    this.heading = d.heading;
    this.elevation = d.elevation;
    for (const fn of this.listeners) fn(this);
  }

  _onMotion(e) {
    const r = e.rotationRate;
    if (!r) return;
    const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    this.rotationRate = this.rotationRate * 0.7 + mag * 0.3;
    this.lastMotion = performance.now();
  }

  /** Gerät ruhig? Ohne Bewegungssensor wird "ruhig" angenommen (Schärfeprüfung greift trotzdem). */
  isSteady(maxDegPerSec) {
    if (performance.now() - this.lastMotion > 1000) return true;
    return this.rotationRate < maxDegPerSec;
  }
}
