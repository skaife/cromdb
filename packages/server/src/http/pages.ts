// The bare pages the server makes itself: the login refusals, and the page
// shown when the admin UI isn't built. No script, no style.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export type LoginOutcome = "invalid" | "unverified" | "not-invited" | "disabled" | "ambiguous" | "unavailable";

const MESSAGES: Readonly<Record<LoginOutcome, string>> = {
  invalid: "The login expired or was not valid. Please try again.",
  unverified: "Your email address is not verified with the login service, so you can't log in here yet.",
  "not-invited": "You have not been invited to this server. Ask a server admin for an invitation.",
  disabled: "Your account on this server is disabled.",
  ambiguous: "There is more than one invitation for your email address. Ask a server admin to revoke all but one.",
  unavailable: "The login service can't be reached right now. Please try again later.",
};

export const OUTCOME_STATUS: Readonly<Record<LoginOutcome, number>> = {
  invalid: 400,
  unverified: 403,
  "not-invited": 403,
  disabled: 403,
  ambiguous: 403,
  unavailable: 502,
};

/** One sentence for a login that didn't end in a session. Details are in the server log only. */
export function loginRefusedPage(serverName: string, outcome: LoginOutcome): string {
  const again = outcome === "invalid" || outcome === "unavailable" ? '\n<p><a href="/auth/login?returnTo=%2F">Log in</a></p>' : '\n<p><a href="/">Home</a></p>';
  return page(`${serverName}: not logged in`, `<p>${escapeHtml(MESSAGES[outcome])}</p>${again}`);
}
