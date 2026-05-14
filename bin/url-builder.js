/**
 * Compose user-facing mdr URLs honoring MDR_HOST.
 *
 * When MDR_HOST is set the URLs we hand to the user (browser, console,
 * MCP tool baseUrl) point at that hostname so a laptop browser can reach
 * a remote dev host (e.g. Cloud Desktop FQDN). When unset the URL falls
 * back to `localhost`, preserving the historical default for local-only
 * users.
 *
 * The scheme switches to `https` whenever MDR_HOST is set. The server
 * binds an HTTPS listener on the FQDN's IP so the browser gets a secure
 * context (`crypto.randomUUID`, `navigator.clipboard`). The first hit
 * shows a "Your connection is not private" warning; users click through
 * once per cert.
 *
 * Internal CLI->server fetches (port probes, version checks, grant-access)
 * still hard-code `http://localhost` because the loopback HTTP listener is
 * always running and they execute on the same host as the server. Only
 * URLs we expose to the user (or to the MCP client, which relays the URL
 * to the user's chat UI) flow through here.
 */
export function getDisplayHost(env = process.env) {
  const raw = env.MDR_HOST;
  // Lowercase so the printed URL matches the server's Host header
  // allowlist, which also lowercases. Browsers normalize the Host header to
  // lowercase regardless, but this keeps the user-visible URL consistent.
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().toLowerCase();
  return 'localhost';
}

export function getDisplayScheme(env = process.env) {
  const raw = env.MDR_HOST;
  if (typeof raw === 'string' && raw.trim() !== '') return 'https';
  return 'http';
}

export function buildBrowserUrl({ port, file, dir, env = process.env } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('buildBrowserUrl requires a valid port');
  }
  const host = getDisplayHost(env);
  const scheme = getDisplayScheme(env);
  const baseUrl = `${scheme}://${host}:${port}`;
  if (file) return `${baseUrl}?file=${encodeURIComponent(file)}`;
  if (dir) return `${baseUrl}?dir=${encodeURIComponent(dir)}`;
  return baseUrl;
}
