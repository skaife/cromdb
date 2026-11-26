// The update check: which tags count and which wins, GitHub's reply read,
// the request made (to a local server standing in for api.github.com: no
// test contacts GitHub), and the timer: a minute after it is turned on, then
// daily, a failure logged once and not retried until the next day.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changesUrl, githubSource, newestAbove, parseVersion, tagsOfRefs, UPDATE_CHECK_EVERY_MS, UPDATE_FIRST_CHECK_MS, UpdateCheck, type UpdateSource } from "../src/update-check.js";

describe("versions", () => {
  it("are X.Y.Z as numbers, and nothing else", () => {
    expect(parseVersion("0.4.0")).toEqual([0, 4, 0]);
    expect(parseVersion("10.20.300")).toEqual([10, 20, 300]);
    for (const bad of ["v0.4.0", "0.4", "0.4.0.1", "0.4.0-rc1", "0.04.0", " 0.4.0", "", "a.b.c"]) expect(parseVersion(bad), bad).toBeUndefined();
  });

  it("compare as numbers, so 0.10.0 is above 0.9.0, and only server-v tags count", () => {
    expect(newestAbove(["server-v0.9.0", "server-v0.10.0", "server-v0.4.0"], "0.4.0")).toBe("0.10.0");
    expect(newestAbove(["server-v0.4.0", "server-v0.3.9"], "0.4.0")).toBeUndefined();
    expect(newestAbove(["v9.0.0", "server-v9.0.0-rc1", "server-vnext", "cromdb-9.0.0", "server-v0.4.1"], "0.4.0")).toBe("0.4.1");
    expect(newestAbove([], "0.4.0")).toBeUndefined();
  });

  it("pick the highest tag above the running one, whatever the order", () => {
    const version = fc.tuple(fc.nat(30), fc.nat(30), fc.nat(30));
    fc.assert(
      fc.property(fc.array(version, { maxLength: 12 }), version, (tags, running) => {
        const text = (v: readonly number[]) => v.join(".");
        const order = (a: readonly number[], b: readonly number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
        const above = tags.filter((tag) => order(tag, running) > 0).sort(order);
        const expected = above.length === 0 ? undefined : text(above[above.length - 1] ?? []);
        expect(newestAbove(tags.map((tag) => `server-v${text(tag)}`), text(running))).toBe(expected);
      }),
    );
  });
});

describe("GitHub's reply", () => {
  it("gives the tag names of the refs", () => {
    expect(tagsOfRefs([{ ref: "refs/tags/server-v0.3.0", object: { sha: "x" } }, { ref: "refs/tags/server-v0.4.0" }, { ref: "refs/heads/main" }, { nope: 1 }, null])).toEqual(["server-v0.3.0", "server-v0.4.0"]);
    expect(() => tagsOfRefs({ message: "Not Found" })).toThrow(/not a list/);
  });

  it("links a version's changes at its tag", () => {
    expect(changesUrl("0.5.0")).toBe("https://github.com/skaife/cromdb/blob/server-v0.5.0/packages/server/CHANGELOG.md");
  });
});

describe("the request to GitHub", () => {
  async function standIn(reply: (path: string) => { status: number; body: string }) {
    const seen: { path: string; method: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((request, response) => {
      seen.push({ path: request.url ?? "", method: request.method ?? "", headers: request.headers });
      const answer = reply(request.url ?? "");
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("is one plain GET of the server-v refs, saying only that it is cromdb-server", async () => {
    const api = await standIn(() => ({ status: 200, body: JSON.stringify([{ ref: "refs/tags/server-v0.3.0" }, { ref: "refs/tags/server-v0.4.0" }]) }));
    try {
      expect(await githubSource(api.base)()).toEqual(["server-v0.3.0", "server-v0.4.0"]);
      expect(api.seen).toHaveLength(1);
      const [request] = api.seen;
      expect(request?.method).toBe("GET");
      expect(request?.path).toBe("/repos/skaife/cromdb/git/matching-refs/tags/server-v");
      expect(request?.headers["user-agent"]).toBe("cromdb-server");
      expect(request?.headers["accept"]).toBe("application/vnd.github+json");
      expect(request?.headers["authorization"]).toBeUndefined();
      expect(request?.headers["cookie"]).toBeUndefined();
    } finally {
      await api.close();
    }
  });

  it("fails on any answer but 200, and on a reply that isn't refs", async () => {
    const api = await standIn((path) => (path.includes("matching-refs") ? { status: 403, body: '{"message":"API rate limit exceeded"}' } : { status: 404, body: "{}" }));
    try {
      await expect(githubSource(api.base)()).rejects.toThrow("GitHub answered 403");
    } finally {
      await api.close();
    }
    const odd = await standIn(() => ({ status: 200, body: '{"message":"Not Found"}' }));
    try {
      await expect(githubSource(odd.base)()).rejects.toThrow(/not a list/);
    } finally {
      await odd.close();
    }
  });
});

describe("the timer", () => {
  afterEach(() => vi.useRealTimers());

  function check(source: UpdateSource, enabled = true) {
    const logs: string[] = [];
    const calls = { count: 0 };
    const updates = new UpdateCheck({
      running: "0.4.0",
      enabled,
      source: () => {
        calls.count += 1;
        return source();
      },
      now: () => new Date(),
      log: (line) => logs.push(line),
    });
    return { updates, logs, calls };
  }

  it("is off unless turned on, and then never asks", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T10:00:00.000Z") });
    const { updates, calls } = check(async () => ["server-v0.5.0"], false);
    expect(updates.status).toEqual({ state: "off", checkedAt: null, latest: null, changesUrl: null });
    await vi.advanceTimersByTimeAsync(3 * UPDATE_CHECK_EVERY_MS);
    expect(calls.count).toBe(0);
    updates.close();
  });

  it("checks a minute after it is turned on, then every day", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T10:00:00.000Z") });
    let tags = ["server-v0.4.0"];
    const { updates, logs, calls } = check(async () => tags);
    expect(updates.status.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS - 1);
    expect(calls.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(1);
    expect(updates.status).toEqual({ state: "current", checkedAt: "2026-12-01T10:01:00.000Z", latest: null, changesUrl: null });
    tags = ["server-v0.4.0", "server-v0.5.0"];
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS);
    expect(calls.count).toBe(2);
    expect(updates.status).toEqual({ state: "available", checkedAt: "2026-12-02T10:01:00.000Z", latest: "0.5.0", changesUrl: changesUrl("0.5.0") });
    expect(logs).toEqual([`CromDB Server 0.5.0 is available (this server runs 0.4.0): ${changesUrl("0.5.0")}`]);
    // The same news isn't logged every day.
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS);
    expect(calls.count).toBe(3);
    expect(logs).toHaveLength(1);
    updates.close();
  });

  it("logs a failure once and tries again only the next day", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T10:00:00.000Z") });
    let fail = true;
    const { updates, logs, calls } = check(async () => {
      if (fail) throw new TypeError("fetch failed");
      return ["server-v0.4.0"];
    });
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
    expect(updates.status).toEqual({ state: "failed", checkedAt: "2026-12-01T10:01:00.000Z", latest: null, changesUrl: null });
    expect(logs).toEqual(["The update check could not reach GitHub: fetch failed. It tries again in a day."]);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_EVERY_MS - 1);
    expect(calls.count).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.count).toBe(2);
    expect(updates.status.state).toBe("current");
    expect(logs).toHaveLength(1);
    updates.close();
  });

  it("turned off, forgets what it found and stops; turned on again, waits a minute again", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T10:00:00.000Z") });
    const { updates, calls } = check(async () => ["server-v0.5.0"]);
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
    expect(updates.status.state).toBe("available");
    updates.setEnabled(false);
    expect(updates.status.state).toBe("off");
    await vi.advanceTimersByTimeAsync(2 * UPDATE_CHECK_EVERY_MS);
    expect(calls.count).toBe(1);
    updates.setEnabled(true);
    expect(updates.status.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
    expect(calls.count).toBe(2);
    expect(updates.status.state).toBe("available");
    updates.close();
  });

  it("drops a check that was still running when it was turned off", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T10:00:00.000Z") });
    let answer: (tags: string[]) => void = () => undefined;
    const { updates } = check(() => new Promise((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
    updates.setEnabled(false);
    answer(["server-v0.5.0"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.status.state).toBe("off");
    updates.close();
  });
});
