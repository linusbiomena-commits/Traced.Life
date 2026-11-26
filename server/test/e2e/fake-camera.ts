import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

// Builds a .y4m video (the format Chromium/Edge accept for --use-file-for-fake-video-capture)
// so browser tests exercise the real camera → decode path with a known QR code.

export const FAKE_CAMERA_FILE = 'test-results/fake-camera.y4m';
const W = 640;
const H = 480;

function toY4m(rgba: (x: number, y: number) => [number, number, number], frames = 6): Buffer {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [r, g, b] = rgba(i, j);
      y[j * W + i] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
      if (i % 2 === 0 && j % 2 === 0) {
        const k = (j / 2) * (W / 2) + i / 2;
        u[k] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
        v[k] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
      }
    }
  }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, u, v]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: frames }, () => frame)]);
}

/** A plain grey frame (no QR) — what the fake camera shows until a test sets a code. */
export function writeBlankCamera(file = FAKE_CAMERA_FILE): void {
  writeFileSync(file, toY4m(() => [200, 200, 200], 2));
}

/** Writes a camera video showing `text` as a QR code on a white card. */
export async function writeQrCamera(text: string, file = FAKE_CAMERA_FILE): Promise<void> {
  const png = PNG.sync.read(await QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 4, width: 360 }));
  const ox = Math.floor((W - png.width) / 2);
  const oy = Math.floor((H - png.height) / 2);
  writeFileSync(file, toY4m((x, y) => {
    const px = x - ox;
    const py = y - oy;
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return [255, 255, 255];
    const k = (py * png.width + px) * 4;
    return [png.data[k]!, png.data[k + 1]!, png.data[k + 2]!];
  }));
}

/**
 * Phase 7 (root cause of the intermittent camera failures): Edge opens the fake-capture file once
 * per browser process and keeps reading the copy it opened, so rewriting the shared file between
 * tests raced with the device already running in the shared browser. Each camera step now gets
 * its own Edge instance whose camera file is written before launch and never changed, with the
 * signed-in session carried over (cookies and local storage). Call close() when done.
 */
export async function cameraPage(from: Page, text: string | null, url: string, opts: { headers?: Record<string, string>; mobile?: boolean } = {}) {
  const file = path.resolve('test-results/cameras', `${randomUUID()}.y4m`);
  mkdirSync(path.dirname(file), { recursive: true });
  if (text === null) writeBlankCamera(file);
  else await writeQrCamera(text, file);
  const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`] });
  const origin = new URL(from.url()).origin;
  const viewport = from.viewportSize();
  const ctx = await browser.newContext({
    baseURL: origin, permissions: ['camera'], storageState: await from.context().storageState(),
    ...(viewport ? { viewport } : {}), ...(opts.headers ? { extraHTTPHeaders: opts.headers } : {}), ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(url);
  return {
    page,
    close: async () => {
      await browser.close().catch(() => {});
      rmSync(file, { force: true });
    },
  };
}
