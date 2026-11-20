// Real Keycloak as a login harness: the realms in fixtures/keycloak/realms,
// imported by scripts/keycloak.mjs, which starts Keycloak and passes its
// address in KEYCLOAK_URL. A login is driven as a browser would drive the
// login page, with fetch, a cookie jar and the form parsed from the page;
// no browser. The pinned Keycloak version keeps the page stable.

import type { LoginHarness, TestUser } from "./harness.js";

/** The image scripts/keycloak.mjs runs, by tag and digest. */
export const KEYCLOAK_VERSION = "26.8.1";

const user = (username: string, email: string, name: string): TestUser => ({ username, password: `${username}-password`, email, name });

/** Text of an HTML attribute, with the entities Keycloak's pages use decoded. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The login form's action, from the page Keycloak shows at its authorize endpoint. */
export function loginFormAction(html: string): string | undefined {
  const form = /<form\b[^>]*\bid="kc-form-login"[^>]*>/i.exec(html)?.[0];
  const action = form === undefined ? undefined : /\baction="([^"]*)"/i.exec(form)?.[1];
  return action === undefined ? undefined : unescapeHtml(action);
}

/** What the page says went wrong, for an error message. */
function pageMessage(html: string): string {
  const text = /<span[^>]*\bclass="[^"]*(?:kc-feedback-text|pf-v5-c-alert__title|alert)[^"]*"[^>]*>([^<]*)</i.exec(html)?.[1];
  return (text ?? /<title>([^<]*)</i.exec(html)?.[1] ?? html.slice(0, 200)).trim();
}

/** Cookies by name, for one Keycloak host; enough for its login pages. */
class Jar {
  readonly #cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (/;\s*Max-Age=0/i.test(header) || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): Record<string, string> {
    return this.#cookies.size === 0 ? {} : { cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }
}

/**
 * Follows a Keycloak authorize URL as the user would: the login page, then
 * the form posted with their name and password. Returns where Keycloak sends
 * the browser back (the redirect URI with a code, or with an error).
 */
export async function keycloakAuthorize(url: string, who: TestUser): Promise<string> {
  const jar = new Jar();
  const page = await fetch(url, { redirect: "manual" });
  jar.store(page);
  if (page.status === 302 || page.status === 303) {
    // Refused before the login page: back to the redirect URI with an error.
    return page.headers.get("location") ?? "";
  }
  const html = await page.text();
  const action = loginFormAction(html);
  if (page.status !== 200 || action === undefined) {
    throw new Error(`Keycloak showed no login form (${page.status}): ${pageMessage(html)}`);
  }
  const posted = await fetch(new URL(action, url), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...jar.header() },
    body: new URLSearchParams({ username: who.username, password: who.password, credentialId: "" }).toString(),
  });
  const location = posted.headers.get("location");
  if (posted.status !== 302 || location === null || location.startsWith(new URL(url).origin)) {
    throw new Error(`Keycloak didn't log ${who.username} in (${posted.status}): ${pageMessage(await posted.text())}`);
  }
  return location;
}

/** Keycloak at url (http://host:port) as a login harness. */
export async function keycloakHarness(url: string): Promise<LoginHarness> {
  return {
    name: `Keycloak ${KEYCLOAK_VERSION}`,
    issuer: `${url}/realms/cromdb`,
    otherIssuer: `${url}/realms/other`,
    client: { clientId: "cromdb", secret: "s3cret" },
    otherClient: { clientId: "other", secret: "other-s3cret" },
    users: {
      admin: user("admin", "admin@example.com", "Ada Admin"),
      invited: user("ivy", "ivy@example.com", "Ivy Invited"),
      unverified: user("una", "una@example.com", "Una Unverified"),
      uninvited: user("sam", "sam@example.com", "Sam Stranger"),
      secondAccount: user("ivy2", "IVY@example.com", "Ivy Again"),
    },
    authorize: keycloakAuthorize,
    // Keycloak runs for the whole suite; scripts/keycloak.mjs stops it.
    close: async () => undefined,
  };
}
