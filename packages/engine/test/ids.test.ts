import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { derivedId, newId } from "../src/ids.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("newId", () => {
  it("returns distinct UUIDs", () => {
    const first = newId();
    expect(first).toMatch(UUID);
    expect(newId()).not.toBe(first);
  });
});

describe("derivedId", () => {
  it("matches the RFC example", () => {
    expect(derivedId(DNS_NAMESPACE, "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("accepts an upper-case namespace", () => {
    expect(derivedId(DNS_NAMESPACE.toUpperCase(), "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is a deterministic version 5 UUID", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.string({ unit: "binary" }), (namespace, name) => {
        const id = derivedId(namespace, name);
        expect(id).toMatch(UUID_V5);
        expect(derivedId(namespace, name)).toBe(id);
      }),
    );
  });

  it("gives different names different IDs", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.string(), fc.string(), (namespace, a, b) => {
        fc.pre(a !== b);
        expect(derivedId(namespace, a)).not.toBe(derivedId(namespace, b));
      }),
    );
  });

  it.each(["", "not-a-uuid", "6ba7b810-9dad-11d1-80b4-00c04fd430c", "6ba7b8109dad11d180b400c04fd430c8"])(
    "rejects namespace %j",
    (namespace) => {
      expect(() => derivedId(namespace, "x")).toThrow(TypeError);
    },
  );

  it("rejects a non-string namespace", () => {
    expect(() => derivedId(42 as unknown as string, "x")).toThrow(TypeError);
  });
});
