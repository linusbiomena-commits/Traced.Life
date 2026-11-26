import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { FAKE_CAMERA_FILE, writeBlankCamera } from './server/test/e2e/fake-camera.ts';

// Simulated camera: Edge reads this video file as its webcam. Tests overwrite it with a real
// customer QR code before starting the scanner.
mkdirSync('test-results', { recursive: true });
writeBlankCamera();

// Browser end-to-end tests against a throwaway local stack (server/test/e2e/serve.ts).
// Uses the installed Microsoft Edge, so no browser download is needed.
const PORT = 8791;

export default defineConfig({
  testDir: 'server/test/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results/e2e-artifacts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    permissions: ['camera'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(FAKE_CAMERA_FILE)}`],
    },
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx server/test/e2e/serve.ts',
    url: `http://localhost:${PORT}/api/v1/health`,
    env: { E2E_PORT: String(PORT), E2E_MAIL_DIR: 'test-results/e2e-mail' },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
