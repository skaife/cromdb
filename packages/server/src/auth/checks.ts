// Checks on what a browser sends: where to go after login, and where a
// request comes from. Pure.

const MAX_RETURN_TO = 2000;

/**
 * Where to send the browser after login: a path on this server. Anything
 * that isn't one (another site, "//host", "/\host", control characters or
 * spaces a browser would drop, a backslash anywhere) becomes "/".
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_TO) {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\s\p{Cc}]/u.test(value)) {
    return "/";
  }
  // The path must stay on this origin when resolved, whatever it contains.
  const base = "https://cromdb.invalid";
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return "/";
  }
  return resolved.origin === base ? value : "/";
}

/** The origin of the public URL, as a browser sends it in Origin. */
export function publicOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

/**
 * Whether a state-changing request comes from the server's own pages. A
 * browser sends Origin on every non-GET request it makes; it must be the
 * public URL's origin. Without Origin, Sec-Fetch-Site must say same-origin.
 * With neither, the request is refused.
 */
export function originAllowed(headers: { origin?: string | undefined; secFetchSite?: string | undefined }, expectedOrigin: string): boolean {
  if (headers.origin !== undefined) {
    return headers.origin === expectedOrigin;
  }
  return headers.secFetchSite === "same-origin";
}
