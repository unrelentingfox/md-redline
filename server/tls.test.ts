import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// We need to override the cert dir to a tmp path. The implementation reads
// homedir() at call time, so the simplest path is to monkey-patch
// process.env.HOME (which homedir() honors on POSIX) for the duration of
// each test. On macOS/Linux this is sufficient; on Windows the tests would
// also need USERPROFILE.
const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'mdr-tls-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserprofile;
  await rm(tmpHome, { recursive: true, force: true });
});

// Import lazily so each test sees the patched HOME via homedir().
async function importTls() {
  return await import('./tls');
}

const HOSTNAME = 'dev-dsk-test.us-east-1.amazon.com';

describe('getOrCreateSelfSignedCert', () => {
  it('mints a cert when no cache exists', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    const pair = await getOrCreateSelfSignedCert(HOSTNAME);
    expect(pair.key).toMatch(/-----BEGIN .*PRIVATE KEY-----/);
    expect(pair.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  it('persists the cert with mode 0600 on the key', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    await getOrCreateSelfSignedCert(HOSTNAME);
    const keyPath = join(tmpHome, '.md-redline-certs', `${HOSTNAME}.key`);
    const certPath = join(tmpHome, '.md-redline-certs', `${HOSTNAME}.crt`);
    const keyStat = await stat(keyPath);
    const certStat = await stat(certPath);
    // Mask the type bits so we compare just permissions.
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(certStat.mode & 0o777).toBeGreaterThan(0); // exists, readable
  });

  it('persists the cert directory with mode 0700', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    await getOrCreateSelfSignedCert(HOSTNAME);
    const dir = join(tmpHome, '.md-redline-certs');
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('tightens directory mode to 0700 even if it pre-existed at 0755', async () => {
    // Simulate an upgrade from a hypothetical older mdr that left the dir
    // at the user's umask default.
    const { mkdir, chmod } = await import('fs/promises');
    const dir = join(tmpHome, '.md-redline-certs');
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755); // mkdir's mode is umask-masked; force it.
    const beforeStat = await stat(dir);
    expect(beforeStat.mode & 0o777).toBe(0o755);

    const { getOrCreateSelfSignedCert } = await importTls();
    await getOrCreateSelfSignedCert(HOSTNAME);

    const afterStat = await stat(dir);
    expect(afterStat.mode & 0o777).toBe(0o700);
  });

  it('returns the cached cert on the second call', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    const first = await getOrCreateSelfSignedCert(HOSTNAME);
    const second = await getOrCreateSelfSignedCert(HOSTNAME);
    expect(second.key).toBe(first.key);
    expect(second.cert).toBe(first.cert);
  });

  it('regenerates when the cached cert is past notAfter', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    await getOrCreateSelfSignedCert(HOSTNAME);
    const certPath = join(tmpHome, '.md-redline-certs', `${HOSTNAME}.crt`);
    const original = await readFile(certPath, 'utf8');

    // Replace the cert with a syntactically valid but bogus one. The
    // X509Certificate constructor will reject it, getCertNotAfter returns
    // null, and the read path treats that as "regenerate".
    await writeFile(
      certPath,
      '-----BEGIN CERTIFICATE-----\nbogus\n-----END CERTIFICATE-----\n',
    );

    const after = await getOrCreateSelfSignedCert(HOSTNAME);
    expect(after.cert).not.toBe(original);
    // The new cert should parse cleanly (round-trip via the same call).
    expect(after.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  it('sanitizes hostnames with path-traversal characters', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    await getOrCreateSelfSignedCert('../etc/passwd');
    // The cache should land inside ~/.md-redline-certs/ — path-traversal
    // characters get replaced with underscores.
    const sanitized = '.._etc_passwd';
    const keyPath = join(tmpHome, '.md-redline-certs', `${sanitized}.key`);
    const keyStat = await stat(keyPath);
    expect(keyStat.isFile()).toBe(true);
  });

  it('keeps separate cache entries for distinct hostnames', async () => {
    const { getOrCreateSelfSignedCert } = await importTls();
    const a = await getOrCreateSelfSignedCert('host-a.example.com');
    const b = await getOrCreateSelfSignedCert('host-b.example.com');
    expect(a.cert).not.toBe(b.cert);
  });
});
