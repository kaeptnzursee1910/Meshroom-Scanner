import { Camera } from './camera.js';
import { Sensors } from './sensors.js';
import { measureFrame, SharpnessTracker } from './sharpness.js';
import { Coverage, RINGS, ringForElevation } from './coverage.js';
import { storage } from './storage.js';
import { insertExif, hasExif } from './exif.js';
import { crc32, createZip } from './zip.js';

const $ = (s) => document.querySelector(s);

// ---------- Einstellungen ----------
const DEFAULTS = {
  step: 15, strictness: 0.7, maxRotation: 20, interval: 2, perRing: 36,
  resolution: 'max', usePhotoApi: false, focal35: 26, vibrate: true,
};
const FORMAT = {
  step: (v) => `${v}° (${Math.round(360 / v)} pro Ring)`,
  strictness: (v) => `${Math.round(v * 100)} %`,
  maxRotation: (v) => `${v} °/s`,
  interval: (v) => `${v} s`,
  perRing: (v) => `${v} (${(360 / v).toFixed(1)}°)`,
  focal35: (v) => `${v} mm`,
};
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ms-settings') || '{}') };
const saveSettings = () => localStorage.setItem('ms-settings', JSON.stringify(settings));

// ---------- Zustand ----------
const camera = new Camera($('#video'));
const sensors = new Sensors();
const sharp = new SharpnessTracker();
const coverage = new Coverage(settings.step);
const state = {
  mode: 'orbit',          // 'orbit' | 'turntable'
  auto: false,
  busy: false,
  count: 0,
  lastShot: 0,
  brightness: 128,
  turntableRing: 0,
  turntableCount: 0,
  wakeLock: null,
  deviceSerial: localStorage.getItem('ms-serial') || (() => {
    const s = 'MS' + Math.random().toString(36).slice(2, 10).toUpperCase();
    localStorage.setItem('ms-serial', s);
    return s;
  })(),
};

// ---------- Hilfsfunktionen ----------
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

function setStatus(text, cls = '') {
  const el = $('#status');
  if (el.textContent !== text) el.textContent = text;
  el.className = 'status ' + cls;
}

function setMeter(id, ratio) {
  const el = $(id);
  el.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  el.className = ratio >= 0.95 ? 'ok' : ratio >= 0.6 ? 'mid' : '';
}

function deviceModel() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
  if (m) return m[1].trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return 'Smartphone';
}

async function refreshCounts() {
  const meta = await storage.meta();
  state.count = meta.length;
  $('#count').textContent = meta.length;
  $('#intro-count').textContent = meta.length;
  coverage.load(meta.filter((m) => m.mode === state.mode || (!m.mode && state.mode === 'orbit')));
  if (state.mode === 'turntable') {
    const ttShots = meta.filter((m) => m.mode === 'turntable');
    const inRing = ttShots.filter((m) => m.ring === state.turntableRing).length;
    state.turntableCount = inRing;
  }
  return meta;
}

// ---------- Aufnahme ----------
async function capture(reason = 'manual') {
  if (state.busy || !camera.track) return;
  state.busy = true;
  $('#btn-shutter').classList.add('busy');
  const flash = $('#flash');
  flash.classList.add('on');
  requestAnimationFrame(() => setTimeout(() => flash.classList.remove('on'), 60));
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(30);

  // Lage zum Auslösezeitpunkt festhalten
  let ring, heading;
  if (state.mode === 'turntable') {
    ring = state.turntableRing;
    heading = (state.turntableCount * 360) / settings.perRing;
  } else {
    heading = sensors.heading;
    ring = ringForElevation(sensors.elevation);
  }
  const elevation = sensors.elevation;
  const sharpness = sharp.current;

  try {
    // Vorschaubild sofort aus dem Video
    const thumb = await makeThumb();
    let blob = null, width = 0, height = 0, source = 'video';
    if (settings.usePhotoApi && camera.imageCapture) {
      blob = await camera.takePhoto();
      if (blob) {
        source = 'photo';
        try {
          const bmp = await createImageBitmap(blob);
          width = bmp.width; height = bmp.height;
          const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
          if (head[0] !== 0xff || head[1] !== 0xd8) {
            // Manche Geräte liefern PNG o. Ä. – Meshroom braucht EXIF, also nach JPEG wandeln
            const c = document.createElement('canvas');
            c.width = width; c.height = height;
            c.getContext('2d').drawImage(bmp, 0, 0);
            blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
          }
          bmp.close();
        } catch (err) {
          console.warn('Foto-API-Bild unlesbar, nutze Videobild', err);
          blob = null;
        }
      }
    }
    if (!blob) {
      const f = await camera.grabFrame(0.95);
      blob = f.blob; width = f.width; height = f.height;
    }
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (!hasExif(bytes)) {
      bytes = insertExif(bytes, {
        make: 'MeshroomScanner', model: deviceModel(), focal35: settings.focal35,
        width, height, serial: `${state.deviceSerial}-${width}x${height}`, date: new Date(),
      });
    }
    const crc = crc32(bytes);
    const finalBlob = new Blob([bytes], { type: 'image/jpeg' });
    await storage.add({
      blob: finalBlob, thumb, crc, size: bytes.length, width, height, source,
      heading, elevation, ring, sharpness, mode: state.mode, reason, time: Date.now(),
    });
    coverage.add(ring, heading);
    state.count++;
    if (state.mode === 'turntable') state.turntableCount++;
    $('#count').textContent = state.count;
    setLastThumb(thumb);
    checkRingDone(ring);
  } catch (e) {
    console.error(e);
    toast('Speichern fehlgeschlagen: ' + (e.message || e), 4000);
    if (/quota|voll/i.test(String(e))) setAuto(false);
  } finally {
    state.lastShot = performance.now();
    state.busy = false;
    $('#btn-shutter').classList.remove('busy');
  }
}

let lastThumbUrl;
function setLastThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = blob ? URL.createObjectURL(blob) : '';
  $('#last-thumb').src = lastThumbUrl;
}

async function makeThumb() {
  const v = $('#video');
  const w = 240, h = Math.round((v.videoHeight / v.videoWidth) * w) || 320;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.7));
}

function checkRingDone(ring) {
  if (state.mode === 'turntable') {
    if (state.turntableCount >= settings.perRing) {
      setAuto(false);
      const next = state.turntableRing + 1;
      if (next < RINGS.length) {
        state.turntableRing = next;
        state.turntableCount = 0;
        toast(`Umdrehung fertig! Kamera höher stellen (${RINGS[next].hint}) und AUTO drücken.`, 6000);
      } else {
        toast('Alle Höhen fertig – jetzt exportieren!', 6000);
      }
    }
    return;
  }
  const p = coverage.ringProgress(ring);
  if (p >= 1 && !checkRingDone.done?.[ring]) {
    (checkRingDone.done ||= {})[ring] = true;
    const next = RINGS.find((r) => r.id !== ring && coverage.ringProgress(r.id) < 1);
    toast(next ? `Ring „${RINGS[ring].name}“ komplett! Weiter mit „${next.name}“: ${next.hint}.` : 'Alle Ringe komplett – jetzt exportieren!', 6000);
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([60, 60, 60]);
  }
}

// ---------- Analyse-Schleife ----------
const probe = document.createElement('canvas');
const probeCtx = probe.getContext('2d', { willReadFrequently: true });

function analyse() {
  const v = $('#video');
  if (!v.videoWidth) return;
  const w = 200, h = Math.round((v.videoHeight / v.videoWidth) * w);
  if (probe.width !== w) { probe.width = w; probe.height = h; }
  // Mittleren Bildausschnitt bewerten (dort steht das Objekt)
  const sx = v.videoWidth * 0.2, sy = v.videoHeight * 0.2;
  probeCtx.drawImage(v, sx, sy, v.videoWidth * 0.6, v.videoHeight * 0.6, 0, 0, w, h);
  const { data } = probeCtx.getImageData(0, 0, w, h);
  const m = measureFrame(data, w, h);
  sharp.push(m.sharpness);
  state.brightness = m.brightness;
}

function tick() {
  if (!$('#scan').classList.contains('active')) return;
  analyse();

  const steadyRatio = sensors.lastMotion
    ? Math.max(0, 1 - sensors.rotationRate / (settings.maxRotation * 2)) / 0.5
    : 1;
  setMeter('#m-sharp', sharp.ratio() / settings.strictness);
  setMeter('#m-steady', Math.min(1, steadyRatio));
  setMeter('#m-light', Math.min(1, state.brightness / 90) * (state.brightness > 235 ? 0.5 : 1));

  const steady = sensors.isSteady(settings.maxRotation);
  const isSharp = sharp.isSharp(settings.strictness);
  const dark = state.brightness < 35;
  const sinceLast = performance.now() - state.lastShot;

  let ringNow = state.mode === 'turntable' ? state.turntableRing : ringForElevation(sensors.elevation);
  $('#ring-name').textContent = RINGS[ringNow].name + (state.mode === 'turntable'
    ? ` ${state.turntableCount}/${settings.perRing}` : ` ${Math.round(coverage.ringProgress(ringNow) * 100)} %`);

  if (state.mode === 'orbit') {
    if (!sensors.available) {
      setStatus('Keine Lagesensoren – Drehteller-Modus oder manuell auslösen', 'warn');
    } else if (!state.auto) {
      setStatus('AUTO drücken und langsam ums Objekt gehen');
    } else if (!coverage.wants(ringNow, sensors.heading)) {
      setStatus(coverage.ringProgress(ringNow) >= 1 ? `Ring fertig – ${nextRingHint(ringNow)}` : 'Weitergehen …', '');
    } else if (dark) {
      setStatus('Zu dunkel', 'warn');
    } else if (!steady) {
      setStatus('Ruhig halten …', 'warn');
    } else if (!isSharp) {
      setStatus('Wird scharf gestellt …', 'warn');
    } else if (sinceLast > 450 && !state.busy) {
      setStatus('Klick!', 'good');
      capture('auto');
    }
  } else {
    if (!state.auto) {
      setStatus(`Drehteller: AUTO drücken (alle ${settings.interval} s ein Foto)`);
    } else {
      const remain = settings.interval * 1000 - sinceLast;
      const overdue = remain < -settings.interval * 1000; // nach doppelter Zeit trotzdem auslösen
      if (remain > 0) {
        setStatus(`Drehen … ${Math.ceil(remain / 1000)}`, '');
      } else if (!state.busy && ((steady && isSharp) || overdue)) {
        setStatus('Klick!', 'good');
        capture('auto');
      } else {
        setStatus(!steady ? 'Ruhig halten …' : 'Wird scharf gestellt …', 'warn');
      }
    }
  }

  drawCoverage(ringNow);
}

function nextRingHint(ring) {
  const next = RINGS.find((r) => r.id !== ring && coverage.ringProgress(r.id) < 1);
  return next ? `nächste Höhe: ${next.hint}` : 'alles erfasst!';
}

// ---------- Abdeckungs-Grafik ----------
function drawCoverage(activeRing) {
  const c = $('#coverage');
  const ctx = c.getContext('2d');
  const W = c.width, cx = W / 2, cy = W / 2;
  ctx.clearRect(0, 0, W, W);
  const seg = coverage.segments;
  const gap = 0.025;
  RINGS.forEach((r, i) => {
    const radius = W * (0.42 - i * 0.12);
    const filled = coverage.filled(r.id);
    ctx.lineWidth = W * 0.085;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2 - Math.PI / 2 + gap;
      const a1 = ((s + 1) / seg) * Math.PI * 2 - Math.PI / 2 - gap;
      ctx.strokeStyle = filled[s] ? '#2fbf71' : r.id === activeRing ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.stroke();
    }
  });
  // Aktuelle Blickrichtung
  const h = state.mode === 'turntable'
    ? (state.turntableCount * 360) / settings.perRing
    : sensors.heading;
  if (h !== null && h !== undefined) {
    const a = (h / 360) * Math.PI * 2 - Math.PI / 2;
    const rOuter = W * 0.49, rInner = W * 0.1;
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner);
    ctx.lineTo(cx + Math.cos(a) * rOuter, cy + Math.sin(a) * rOuter);
    ctx.stroke();
  }
  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 ${W * 0.12}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(state.count), cx, cy);
}

// ---------- Steuerung ----------
function setAuto(on) {
  state.auto = on;
  $('#btn-auto').classList.toggle('on', on);
  if (on) state.lastShot = performance.now() - (state.mode === 'turntable' ? settings.interval * 500 : 0);
}

function setMode(mode) {
  state.mode = mode;
  setAuto(false);
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  refreshCounts();
  if (mode === 'turntable') toast('Handy auf Stativ, Objekt auf Drehteller. Zwischen den Fotos weiterdrehen.', 4000);
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* egal */ }
}

let loop;
async function startScanner() {
  $('#intro-error').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    showIntroError('Dieser Browser erlaubt keinen Kamerazugriff. Bitte Chrome (Android) oder Safari (iOS) verwenden und die Seite über HTTPS öffnen.');
    return;
  }
  // Sensoren zuerst (iOS verlangt dafür einen direkten Klick)
  await sensors.start();
  try {
    await camera.start(settings.resolution);
  } catch (e) {
    showIntroError('Kamera konnte nicht gestartet werden: ' + (e.message || e.name) + '. Bitte Kamerazugriff erlauben.');
    return;
  }
  storage.persist();
  show('scan');
  updateCameraButtons();
  await refreshCounts();
  const last = (await storage.all()).pop();
  if (last) setLastThumb(last.thumb);
  requestWakeLock();
  clearInterval(loop);
  loop = setInterval(tick, 120);
  setTimeout(() => { if (!sensors.available) toast('Keine Lagesensoren gefunden – Umrunden-Automatik nicht möglich.', 4000); }, 1500);
}

function showIntroError(msg) {
  const el = $('#intro-error');
  el.textContent = msg;
  el.hidden = false;
}

function updateCameraButtons() {
  const info = camera.info();
  $('#btn-lock').hidden = !info.canLock;
  $('#btn-torch').hidden = !info.canTorch;
  $('#btn-lock').classList.toggle('on', camera.locked);
  $('#btn-torch').classList.toggle('on', camera.torch);
  $('#device-info').textContent = `Kamera: ${info.width}×${info.height}${info.label ? ' · ' + info.label : ''}`
    + ` · Foto-API: ${info.canPhoto ? 'ja' : 'nein'} · Sensoren: ${sensors.available ? (sensors.absolute ? 'Kompass' : 'relativ') : 'keine'}`;
}

// ---------- Galerie & Export ----------
const thumbUrls = [];
async function openGallery() {
  show('gallery');
  setAuto(false);
  $('#export-result').hidden = true;
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const all = await storage.meta();
  const grid = $('#grid');
  grid.textContent = '';
  let bytes = 0;
  all.forEach((p, i) => {
    bytes += p.size || 0;
    const d = document.createElement('div');
    d.className = 'thumb';
    const img = document.createElement('img');
    const url = URL.createObjectURL(p.thumb);
    thumbUrls.push(url);
    img.src = url;
    img.loading = 'lazy';
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = `${i + 1} · ${RINGS[p.ring]?.name || ''}`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Foto löschen');
    del.onclick = async () => { await storage.remove(p.id); d.remove(); await refreshCounts(); updateGalleryInfo(); };
    d.append(img, no, del);
    grid.append(d);
  });
  updateGalleryInfo(bytes);
}

async function updateGalleryInfo(bytes) {
  const meta = await storage.meta();
  if (bytes === undefined) bytes = meta.reduce((s, p) => s + (p.size || 0), 0);
  $('#gallery-info').textContent = `${meta.length} · ${(bytes / 1048576).toFixed(1)} MB`;
  const perRing = RINGS.map((r) => `${r.name}: ${meta.filter((m) => m.ring === r.id).length}`);
  const advice = meta.length < 30 ? ' · für Meshroom besser ≥ 50 Fotos' : '';
  $('#ring-summary').innerHTML = perRing.map((t) => `<span>${t}</span>`).join('') + (advice ? `<span>${advice.slice(3)}</span>` : '');
  $('#btn-export').disabled = meta.length === 0;
}

let exportUrl;
async function exportZip() {
  const btn = $('#btn-export');
  btn.disabled = true;
  btn.textContent = 'Erstelle ZIP …';
  try {
    const all = await storage.all();
    if (!all.length) return;
    const pad = (n) => String(n).padStart(4, '0');
    const entries = all.map((p, i) => ({ name: `images/IMG_${pad(i + 1)}.jpg`, data: p.blob, crc: p.crc, date: new Date(p.time) }));
    const csv = ['datei;zeit;modus;ring;richtung_grad;neigung_grad;schaerfe;breite;hoehe;quelle']
      .concat(all.map((p, i) => [
        `IMG_${pad(i + 1)}.jpg`, new Date(p.time).toISOString(), p.mode, RINGS[p.ring]?.name,
        p.heading?.toFixed(1) ?? '', p.elevation?.toFixed(1) ?? '', Math.round(p.sharpness || 0), p.width, p.height, p.source,
      ].join(';'))).join('\n');
    const readme = [
      'Meshroom-Scanner Export',
      '',
      '1. ZIP entpacken.',
      '2. Meshroom starten und den Ordner "images" in das Feld "Images" ziehen.',
      '3. Datei speichern und "Start" klicken.',
      '',
      `Fotos: ${all.length}`,
      `Brennweite (35 mm äquiv.) im EXIF: ${settings.focal35} mm`,
    ].join('\r\n');
    const enc = new TextEncoder();
    entries.push({ name: 'scan_log.csv', data: enc.encode(csv) });
    entries.push({ name: 'LIESMICH.txt', data: enc.encode(readme) });

    const zip = await createZip(entries);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `meshroom-scan_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}.zip`;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(zip);
    const a = $('#export-download');
    a.href = exportUrl;
    a.download = name;
    $('#export-text').textContent = `${name} (${(zip.size / 1048576).toFixed(1)} MB) ist fertig.`;
    const file = new File([zip], name, { type: 'application/zip' });
    const shareBtn = $('#export-share');
    shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    shareBtn.onclick = () => navigator.share({ files: [file], title: 'Meshroom-Scan' }).catch(() => {});
    $('#export-result').hidden = false;
  } catch (e) {
    console.error(e);
    toast('Export fehlgeschlagen: ' + (e.message || e), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ZIP exportieren';
  }
}

// ---------- Einstellungen-Dialog ----------
function bindSettings() {
  const form = $('#settings form');
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  const updateOutputs = () => form.querySelectorAll('output').forEach((o) => {
    const k = o.dataset.for;
    o.textContent = FORMAT[k] ? FORMAT[k](Number(form.elements[k].value)) : form.elements[k].value;
  });
  updateOutputs();
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.name) return;
    const old = settings[el.name];
    settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    saveSettings();
    updateOutputs();
    if (el.name === 'step') { coverage.setStep(settings.step); checkRingDone.done = {}; }
    if (el.name === 'resolution' && old !== settings.resolution && camera.track) {
      camera.start(settings.resolution).then(updateCameraButtons).catch((err) => toast('Kamera: ' + err.message));
    }
  });
  $('#btn-reset-coverage').onclick = async () => {
    // Fotos bleiben erhalten, nur die Richtungsinfos werden "vergessen"
    coverage.reset();
    checkRingDone.done = {};
    state.turntableCount = 0;
    state.turntableRing = 0;
    toast('Abdeckung zurückgesetzt (Fotos bleiben erhalten).');
    coverageResetAt = Date.now();
    localStorage.setItem('ms-coverage-reset', String(coverageResetAt));
  };
}
let coverageResetAt = Number(localStorage.getItem('ms-coverage-reset') || 0);
// Nach "Abdeckung zurücksetzen" ältere Fotos nicht mehr in die Karte laden
const _load = coverage.load.bind(coverage);
coverage.load = (shots) => _load(shots.filter((s) => (s.time || 0) > coverageResetAt));

// ---------- Ereignisse ----------
$('#btn-start').onclick = startScanner;
$('#btn-intro-gallery').onclick = openGallery;
$('#btn-shutter').onclick = () => capture('manual');
$('#btn-auto').onclick = () => setAuto(!state.auto);
$('#btn-lock').onclick = async () => {
  const ok = await camera.setLocked(!camera.locked);
  updateCameraButtons();
  toast(camera.locked ? 'Fokus & Belichtung gesperrt' : ok ? 'Automatik wieder aktiv' : 'Sperren wird von dieser Kamera nicht unterstützt');
};
$('#btn-torch').onclick = async () => { await camera.setTorch(!camera.torch); updateCameraButtons(); };
$('#btn-gallery').onclick = openGallery;
$('#btn-gallery-back').onclick = () => (camera.track ? show('scan') : show('intro'));
$('#btn-settings').onclick = () => { updateCameraButtons(); $('#settings').showModal(); };
$('#btn-help').onclick = () => $('#help').showModal();
$('#btn-export').onclick = exportZip;
$('#export-close').onclick = () => ($('#export-result').hidden = true);
$('#btn-clear').onclick = async () => {
  if (!confirm('Wirklich alle Fotos löschen?')) return;
  await storage.clear();
  coverage.reset();
  checkRingDone.done = {};
  state.turntableCount = 0;
  state.turntableRing = 0;
  setLastThumb(null);
  await refreshCounts();
  openGallery();
};
document.querySelectorAll('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && camera.track) requestWakeLock();
  if (document.visibilityState === 'hidden') setAuto(false);
});
// Lautstärketasten/Leertaste als Auslöser (Bluetooth-Fernauslöser senden oft Enter oder Lautstärke)
document.addEventListener('keydown', (e) => {
  if (!$('#scan').classList.contains('active')) return;
  if (['Enter', ' ', 'AudioVolumeUp', 'AudioVolumeDown', 'VolumeUp', 'VolumeDown'].includes(e.key)) {
    e.preventDefault();
    capture('manual');
  }
});

bindSettings();
refreshCounts().catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Für Tests/Debugging
window.__scanner = { state, settings, coverage, sensors, capture, storage };
