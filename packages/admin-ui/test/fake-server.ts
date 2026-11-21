// A fetch for component tests: answers by "METHOD /path" from a table, and
// records every request.

import { vi } from "vitest";

export interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export function fakeFetch(routes: Record<string, Answer | ((sent: Sent) => Answer)>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const request: Sent = { method, url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    sent.push(request);
    const path = url.split("?")[0] ?? url;
    const key = `${method} ${path}`;
    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    const answer = route === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: `No route for ${key}` } } } : typeof route === "function" ? route(request) : route;
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return new Response(text === "" ? null : text, { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  });
  return { fetch, sent };
}

export const unauthenticated: Answer = { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Log in first" } } };
