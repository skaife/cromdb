// Where "Log in" goes: the server's login, back to this page afterwards.

export function loginHref(location: { pathname: string; search: string }): string {
  return `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}
