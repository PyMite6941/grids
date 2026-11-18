// Guards for features that only make sense on the user's own computer: editing the
// key file and running subscription CLIs with the owner's account.

export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Feature flag: explicit env value wins, otherwise "on" only for a loopback-bound server. */
export function localOnly(flag, bindHost) {
  return flag ? flag === '1' : LOOPBACK.has(bindHost);
}

/**
 * Editing keys writes secrets to disk, so it needs the feature on AND a same-origin
 * JSON request addressed to a loopback Host. That blocks other websites (CSRF: a
 * cross-site form can't set Origin or send application/json without a preflight we
 * never answer) and DNS rebinding (the Host header would be the attacker's name).
 */
export function keyEditAllowed(req, { bindHost, flag }) {
  if (!localOnly(flag, bindHost)) return false;
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '');
  if (!LOOPBACK.has(hostname)) return false;
  return req.headers.origin === `http://${host}` && /^application\/json\b/.test(String(req.headers['content-type'] ?? ''));
}
