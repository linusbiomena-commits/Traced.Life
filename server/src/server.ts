import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import type { Deps } from './context.ts';

/** The API plus (local development only) the static site from dist/ on the same origin. */
export function createHttpApp(deps: Deps, staticRoot = './dist') {
  const app = createApp(deps);
  if (deps.config.serveStatic) app.use('/*', serveStatic({ root: staticRoot }));
  return app;
}
