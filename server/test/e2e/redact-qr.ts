import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';

// Screenshots are committed as evidence, and the repository may be public. A customer QR code in
// a screenshot encodes a real (test) QR token, which must never be published, even for throwaway
// test databases. This finds every decodable QR code in a PNG and paints over the sensitive ones
// (with a margin), repeating until nothing sensitive decodes. Used by the browser-test screenshot helpers and as a CLI:
//   node --import tsx server/test/e2e/redact-qr.ts <file.png> [...]

type JsQr = (data: Uint8ClampedArray, width: number, height: number) => { data: string; location: Record<string, { x: number; y: number }> } | null;
const jsQR: JsQr = ((jsQRModule as unknown as { default?: JsQr }).default ?? (jsQRModule as unknown as JsQr));

export function findQr(png: PNG) {
  return jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
}

/**
 * Content that must never be published: customer and physical-sample QR links/tokens, MFA enrolment links and any
 * one-time token. (jsQR occasionally "decodes" noise in dense text; such false positives are
 * skipped rather than painted over, so evidence screenshots stay readable.)
 */
export const SENSITIVE_QR = /\/traced\/[cs]\/|\b[cs]1_|otpauth:|token=/i; // customer (c1_) and physical-sample (s1_) QR tokens

/** Paints over every decodable sensitive QR code in a PNG image held in memory. */
export function redactQrBuffer(image: Buffer): { image: Buffer; count: number } {
  const png = PNG.sync.read(image);
  const scratch = PNG.sync.read(PNG.sync.write(png)); // search copy: every hit is blanked here
  let count = 0;
  for (let round = 0; round < 30; round++) {
    const found = findQr(scratch);
    if (!found) break;
    const pts = Object.values(found.location);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const pad = Math.ceil(size * 0.25) + 4; // cover the quiet zone and finder patterns completely
    const box = {
      x0: Math.max(0, Math.floor(Math.min(...xs)) - pad), y0: Math.max(0, Math.floor(Math.min(...ys)) - pad),
      x1: Math.min(png.width, Math.ceil(Math.max(...xs)) + pad), y1: Math.min(png.height, Math.ceil(Math.max(...ys)) + pad),
    };
    paint(scratch, box);
    if (SENSITIVE_QR.test(found.data)) {
      paint(png, box);
      count++;
    }
  }
  return { image: count > 0 ? PNG.sync.write(png) : image, count };
}

/** Paints over every decodable sensitive QR code in a PNG file. Returns how many were redacted. */
export async function redactQrCodes(file: string): Promise<number> {
  const { image, count } = redactQrBuffer(await readFile(file));
  if (count > 0) await writeFile(file, image);
  return count;
}

function paint(png: PNG, { x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      // Neutral grey with a fine diagonal hatch, so the redaction is obvious in the evidence.
      const v = (x + y) % 12 < 2 ? 0xb0 : 0xdc;
      png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 0xff;
    }
  }
}

/** True if a PNG still contains a decodable sensitive QR code (used by the screenshot check). */
export async function hasSensitiveQr(file: string): Promise<boolean> {
  const png = PNG.sync.read(await readFile(file));
  for (let round = 0; round < 30; round++) {
    const found = findQr(png);
    if (!found) return false;
    if (SENSITIVE_QR.test(found.data)) return true;
    const pts = Object.values(found.location);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    paint(png, { x0: Math.max(0, Math.floor(Math.min(...xs)) - 4), y0: Math.max(0, Math.floor(Math.min(...ys)) - 4), x1: Math.min(png.width, Math.ceil(Math.max(...xs)) + 4), y1: Math.min(png.height, Math.ceil(Math.max(...ys)) + 4) });
  }
  return false;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let total = 0;
  for (const f of process.argv.slice(2)) {
    const n = await redactQrCodes(f);
    if (n) console.log(`redacted ${n} QR code(s): ${f}`);
    total += n;
  }
  console.log(`done: ${total} QR code(s) redacted in ${process.argv.length - 2} file(s)`);
}

/**
 * Takes a screenshot in memory and saves it with a few retries (on Windows, sync/antivirus tools
 * occasionally hold a PNG open for a moment). Sensitive QR codes are redacted before writing.
 */
export async function saveScreenshot(page: { screenshot: (o: { fullPage: boolean }) => Promise<Buffer> }, file: string, fullPage = true): Promise<void> {
  // Phase 7: redact in memory first, so an unredacted image never touches the disk (a crash or a
  // concurrent reader between "write" and "redact" could otherwise see the raw QR code).
  const { image } = redactQrBuffer(await page.screenshot({ fullPage }));
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, image);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
