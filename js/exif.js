// Schreibt einen minimalen EXIF-Block (APP1) in ein JPEG.
// Meshroom (AliceVision CameraInit) braucht Brennweiten-Infos, um die Kamera-Intrinsik
// zu schätzen. Canvas-JPEGs haben keinerlei EXIF – deshalb ergänzen wir:
// Make, Model, Orientation, Software, DateTime, DateTimeOriginal, FocalLength,
// FocalLengthIn35mmFilm, PixelX/YDimension und eine BodySerialNumber
// (gleiche Seriennummer => Meshroom fasst alle Bilder zu EINER Kamera zusammen).

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;

function exifDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function asciiBytes(str) {
  const clean = String(str).replace(/[^\x20-\x7e]/g, '?');
  const b = new Uint8Array(clean.length + 1);
  for (let i = 0; i < clean.length; i++) b[i] = clean.charCodeAt(i);
  return b; // nullterminiert
}

// Baut ein IFD. entries: [{tag, type, value}] – value: Uint8Array (ASCII), number, [num, den]
function buildIfd(entries, ifdOffset, nextIfdOffset = 0) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const headerSize = 2 + entries.length * 12 + 4;
  const extra = [];
  let extraSize = 0;
  const dataStart = ifdOffset + headerSize;
  const buf = new DataView(new ArrayBuffer(headerSize));
  buf.setUint16(0, entries.length, true);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    buf.setUint16(o, e.tag, true);
    buf.setUint16(o + 2, e.type, true);
    if (e.type === ASCII) {
      buf.setUint32(o + 4, e.value.length, true);
      if (e.value.length <= 4) {
        e.value.forEach((v, j) => buf.setUint8(o + 8 + j, v));
      } else {
        buf.setUint32(o + 8, dataStart + extraSize, true);
        extra.push(e.value);
        extraSize += e.value.length;
        if (extraSize % 2) { extra.push(new Uint8Array(1)); extraSize++; }
      }
    } else if (e.type === SHORT) {
      buf.setUint32(o + 4, 1, true);
      buf.setUint16(o + 8, e.value, true);
    } else if (e.type === LONG) {
      buf.setUint32(o + 4, 1, true);
      buf.setUint32(o + 8, e.value, true);
    } else if (e.type === RATIONAL) {
      buf.setUint32(o + 4, 1, true);
      buf.setUint32(o + 8, dataStart + extraSize, true);
      const r = new DataView(new ArrayBuffer(8));
      r.setUint32(0, e.value[0], true);
      r.setUint32(4, e.value[1], true);
      extra.push(new Uint8Array(r.buffer));
      extraSize += 8;
    }
  });
  buf.setUint32(2 + entries.length * 12, nextIfdOffset, true);
  const out = new Uint8Array(headerSize + extraSize);
  out.set(new Uint8Array(buf.buffer), 0);
  let p = headerSize;
  for (const x of extra) { out.set(x, p); p += x.length; }
  return out;
}

/**
 * Erzeugt das TIFF-Payload des EXIF-Blocks.
 * @param {{make?:string, model?:string, software?:string, date?:Date, focal35?:number,
 *          width:number, height:number, serial?:string}} m
 */
export function buildExifTiff(m) {
  const date = asciiBytes(exifDate(m.date || new Date()));
  const focal = Math.max(1, Math.round((m.focal35 || 26) * 100));

  const exifEntries = [
    { tag: 0x9003, type: ASCII, value: date },                    // DateTimeOriginal
    { tag: 0x920a, type: RATIONAL, value: [focal, 100] },        // FocalLength (35-mm-äquiv.)
    { tag: 0xa002, type: LONG, value: m.width },                 // PixelXDimension
    { tag: 0xa003, type: LONG, value: m.height },                // PixelYDimension
    { tag: 0xa405, type: SHORT, value: Math.round(m.focal35 || 26) }, // FocalLengthIn35mmFilm
  ];
  if (m.serial) exifEntries.push({ tag: 0xa431, type: ASCII, value: asciiBytes(m.serial) }); // BodySerialNumber

  const ifd0Entries = [
    { tag: 0x010f, type: ASCII, value: asciiBytes(m.make || 'MeshroomScanner') },
    { tag: 0x0110, type: ASCII, value: asciiBytes(m.model || 'Phone') },
    { tag: 0x0112, type: SHORT, value: 1 },                       // Orientation: normal
    { tag: 0x0131, type: ASCII, value: asciiBytes(m.software || 'Meshroom-Scanner') },
    { tag: 0x0132, type: ASCII, value: date },
    { tag: 0x8769, type: LONG, value: 0 },                        // Exif-IFD-Pointer (Platzhalter)
  ];

  // Erst IFD0 bauen, um seine Länge zu kennen, dann mit richtigem Pointer neu bauen.
  const ifd0Offset = 8;
  let ifd0 = buildIfd(ifd0Entries, ifd0Offset);
  const exifOffset = ifd0Offset + ifd0.length;
  ifd0Entries[5].value = exifOffset;
  ifd0 = buildIfd(ifd0Entries, ifd0Offset);
  const exifIfd = buildIfd(exifEntries, exifOffset);

  const tiff = new Uint8Array(8 + ifd0.length + exifIfd.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0); // "II*\0" + Offset 8
  tiff.set(ifd0, 8);
  tiff.set(exifIfd, exifOffset);
  return tiff;
}

/** Fügt einen EXIF-APP1-Block in JPEG-Bytes ein (ersetzt ein evtl. vorhandenes JFIF-APP0). */
export function insertExif(jpeg, meta) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Kein JPEG');
  const tiff = buildExifTiff(meta);
  const segLen = 2 + 6 + tiff.length;
  const app1 = new Uint8Array(2 + segLen);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1[2] = segLen >> 8; app1[3] = segLen & 0xff;
  app1.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // "Exif\0\0"
  app1.set(tiff, 10);

  let rest = 2;
  // JFIF-APP0 direkt nach SOI entfernen (EXIF und JFIF gleichzeitig ist unsauber)
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) rest = 4 + ((jpeg[4] << 8) | jpeg[5]);

  const out = new Uint8Array(2 + app1.length + (jpeg.length - rest));
  out.set([0xff, 0xd8], 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(rest), 2 + app1.length);
  return out;
}

/** Prüft grob, ob ein JPEG bereits EXIF enthält. */
export function hasExif(jpeg) {
  let i = 2;
  while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda) break; // Start of Scan
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === 0xe1 && jpeg[i + 4] === 0x45 && jpeg[i + 5] === 0x78) return true;
    i += 2 + len;
  }
  return false;
}
