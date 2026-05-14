import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { HmrContext, Plugin, ViteDevServer } from 'vite';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const serverPort = Number.parseInt(process.env.MD_REDLINE_VITE_PORT ?? '5188', 10);
const apiPort = Number.parseInt(process.env.MD_REDLINE_PORT ?? process.env.PORT ?? '3001', 10);

// When MDR_HOST is set, the production server binds an HTTPS listener so
// the FQDN page is served over a secure context. Mirror that in dev mode:
// load the same self-signed cert (already minted by `mdr` or by the
// production server) and serve Vite over HTTPS too. Without this, the SPA
// loaded from `https://<fqdn>:5188` would mixed-content-block and
// crypto.randomUUID would still be undefined.
function loadDevHttpsConfig(): { key: Buffer; cert: Buffer } | undefined {
  const mdrHost = process.env.MDR_HOST?.trim();
  if (!mdrHost) return undefined;
  const safe = mdrHost.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = join(homedir(), '.md-redline-certs');
  const keyPath = join(dir, `${safe}.key`);
  const certPath = join(dir, `${safe}.crt`);
  try {
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  } catch {
    // No cached cert yet. The production server mints one on first launch,
    // so the typical dev workflow is: run `mdr` once to generate the cert,
    // then `npm run dev` picks it up. Warn loudly so users don't waste
    // time debugging mixed-content errors when the SPA loads over HTTP
    // from an HTTPS-expecting browser.
    console.warn(
      `[mdr] MDR_HOST is set but no cached cert at ${certPath}. ` +
        'Run `mdr` once to mint one, then restart `npm run dev`. ' +
        'Falling back to plain HTTP for now.',
    );
    return undefined;
  }
}

const devHttps = loadDevHttpsConfig();

export function ignoreMarkdownHotUpdatePlugin(): Plugin {
  return {
    name: 'ignore-markdown-hot-updates',
    handleHotUpdate(ctx: HmrContext) {
      if (ctx.file.toLowerCase().endsWith('.md')) {
        return [];
      }
      return undefined;
    },
  };
}

export function mdrIdentityPlugin(): Plugin {
  return {
    name: 'mdr-identity',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: { url?: string }, res: { end: (body: string) => void }, next: () => void) => {
        if (req.url === '/__mdr__') {
          res.end('mdr');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ignoreMarkdownHotUpdatePlugin(), mdrIdentityPlugin()],
  test: {
    // Exclude .worktrees/** so vitest doesn't pick up nested e2e specs from
    // sibling git worktrees (e.g. .worktrees/<feature>/e2e/foo.spec.ts) and
    // try to run them as unit tests. demo/ contains a Playwright spec too.
    exclude: ['e2e/**', 'demo/**', 'node_modules/**', '.worktrees/**'],
  },
  server: {
    port: serverPort,
    https: devHttps,
    proxy: {
      // The API server always binds a plain-HTTP listener on 127.0.0.1,
      // even in MDR_HOST mode. Vite proxying to localhost:apiPort keeps
      // working without any extra cert plumbing.
      '/api': `http://localhost:${apiPort}`,
    },
    watch: {
      ignored: ['**/*.md'],
    },
  },
});
