import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { api, ApiError, fillPath, onSessionEnded } from "../src/api/client.ts";
import { fakeFetch, unauthenticated } from "./fake-server.ts";

describe("the API client", () => {
  it("fills path parameters, each encoded, and sends the query", async () => {
    const { fetch, sent } = fakeFetch({ "GET /api/v0/people/cards": { body: { people: [] } } });
    await api("getPersonCards", { query: { ids: "a,b" } }, fetch);
    expect(sent[0]?.url).toBe("/api/v0/people/cards?ids=a%2Cb");
    expect(fillPath("/api/v0/databases/{databaseId}/documents/{documentId}", { databaseId: "a/b", documentId: "?x" })).toBe("/api/v0/databases/a%2Fb/documents/%3Fx");
    expect(() => fillPath("/api/v0/people/{personId}", {})).toThrow("No value for {personId}");
  });

  it("round-trips any path parameter through the URL", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const path = fillPath("/api/v0/people/{personId}", { personId: value });
        expect(path.slice("/api/v0/people/".length)).not.toContain("/");
        expect(decodeURIComponent(path.slice("/api/v0/people/".length))).toBe(value);
      }),
    );
  });

  it("sends JSON bodies and If-Match in quotes, and returns the ETag's version", async () => {
    const { fetch, sent } = fakeFetch({
      "PUT /api/v0/databases/d1/acl": { body: { admins: [] }, headers: { etag: '"v2"' } },
    });
    const lists = { admins: [], creators: [], writers: [], readers: [], noAccess: [] };
    const result = await api("saveAcl", { params: { databaseId: "d1" }, body: lists, ifMatch: "v1" }, fetch);
    expect(sent[0]).toMatchObject({ method: "PUT", headers: { "content-type": "application/json", "if-match": '"v1"', accept: "application/json" }, body: lists });
    expect(result.version).toBe("v2");
    expect(result.data).toEqual({ admins: [] });
  });

  it("throws the server's code, message and details", async () => {
    const { fetch } = fakeFetch({
      "POST /api/v0/databases": { status: 400, body: { error: { code: "INVALID_INPUT", message: "name must not be blank", details: { path: "/name" } } } },
    });
    const error = await api("createDatabase", { body: { name: " " } }, fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "INVALID_INPUT", message: "name must not be blank", details: { path: "/name" } });
  });

  it("makes sense of an answer that isn't the API's error shape", async () => {
    const fetch = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(api("me", {}, fetch)).rejects.toMatchObject({ status: 502, code: "INTERNAL" });
    const nowhere = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(api("me", {}, nowhere)).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("tells the session listener about a 401, and only then", async () => {
    const ended = vi.fn();
    onSessionEnded(ended);
    try {
      const { fetch } = fakeFetch({ "GET /api/v0/me": unauthenticated, "GET /api/v0/databases": { status: 403, body: { error: { code: "ACCESS_DENIED", message: "no" } } } });
      await expect(api("listDatabases", {}, fetch)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(ended).not.toHaveBeenCalled();
      await expect(api("me", {}, fetch)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(ended).toHaveBeenCalledTimes(1);
    } finally {
      onSessionEnded(undefined);
    }
  });
});
