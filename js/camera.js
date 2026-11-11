// Kamerazugriff: Rückkamera mit höchstmöglicher Auflösung, optional Fokus/Belichtung sperren,
// Taschenlampe, Vollauflösungs-Fotos über die ImageCapture-API (falls vorhanden).

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.locked = false;
    this.torch = false;
  }

  async start(resolution = 'max') {
    this.stop();
    const sizes = {
      max: { width: { ideal: 4096 }, height: { ideal: 3072 } },
      high: { width: { ideal: 2560 }, height: { ideal: 1920 } },
      medium: { width: { ideal: 1920 }, height: { ideal: 1440 } },
    };
    const constraints = {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, ...(sizes[resolution] || sizes.max) },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));
    this.imageCapture = 'ImageCapture' in window ? new window.ImageCapture(this.track) : null;
    this.locked = false;
    this.torch = false;
    // Kontinuierlicher Autofokus, falls verfügbar
    await this._apply({ focusMode: 'continuous', exposureMode: 'continuous', whiteBalanceMode: 'continuous' });
    return this.info();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = this.track = this.imageCapture = null;
  }

  caps() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  info() {
    const s = this.track?.getSettings?.() || {};
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      label: this.track?.label || '',
      settings: s,
      canLock: (this.caps().focusMode || []).includes('manual') || (this.caps().exposureMode || []).includes('manual'),
      canTorch: !!this.caps().torch,
      canPhoto: !!this.imageCapture,
    };
  }

  async _apply(adv) {
    if (!this.track) return false;
    const caps = this.caps();
    const filtered = {};
    for (const [k, v] of Object.entries(adv)) {
      if (k === 'torch' ? caps.torch : Array.isArray(caps[k]) && caps[k].includes(v)) filtered[k] = v;
    }
    if (!Object.keys(filtered).length) return false;
    try {
      await this.track.applyConstraints({ advanced: [filtered] });
      return true;
    } catch (e) {
      console.warn('applyConstraints', filtered, e);
      return false;
    }
  }

  /** Fokus, Belichtung und Weißabgleich einfrieren – wichtig für gleichmäßige Bilder in Meshroom. */
  async setLocked(lock) {
    const mode = lock ? 'manual' : 'continuous';
    const ok = await this._apply({ focusMode: mode, exposureMode: mode, whiteBalanceMode: mode });
    this.locked = lock && ok;
    return ok;
  }

  async setTorch(on) {
    const ok = await this._apply({ torch: on });
    this.torch = on && ok;
    return ok;
  }

  /** Vollauflösungsfoto über ImageCapture.takePhoto() – liefert JPEG-Blob oder null. */
  async takePhoto() {
    if (!this.imageCapture) return null;
    try {
      const caps = await this.imageCapture.getPhotoCapabilities();
      const opts = {};
      if (caps?.imageWidth?.max) opts.imageWidth = caps.imageWidth.max;
      if (caps?.imageHeight?.max) opts.imageHeight = caps.imageHeight.max;
      if (caps?.fillLightMode?.includes('off')) opts.fillLightMode = this.torch ? undefined : 'off';
      Object.keys(opts).forEach((k) => opts[k] === undefined && delete opts[k]);
      const blob = await this.imageCapture.takePhoto(opts);
      return blob && blob.size > 0 ? blob : null;
    } catch (e) {
      console.warn('takePhoto fehlgeschlagen, nutze Videobild', e);
      return null;
    }
  }

  /** Aktuelles Videobild in voller Stream-Auflösung als JPEG. */
  async grabFrame(quality = 0.95) {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(this.video, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    return { blob, width: w, height: h };
  }
}
