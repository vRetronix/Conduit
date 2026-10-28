/** The origin the packaged dashboard is served from (custom Electron protocol). */
export const APP_PROTOCOL = 'app';
export const APP_HOST = 'conduit';
export const APP_ORIGIN = `${APP_PROTOCOL}://${APP_HOST}`;

export const DEFAULT_API_PORT = 47820;

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True when `host` refers only to this machine (a bind address or a Host header hostname). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || IPV4_LOOPBACK.test(h);
}

/** Matches a serialized origin such as `http://localhost:5173` or `app://conduit` (no path, query or fragment). */
const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/\s?#@]+$/i;

export function isValidOrigin(origin: string): boolean {
  return ORIGIN_PATTERN.test(origin);
}

/**
 * Extracts the hostname from an HTTP Host header value, stripping any port.
 * Handles bracketed IPv6 literals (`[::1]:47820`).
 */
export function hostnameFromHostHeader(hostHeader: string): string {
  const value = hostHeader.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}
