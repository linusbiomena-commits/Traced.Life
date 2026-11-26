// Camera QR scanning inside the browser. Video frames are decoded on the device and never
// leave it: no images or video are uploaded anywhere. Uses the browser's native BarcodeDetector
// when it supports QR codes, otherwise the open-source ZXing library served from this site.

const CUSTOMER_TOKEN_RE = /^c1_[A-Za-z0-9_-]{43}$/;
const TRACKING_ID_RE = /^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}$/;
const SCAN_INTERVAL_MS = 180;

/**
 * Extracts a customer token from scanned text (a TRACED QR URL, or the bare token typed by a USB
 * scanner). Anything else returns null. URLs found in QR codes are never opened.
 */
export function extractCustomerToken(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 300) return null;
  const candidate = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  return CUSTOMER_TOKEN_RE.test(candidate) ? candidate : null;
}

export function isTrackingIdOnly(text) {
  return TRACKING_ID_RE.test(String(text ?? '').trim());
}

export class ScannerError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // 'insecure' | 'noCamera' | 'permission' | 'camera'
  }
}

let zxingPromise;
function loadZxing() {
  if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
  zxingPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/portal/vendor/zxing-browser.min.js?v=0.2.1';
    s.async = true;
    s.onload = () => (window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(new Error('scanner library missing')));
    s.onerror = () => reject(new Error('scanner library failed to load'));
    document.head.append(s);
  });
  return zxingPromise;
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return { kind: 'native', detect: async (video) => (await detector.detect(video))[0]?.rawValue ?? null };
      }
    } catch {
      /* fall back to ZXing */
    }
  }
  const ZX = await loadZxing();
  const reader = new ZX.BrowserQRCodeReader();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    kind: 'zxing',
    detect: async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      const scale = Math.min(1, 800 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        return reader.decodeFromCanvas(canvas).getText();
      } catch {
        return null; // no QR code in this frame
      }
    },
  };
}

/**
 * Drives one <video> element. Stops the camera as soon as a code is read (one result per start,
 * so the same QR can't trigger repeated requests), and whenever stop() is called.
 */
export class QrScanner {
  constructor(video, onResult) {
    this.video = video;
    this.onResult = onResult;
    this.stream = null;
    this.timer = null;
    this.running = false;
    this.detector = null;
  }

  async start(deviceId) {
    if (!window.isSecureContext) throw new ScannerError('insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new ScannerError('noCamera');
    this.stop();
    const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new ScannerError('permission');
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') throw new ScannerError('noCamera');
      throw new ScannerError('camera');
    }
    this.video.setAttribute('playsinline', ''); // iOS: play inline instead of fullscreen
    this.video.muted = true;
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay is allowed for muted inline video; ignore benign interruptions */
    }
    this.detector ??= await createDetector();
    this.running = true;
    this.tick();
  }

  get activeDeviceId() {
    return this.stream?.getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
  }

  async cameras() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  tick() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      let text = null;
      try {
        text = await this.detector.detect(this.video);
      } catch {
        text = null;
      }
      if (!this.running) return;
      if (text) {
        this.stop();
        this.onResult(text);
      } else {
        this.tick();
      }
    }, SCAN_INTERVAL_MS);
  }

  /** Releases the camera completely (turns the camera light off). Safe to call repeatedly. */
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}
