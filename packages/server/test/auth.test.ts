import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import type { Driver } from "@cromdb/driver";
import { originAllowed, safeReturnTo } from "../src/auth/checks.js";
import { parseCookies, serializeCookie } from "../src/auth/cookies.js";
import { checkIdToken, decodeJwt } from "../src/auth/id-token.js";
import { LOGIN_STATE_SECONDS, LoginStates } from "../src/auth/login-states.js";
import { hashId, randomId, sameText } from "../src/auth/secrets.js";
import { Sessions } from "../src/auth/sessions.js";
import { SERVER_PRINCIPAL } from "../src/directory/directory.js";

describe("cookies", () => {
  it("reads every value of a name, in order, and only own names", () => {
    const cookies = parseCookies('a=1; b="2"; a=3; __proto__=x; =y; bad; constructor=c');
    expect(cookies.get("a")).toEqual(["1", "3"]);
    expect(cookies.get("b")).toEqual(["2"]);
    expect(cookies.get("__proto__")).toEqual(["x"]);
    expect(cookies.get("constructor")).toEqual(["c"]);
    expect(cookies.get("toString")).toBeUndefined();
    expect(parseCookies(undefined).size).toBe(0);
  });

  it("writes HttpOnly, SameSite=Lax, never a Domain, and Secure when asked", () => {
    expect(serializeCookie("s", "abc_-1", { path: "/", maxAge: 60, secure: false })).toBe("s=abc_-1; Path=/; Max-Age=60; HttpOnly; SameSite=Lax");
    expect(serializeCookie("s", "", { path: "/auth", maxAge: 0, secure: true })).toBe("s=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    expect(() => serializeCookie("s", "a;b", { path: "/", maxAge: 1, secure: false })).toThrow();
  });
});

describe("returnTo", () => {
  it("keeps paths on this server and turns everything else into /", () => {
    for (const ok of ["/", "/a", "/a/b?c=d&e=%2F#f", "/%2F%2Fevil.example"]) {
      expect(safeReturnTo(ok), ok).toBe(ok);
    }
    for (const bad of ["//evil.example", "/\\evil.example", "\\\\evil.example", "https://evil.example", "evil.example", "", "/\t/evil.example", "/\n/x", " /", "javascript:x", "/a\\b", 5, undefined, ["/a"], "/".padEnd(2001, "a")]) {
      expect(safeReturnTo(bad), JSON.stringify(bad)).toBe("/");
    }
  });

  it("never gives a path that leaves the server, whatever it is given", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string().map((s) => `/${s}`), fc.webUrl(), fc.string().map((s) => `//${s}`)), (value) => {
        const result = safeReturnTo(value);
        expect(result === "/" || result === value).toBe(true);
        for (const base of ["https://server.example", "http://localhost:8080/sub"]) {
          expect(new URL(result, base).origin).toBe(new URL(base).origin);
        }
      }),
    );
  });
});

describe("the Origin check", () => {
  it("wants the public origin, or same-origin without Origin", () => {
    const expected = "https://db.example";
    expect(originAllowed({ origin: "https://db.example" }, expected)).toBe(true);
    expect(originAllowed({ origin: "https://db.example", secFetchSite: "cross-site" }, expected)).toBe(true);
    expect(originAllowed({ origin: "https://other.db.example" }, expected)).toBe(false);
    expect(originAllowed({ origin: "http://db.example" }, expected)).toBe(false);
    expect(originAllowed({ origin: "null" }, expected)).toBe(false);
    expect(originAllowed({ origin: "null", secFetchSite: "same-origin" }, expected)).toBe(false);
    expect(originAllowed({ secFetchSite: "same-origin" }, expected)).toBe(true);
    expect(originAllowed({ secFetchSite: "same-site" }, expected)).toBe(false);
    expect(originAllowed({}, expected)).toBe(false);
  });
});

describe("the ID token checks", () => {
  const now = 1_800_000_000;
  const expected = { issuer: "https://id.example/realms/r", clientId: "cromdb", nonce: "n0nce", now };
  const header = { alg: "RS256", kid: "k" };
  const claims = {
    iss: expected.issuer,
    aud: "cromdb",
    azp: "cromdb",
    exp: now + 300,
    iat: now,
    nonce: "n0nce",
    sub: "subject-1",
    email: "Ivy@Example.com",
    email_verified: true,
    name: "Ivy",
  };
  const reason = (h: Record<string, unknown>, c: Record<string, unknown>) => {
    const result = checkIdToken(h, c, expected);
    return result.ok ? "ok" : `${result.refusal}: ${result.reason}`;
  };

  it("accepts a good token, and says who logged in", () => {
    expect(checkIdToken(header, claims, expected)).toEqual({ ok: true, identity: { issuer: expected.issuer, subject: "subject-1", email: "Ivy@Example.com", name: "Ivy" } });
    expect(reason({ alg: "ES256" }, claims)).toBe("ok");
  });

  it("accepts only RS256 and ES256", () => {
    for (const alg of ["none", "HS256", "HS512", "PS256", "RS512", "EdDSA", undefined, "rs256"]) {
      expect(reason({ alg }, claims), String(alg)).toMatch(/^invalid: .*signed with/);
    }
  });

  it("checks iss exactly", () => {
    for (const iss of [`${expected.issuer}/`, "https://id.example/realms/other", undefined, ["x"]]) {
      expect(reason(header, { ...claims, iss }), JSON.stringify(iss)).toMatch(/issuer \(iss\)/);
    }
  });

  it("wants this client in aud, and azp to be this client when there are others", () => {
    expect(reason(header, { ...claims, aud: ["cromdb"] })).toBe("ok");
    expect(reason(header, { ...claims, aud: ["cromdb", "account"] })).toBe("ok");
    expect(reason(header, { ...claims, aud: "other" })).toMatch(/audience/);
    expect(reason(header, { ...claims, aud: ["other"] })).toMatch(/audience/);
    expect(reason(header, { ...claims, aud: [7] })).toMatch(/audience/);
    const { azp: _, ...noAzp } = claims;
    expect(reason(header, noAzp)).toBe("ok");
    expect(reason(header, { ...noAzp, aud: ["cromdb", "account"] })).toMatch(/no authorized party/);
    expect(reason(header, { ...claims, azp: "other" })).toMatch(/azp/);
  });

  it("allows 60 seconds of clock difference on exp and iat, no more", () => {
    expect(reason(header, { ...claims, exp: now - 60 })).toBe("ok");
    expect(reason(header, { ...claims, exp: now - 61 })).toMatch(/expired/);
    expect(reason(header, { ...claims, exp: "soon" })).toMatch(/no expiry/);
    expect(reason(header, { ...claims, iat: now + 60 })).toBe("ok");
    expect(reason(header, { ...claims, iat: now + 61 })).toMatch(/future/);
    expect(reason(header, { ...claims, iat: undefined })).toMatch(/no issue time/);
  });

  it("wants this login's nonce, a subject and an email", () => {
    expect(reason(header, { ...claims, nonce: "other" })).toMatch(/nonce/);
    expect(reason(header, { ...claims, nonce: undefined })).toMatch(/nonce/);
    expect(reason(header, { ...claims, sub: "" })).toMatch(/subject/);
    expect(reason(header, { ...claims, sub: 5 })).toMatch(/subject/);
    expect(reason(header, { ...claims, email: " " })).toMatch(/no email/);
    expect(reason(header, { ...claims, email: undefined })).toMatch(/no email/);
  });

  it("wants email_verified to be true itself", () => {
    for (const verified of [false, "true", 1, undefined, null]) {
      expect(reason(header, { ...claims, email_verified: verified }), JSON.stringify(verified)).toMatch(/^unverified: /);
    }
  });

  it("uses a name only when it is usable text", () => {
    const name = (value: unknown) => {
      const result = checkIdToken(header, { ...claims, name: value }, expected);
      return result.ok ? result.identity.name : "refused";
    };
    expect(name("  Ivy  ")).toBe("Ivy");
    expect(name("")).toBeUndefined();
    expect(name("a\u0007b")).toBeUndefined();
    expect(name(5)).toBeUndefined();
    expect(name("x".repeat(300))).toHaveLength(200);
  });

  it("reads a token's own claims only", () => {
    const inherited = Object.create({ iss: expected.issuer }) as Record<string, unknown>;
    expect(reason(header, Object.assign(inherited, { ...claims, iss: undefined }))).toMatch(/issuer/);
  });

  it("decodes a compact JWS, or nothing", () => {
    const token = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from('{"sub":"s"}').toString("base64url")}.sig`;
    expect(decodeJwt(token)).toEqual({ header: { alg: "RS256" }, claims: { sub: "s" } });
    for (const bad of ["", "a.b", "a.b.c.d", "!!.!!.x", `${Buffer.from("[]").toString("base64url")}.e30.x`]) {
      expect(decodeJwt(bad), bad).toBeUndefined();
    }
  });
});

describe("secrets", () => {
  it("makes 32-byte IDs, stores their SHA-256, and compares in constant time", () => {
    const id = randomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomId()).not.toBe(id);
    expect(hashId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abd")).toBe(false);
    expect(sameText("abc", "abcd")).toBe(false);
  });
});

describe("login states", () => {
  const values = { state: "s", nonce: "n", codeVerifier: "v", returnTo: "/r" };
  const at = new Date("2026-11-19T12:00:00Z");

  it("can be taken once, and only before they expire", () => {
    const states = new LoginStates();
    const id = states.add(values, at);
    expect(states.take(id, at)).toMatchObject(values);
    expect(states.take(id, at)).toBeUndefined();
    const late = states.add(values, at);
    expect(states.take(late, new Date(at.getTime() + LOGIN_STATE_SECONDS * 1000))).toBeUndefined();
    expect(states.size).toBe(0);
    expect(states.take("never-given", at)).toBeUndefined();
  });

  it("drop expired ones, and the oldest when full", () => {
    const states = new LoginStates(3);
    const ids = [states.add(values, at), states.add(values, at), states.add(values, at)];
    const fourth = states.add(values, at);
    expect(states.size).toBe(3);
    expect(states.take(ids[0] ?? "", at)).toBeUndefined();
    expect(states.take(fourth, at)).toBeDefined();
    states.add(values, new Date(at.getTime() + LOGIN_STATE_SECONDS * 1000 + 1));
    expect(states.size).toBe(1);
  });
});

describe("sessions", () => {
  let driver: Driver;
  let handle: string;
  let clock: number;
  const logs: string[] = [];
  const limits = { idleMinutes: 60, maxDays: 2 };
  const HOUR = 3_600_000;

  beforeEach(async () => {
    driver = createLevel4Driver();
    ({ handle } = await driver.call("database.create", { storage: { kind: "memory" }, principal: SERVER_PRINCIPAL }));
    clock = Date.parse("2026-11-19T12:00:00Z");
    logs.length = 0;
  });
  afterEach(() => driver.shutdown());

  const load = () => Sessions.load({ driver, handle, limits, now: () => new Date(clock), log: (line) => logs.push(line) });
  const stored = async () =>
    (await driver.call("documents.find", { handle, principal: SERVER_PRINCIPAL, filter: { where: { type: "session" } }, limit: 100 })).documents;

  it("store only the hash of the ID, readable by the server alone", async () => {
    const sessions = await load();
    const id = await sessions.create("person-1");
    const [document] = await stored();
    expect(document?.content).toEqual({ type: "session", idHash: hashId(id), personId: "person-1", createdAt: "2026-11-19T12:00:00.000Z", lastSeenAt: "2026-11-19T12:00:00.000Z" });
    expect(JSON.stringify(document)).not.toContain(id);
    expect(document?.readers).toEqual(["cromdb-server"]);
    expect(document?.writers).toEqual(["cromdb-server"]);
    expect(sessions.use(id)).toEqual({ personId: "person-1", createdAt: new Date(clock) });
    expect(sessions.use(hashId(id))).toBeUndefined();
  });

  it("end after the idle time, and after the absolute time however used", async () => {
    const sessions = await load();
    const idle = await sessions.create("p");
    clock += HOUR - 1;
    expect(sessions.use(idle)).toBeDefined();
    clock += HOUR;
    expect(sessions.use(idle)).toBeUndefined();
    const busy = await sessions.create("p");
    for (let i = 0; i < 47; i++) {
      clock += HOUR - 1000;
      expect(sessions.use(busy), `hour ${i}`).toBeDefined();
    }
    clock += 2 * HOUR;
    expect(sessions.use(busy)).toBeUndefined();
  });

  it("write lastSeenAt only for sessions used since the last write", async () => {
    const sessions = await load();
    const used = await sessions.create("a");
    await sessions.create("b");
    const versions = async () => (await stored()).map((d) => [d.content["personId"], d.version, d.content["lastSeenAt"]]);
    const before = await versions();
    await sessions.flush();
    expect(await versions()).toEqual(before);
    clock += 10 * 60_000;
    for (let i = 0; i < 50; i++) sessions.use(used);
    await sessions.flush();
    const after = await versions();
    expect(after.find((v) => v[0] === "b")).toEqual(before.find((v) => v[0] === "b"));
    expect(after.find((v) => v[0] === "a")?.[2]).toBe("2026-11-19T12:10:00.000Z");
    await sessions.flush();
    expect(await versions()).toEqual(after);
  });

  it("after a crash, end early by at most what wasn't written, never late", async () => {
    const sessions = await load();
    const id = await sessions.create("p");
    clock += 30 * 60_000;
    sessions.use(id);
    await sessions.flush();
    clock += 20 * 60_000;
    sessions.use(id);
    // A crash: the last use is never written. Read the database again.
    const restarted = await load();
    clock += 40 * 60_000 + 1;
    // 60 minutes after the last written use: ended, 20 minutes early.
    expect(restarted.use(id)).toBeUndefined();
  });

  it("are written at shutdown, so a clean restart keeps the last use", async () => {
    const sessions = await load();
    const id = await sessions.create("p");
    clock += 50 * 60_000;
    sessions.use(id);
    await sessions.flush();
    const restarted = await load();
    clock += 59 * 60_000;
    expect(restarted.use(id)).toBeDefined();
  });

  it("are removed when they expire, at load, at logout, and per person", async () => {
    const sessions = await load();
    const a = await sessions.create("a");
    await sessions.create("a");
    const b = await sessions.create("b");
    expect(await sessions.endFor("a")).toBe(2);
    expect(sessions.use(a)).toBeUndefined();
    await sessions.end(b);
    expect(sessions.size).toBe(0);
    await sessions.create("c");
    clock += 2 * HOUR;
    const reloaded = await load();
    expect(reloaded.size).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("skip a damaged session document and say so", async () => {
    await driver.call("documents.create", { handle, principal: SERVER_PRINCIPAL, content: { type: "session", idHash: "nope" }, readers: ["cromdb-server"], writers: ["cromdb-server"] });
    const sessions = await load();
    expect(sessions.size).toBe(0);
    expect(logs.join("\n")).toMatch(/unreadable/);
  });
});
