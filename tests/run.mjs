// Unit-Tests ohne Abhängigkeiten:  node tests/run.mjs
// Erzeugt außerdem tests/out/ mit einer Test-ZIP und einem Test-JPEG für externe Prüfungen.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { crc32, createZip } from '../js/zip.js';
import { insertExif, hasExif, buildExifTiff } from '../js/exif.js';
import { cameraDirection, angleDiff } from '../js/sensors.js';
import { Coverage, ringForElevation } from '../js/coverage.js';
import { measureFrame, SharpnessTracker } from '../js/sharpness.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('✓', name); } catch (e) { console.error('✗', name); throw e; }
};
const near = (a, b, eps = 0.5) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const out = new URL('./out/', import.meta.url);
mkdirSync(out, { recursive: true });

await test('crc32 Referenzwert', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

await test('Kamerarichtung: Handy aufrecht, nach Norden', () => {
  const d = cameraDirection(0, 90, 0);
  near(d.heading, 0); near(d.elevation, 0);
});

await test('Kamerarichtung: Handy flach, Kamera nach unten', () => {
  near(cameraDirection(123, 0, 0).elevation, -90);
});

await test('Kamerarichtung: um 90° gedreht und 30° nach unten geneigt', () => {
  // alpha = 90 bedeutet Drehung gegen den Uhrzeigersinn => Kamera schaut nach Westen (270°)
  const d = cameraDirection(90, 60, 0);
  near(d.heading, 270); near(d.elevation, -30);
});

await test('Kamerarichtung bleibt bei beta≈90 stabil (kein Gimbal-Lock-Sprung)', () => {
  const a = cameraDirection(40, 89.9, 0), b = cameraDirection(40, 90.1, 0);
  near(angleDiff(a.heading, b.heading), 0, 1);
});

await test('angleDiff über 0°/360°', () => {
  assert.equal(angleDiff(5, 355), 10);
  assert.equal(angleDiff(355, 5), -10);
});

await test('Ringe nach Neigung', () => {
  assert.equal(ringForElevation(0), 0);
  assert.equal(ringForElevation(-30), 1);
  assert.equal(ringForElevation(-70), 2);
});

await test('Abdeckung: Auslöselogik', () => {
  const c = new Coverage(15);
  assert.equal(c.segments, 24);
  assert.ok(c.wants(0, 13));
  c.add(0, 13);
  assert.ok(!c.wants(0, 5), 'gleiches Segment');
  assert.ok(!c.wants(0, 17), 'neues Segment, aber zu nah an letzter Aufnahme');
  assert.ok(c.wants(0, 23));
  assert.ok(c.wants(1, 13), 'anderer Ring unabhängig');
  for (let h = 0; h < 360; h += 15) c.add(0, h + 1);
  assert.equal(c.ringProgress(0), 1);
});

await test('Schärfe: Kanten > glatte Fläche', () => {
  const w = 64, h = 64;
  const flat = new Uint8ClampedArray(w * h * 4).fill(128);
  const checker = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = ((i % w) >> 2 ^ Math.floor(i / w) >> 2) & 1 ? 255 : 0;
    checker.set([v, v, v, 255], i * 4);
  }
  const a = measureFrame(flat, w, h), b = measureFrame(checker, w, h);
  assert.equal(a.sharpness, 0);
  assert.ok(b.sharpness > 1000);
  near(a.brightness, 128, 1);
  const t = new SharpnessTracker();
  for (let i = 0; i < 20; i++) t.push(100);
  t.push(30); assert.ok(!t.isSharp(0.7));
  t.push(95); assert.ok(t.isSharp(0.7));
});

await test('EXIF einfügen', () => {
  const jpgPath = new URL('./fixture.jpg', import.meta.url);
  assert.ok(existsSync(jpgPath), 'tests/fixture.jpg fehlt');
  const jpg = new Uint8Array(readFileSync(jpgPath));
  assert.ok(!hasExif(jpg));
  const res = insertExif(jpg, { model: 'Pixel 8', focal35: 26, width: 64, height: 48, serial: 'MSTEST-64x48', date: new Date(2026, 10, 11, 12, 0, 0) });
  assert.ok(hasExif(res));
  assert.equal(res[0], 0xff); assert.equal(res[1], 0xd8);
  assert.equal(buildExifTiff({ width: 1, height: 1 }).length % 2, 0);
  writeFileSync(new URL('./with_exif.jpg', out), res);
});

await test('ZIP erzeugen', async () => {
  const enc = new TextEncoder();
  const img = new Blob([readFileSync(new URL('./out/with_exif.jpg', import.meta.url))]);
  const zip = await createZip([
    { name: 'images/IMG_0001.jpg', data: img },
    { name: 'images/IMG_0002.jpg', data: img, crc: crc32(new Uint8Array(await img.arrayBuffer())) },
    { name: 'scan_log.csv', data: enc.encode('a;b\n1;2') },
    { name: 'LIESMICH.txt', data: enc.encode('Grüße') },
  ]);
  writeFileSync(new URL('./test.zip', out), new Uint8Array(await zip.arrayBuffer()));
});

console.log(`\n${passed} Tests bestanden.`);
