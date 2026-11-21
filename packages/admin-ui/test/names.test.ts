import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { NameBook, shortId } from "../src/api/names.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("names", () => {
  it("asks for every wanted ID at once, in batches of 100, and once only", async () => {
    const lookup = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, `Name of ${id}`] as const)));
    const book = new NameBook(lookup);
    const ids = Array.from({ length: 150 }, (_, i) => `person-${i}`);
    book.want(ids.slice(0, 80));
    book.want(ids.slice(60));
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]?.[0]).toHaveLength(100);
    expect(lookup.mock.calls[1]?.[0]).toHaveLength(50);
    book.want(ids);
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(book.label("person-7", undefined)).toEqual({ text: "Name of person-7", title: "person-7" });
  });

  it("shows you, the server, everyone, and IDs it can't name", async () => {
    const book = new NameBook(async () => new Map([["p-1", null]]));
    book.want(["p-1", "4b2c8f3e-9a1d-4e7b-8c6f-123456789abc", "cromdb-server", "*"]);
    await settle();
    expect(book.label("me", "me")).toEqual({ text: "you" });
    expect(book.label("cromdb-server", "me")).toEqual({ text: "The server", title: "cromdb-server" });
    expect(book.label("*", "me")).toEqual({ text: "Everyone who logs in", title: "*" });
    expect(book.label("p-1", "me")).toEqual({ text: "p-1", title: "p-1" });
    expect(book.label("4b2c8f3e-9a1d-4e7b-8c6f-123456789abc", "me")).toEqual({ text: "4b2c8f3e…", title: "4b2c8f3e-9a1d-4e7b-8c6f-123456789abc" });
  });

  it("asks again after a failed lookup", async () => {
    let fail = true;
    const lookup = vi.fn(async (ids: readonly string[]) => {
      if (fail) throw new Error("offline");
      return new Map(ids.map((id) => [id, "Ada"] as const));
    });
    const book = new NameBook(lookup);
    book.want(["a"]);
    await settle();
    expect(book.label("a", undefined).text).toBe("a");
    fail = false;
    book.want(["a"]);
    await settle();
    expect(book.label("a", undefined).text).toBe("Ada");
  });

  it("treats IDs like __proto__ as plain IDs", async () => {
    const book = new NameBook(async () => new Map([["__proto__", "Odd"], ["constructor", null]]));
    book.want(["__proto__", "constructor", "toString"]);
    await settle();
    expect(book.label("__proto__", undefined).text).toBe("Odd");
    expect(book.label("constructor", undefined).text).toBe("construc…");
    expect(book.label("toString", undefined).text).toBe("toString");
  });

  it("never shows an empty label, and shortens only long IDs", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        const text = new NameBook(async () => new Map()).label(id, undefined).text;
        expect(text.length).toBeGreaterThan(0);
        expect(shortId(id)).toBe(id.length <= 10 ? id : `${id.slice(0, 8)}…`);
      }),
    );
  });
});
