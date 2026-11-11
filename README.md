# Meshroom-Scanner

Eine Web-App fürs Handy, die ein Objekt **automatisch aus allen Richtungen fotografiert** – als Vorlage für die 3D-Rekonstruktion mit [Meshroom](https://alicevision.org/#meshroom).

Läuft direkt im Handy-Browser (Chrome auf Android, Safari auf iOS), ohne App-Store. Sie lässt sich auch als App auf den Startbildschirm legen und funktioniert dann offline.

## Funktionen

- **Umrunden-Modus (automatisch):** Du gehst langsam um das Objekt herum. Über Kompass und Lagesensor weiß die App, aus welcher Richtung und Höhe du gerade fotografierst. Sie löst selbst aus, sobald
  - ein **neuer Blickwinkel** erreicht ist (Standard: alle 15°, also 24 Fotos pro Runde),
  - das Handy **ruhig** gehalten wird und
  - das Bild **scharf** ist (Laplace-Schärfemessung).
- **Drei Höhenringe:** tief, schräg (ca. 30°) und steil von oben (ca. 60°). Der Ring wird automatisch über die Neigung des Handys erkannt. Eine Kreisgrafik zeigt, welche Winkel noch fehlen.
- **Drehteller-Modus:** Handy auf Stativ, Objekt auf Drehteller oder Drehstuhl. Die App löst im eingestellten Takt aus (wartet auf ein scharfes, ruhiges Bild) und meldet, wenn eine Umdrehung fertig ist.
- **Manueller Auslöser**, auch per Bluetooth-Fernauslöser (Enter/Lautstärke-Taste).
- **Fokus & Belichtung sperren (AE/AF)** und **Taschenlampe**, sofern die Kamera das unterstützt.
- **EXIF für Meshroom:** Brennweite (35-mm-äquivalent), Bildgröße und eine einheitliche Seriennummer werden in jedes Foto geschrieben, damit Meshroom alle Bilder einer Kamera zuordnet.
- **Fotos bleiben gespeichert** (IndexedDB), auch nach dem Schließen des Browsers. In der Galerie kannst du schlechte Bilder löschen.
- **ZIP-Export** mit `images/IMG_0001.jpg …`, einem Aufnahmeprotokoll (`scan_log.csv`) und einer Kurzanleitung. Herunterladen oder direkt teilen (z. B. an Google Drive oder per Mail an den PC).

## Benutzen

1. App öffnen (siehe „Online stellen“) und **Scanner starten**. Kamera- und Bewegungssensor-Zugriff erlauben.
2. Objekt anpeilen und **AE/AF** tippen, damit Helligkeit und Fokus konstant bleiben.
3. **AUTO** tippen und langsam um das Objekt gehen. Das Handy dabei aufs Objekt gerichtet halten (Fadenkreuz in der Mitte).
4. Wenn ein Ring komplett ist, die nächste Höhe machen: schräg von oben, dann steil von oben.
5. In der Galerie **ZIP exportieren**, auf den PC bringen und entpacken.
6. In Meshroom den Ordner `images` ins Feld „Images“ ziehen, speichern und **Start** klicken.

### Tipps für gute Ergebnisse

- Gleichmäßiges, weiches Licht, keine harten Schatten, kein Blitz.
- Matte Objekte mit Struktur funktionieren am besten. Glänzende oder durchsichtige Flächen ggf. mattieren.
- Das Objekt sollte 60–80 % des Bildes füllen, den Abstand pro Runde möglichst gleich lassen.
- 50–200 Fotos sind ideal.
- Für eine sichere Erkennung der Richtung nicht in der Nähe großer Metallteile scannen (Kompass).

## Online stellen (GitHub Pages)

Kamerazugriff funktioniert im Browser nur über **HTTPS**. Am einfachsten ist GitHub Pages:

1. Im Repository auf **Settings → Pages** gehen.
2. Bei **Source** „**GitHub Actions**“ auswählen.
3. Der Workflow `.github/workflows/pages.yml` testet und veröffentlicht die App bei jedem Push auf `main` automatisch.
4. Danach ist die App unter `https://kaeptnzursee1910.github.io/Meshroom-Scanner/` erreichbar. Am Handy öffnen und über das Browser-Menü „**Zum Startbildschirm hinzufügen**“ wählen.

### Lokal testen

```bash
python3 -m http.server 8080
```

Am PC unter `http://localhost:8080` öffnen (localhost gilt als sicher). Fürs Handy im selben WLAN brauchst du HTTPS, z. B. über GitHub Pages oder einen Tunnel wie `ngrok`.

Tests (ohne Abhängigkeiten, Node 18+):

```bash
node tests/run.mjs
```

## Einstellungen

| Einstellung | Wirkung |
|---|---|
| Winkelabstand | Abstand zwischen zwei Fotos im Umrunden-Modus (8–30°) |
| Schärfe-Anspruch | Wie nah ein Bild an die schärfsten der letzten Sekunden herankommen muss |
| Max. Drehbewegung | Bis zu welcher Drehgeschwindigkeit noch ausgelöst wird |
| Drehteller: Intervall / Fotos pro Umdrehung | Takt und Anzahl im Drehteller-Modus |
| Videoauflösung | Auflösung des Kamerabilds (Standard: Maximum) |
| Foto-API | Nutzt `ImageCapture.takePhoto()` für volle Sensorauflösung (Android/Chrome). Langsamer, darum für den Drehteller-Modus empfohlen |
| Brennweite | Wird ins EXIF geschrieben. Die meisten Hauptkameras liegen bei 24–28 mm |

## Aufbau

```
index.html            Oberfläche (Start, Scanner, Galerie, Dialoge)
css/style.css         Mobile-first-Design
js/app.js             Ablaufsteuerung, Auto-Auslöser, Galerie, Export
js/camera.js          Kamera (getUserMedia, ImageCapture, Fokus/Belichtung/Licht)
js/sensors.js         Blickrichtung & Neigung aus DeviceOrientation, Ruhe-Erkennung
js/sharpness.js       Schärfe (Laplace-Varianz) mit adaptiver Schwelle
js/coverage.js        Abdeckungsmodell: Höhenringe × Winkelsegmente
js/exif.js            Minimaler EXIF-Writer
js/zip.js             ZIP-Writer ohne Kompression (keine Abhängigkeiten)
js/storage.js         IndexedDB-Speicher
sw.js                 Service Worker (offline)
tests/run.mjs         Unit-Tests
```

## Grenzen

- Im Umrunden-Modus werden Bewegungssensoren gebraucht. Ohne sie bleibt der Drehteller-Modus oder manuelles Auslösen.
- Auf iOS liefert Safari nur das Videobild (keine Foto-API). Die Auflösung entspricht dann dem Kamerastream.
- Unter iOS ist die Richtung relativ zum Start: Nach einem Neuladen der Seite stimmt die Abdeckungsgrafik nicht mehr. Dann in den Einstellungen „Abdeckung zurücksetzen“ (die Fotos bleiben erhalten).
