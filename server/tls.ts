import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { X509Certificate } from 'crypto';
import { generate as generateSelfSigned } from 'selfsigned';

/**
 * Generate (or load from cache) a self-signed TLS cert for `hostname`.
 *
 * Why self-signed: when MDR_HOST points at a remote dev host (Cloud Desktop,
 * etc.), the client browser is no longer on a loopback origin, so secure
 * context APIs (`crypto.randomUUID`, `navigator.clipboard`, etc.) refuse to
 * run unless the page is served over HTTPS. We don't have a real CA we can
 * mint dev-host certs from, so the next-best thing is a self-signed cert
 * that the user trusts on first visit ("Your connection is not private" →
 * Advanced → Proceed). It's a one-time prompt per browser per cert.
 *
 * Cache layout: `~/.md-redline-certs/<hostname>.{key,crt}` with mode 0700 on
 * the directory and 0600 on the key. The cert is regenerated when missing,
 * past its `notAfter` date, or within a week of expiry, so users don't have
 * to manually rotate. We pick a 2-year validity to keep the trust prompts
 * rare without holding a stale cert forever. The cache is keyed on the
 * configured hostname string only — a different MDR_HOST value gets a
 * different cache entry, but DNS changes for the same name reuse the
 * existing cert (the SAN binds to the name, not the IP).
 */

interface CachedCert {
  key: string;
  cert: string;
}

function getCertDir(): string {
  return join(homedir(), '.md-redline-certs');
}

function getCertPaths(hostname: string): { keyPath: string; certPath: string } {
  // MDR_HOST is user-supplied; sanitize defensively against path traversal
  // (e.g. "../etc/passwd"). Replace any character that isn't legal in a
  // hostname with an underscore before composing the cache file path.
  const safe = hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = getCertDir();
  return {
    keyPath: join(dir, `${safe}.key`),
    certPath: join(dir, `${safe}.crt`),
  };
}

/**
 * Parse the cert PEM and return its `notAfter` date, or null if it can't be
 * parsed. We use this to detect expired cached certs and regenerate them.
 */
function getCertNotAfter(certPem: string): Date | null {
  try {
    const cert = new X509Certificate(certPem);
    const date = new Date(cert.validTo);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

async function readCachedCert(hostname: string): Promise<CachedCert | null> {
  const { keyPath, certPath } = getCertPaths(hostname);
  try {
    const [key, cert] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(certPath, 'utf8'),
    ]);
    const notAfter = getCertNotAfter(cert);
    if (!notAfter) return null;
    // Renew a week before expiry so we don't hand out a cert that expires
    // mid-session.
    if (notAfter.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000) return null;
    return { key, cert };
  } catch {
    return null;
  }
}

async function writeCachedCert(hostname: string, pair: CachedCert): Promise<void> {
  const { keyPath, certPath } = getCertPaths(hostname);
  const dir = dirname(keyPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` only applies when the directory is freshly created. If
  // it already existed (older mdr install, default umask) the mode is
  // whatever the umask let through, which can leak the cert filenames to
  // other local users. chmod explicitly so the dir is 0700 either way.
  try { await chmod(dir, 0o700); } catch { /* best effort */ }
  await writeFile(keyPath, pair.key, { encoding: 'utf8', mode: 0o600 });
  await writeFile(certPath, pair.cert, 'utf8');
  // writeFile's `mode` only applies on creation, not on overwrite — chmod
  // explicitly so re-cached keys are still 0600 after rotation.
  try { await chmod(keyPath, 0o600); } catch { /* best effort */ }
}

async function generateCertForHostname(hostname: string): Promise<CachedCert> {
  const result = await generateSelfSigned(
    [{ name: 'commonName', value: hostname }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true,
        },
        {
          name: 'extKeyUsage',
          serverAuth: true,
        },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: hostname },
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    },
  );
  return { key: result.private, cert: result.cert };
}

/**
 * Get a cert/key pair for `hostname`, generating and caching if necessary.
 * Safe to call on every server start: cache hits return immediately, misses
 * pay one ~200ms cert generation cost.
 */
export async function getOrCreateSelfSignedCert(hostname: string): Promise<CachedCert> {
  const cached = await readCachedCert(hostname);
  if (cached) return cached;
  const pair = await generateCertForHostname(hostname);
  await writeCachedCert(hostname, pair);
  return pair;
}
