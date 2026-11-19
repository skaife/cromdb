// Reading the Cookie header and writing Set-Cookie. Pure.

/**
 * The cookies in a Cookie header, by name. A name sent more than once keeps
 * every value, in the order sent (the browser sends the most specific path
 * first). Values are taken as sent: the server's own cookies are base64url.
 */
export function parseCookies(header: string | undefined): Map<string, string[]> {
  const cookies = new Map<string, string[]>();
  if (header === undefined) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals <= 0) continue;
    const name = part.slice(0, equals).trim();
    let value = part.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name === "") continue;
    const values = cookies.get(name) ?? [];
    values.push(value);
    cookies.set(name, values);
  }
  return cookies;
}

export interface CookieOptions {
  readonly path: string;
  /** Seconds; 0 removes the cookie. */
  readonly maxAge: number;
  readonly secure: boolean;
}

/** A Set-Cookie value: always HttpOnly and SameSite=Lax, never a Domain. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Cookie ${name} has characters the server never puts in a cookie`);
  }
  const parts = [`${name}=${value}`, `Path=${options.path}`, `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`, "HttpOnly", "SameSite=Lax"];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
