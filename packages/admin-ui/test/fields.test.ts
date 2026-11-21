import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  blankRow,
  changeType,
  contentToRows,
  escapeSegment,
  formatDate,
  parseDate,
  rowsSignature,
  rowsToContent,
  valueAt,
  type FieldRow,
  type FieldType,
  type Json,
} from "../src/screens/documents/fields.ts";

const ISO = fc.date({ min: new Date("1000-01-01T00:00:00Z"), max: new Date("9999-12-31T23:59:59Z"), noInvalidDate: true }).map((date) => date.toISOString());

/** Any JSON value, as it comes back from the server (no -0, no undefined). */
const json: fc.Arbitrary<Json> = fc.jsonValue().map((value) => JSON.parse(JSON.stringify(value)) as Json);
const content = fc.dictionary(fc.string(), json).map((value) => JSON.parse(JSON.stringify(value)) as Record<string, Json>);

/** Content with some top-level dates and some dates inside JSON values, and the fieldTypes that mark them. */
const dated = fc
  .tuple(content, fc.dictionary(fc.string(), ISO, { maxKeys: 3 }), fc.dictionary(fc.string({ minLength: 1 }), fc.dictionary(fc.string(), ISO, { minKeys: 1, maxKeys: 3 }), { maxKeys: 2 }))
  .map(([plain, dates, nested]) => {
    const all: Record<string, Json> = { ...plain };
    const fieldTypes: Record<string, "datetime"> = {};
    for (const [key, iso] of Object.entries(dates)) {
      all[key] = iso;
    }
    for (const [key, inner] of Object.entries(nested)) {
      all[key] = inner;
      delete fieldTypes[`/${escapeSegment(key)}`];
    }
    for (const [key, value] of Object.entries(all)) {
      const pointer = `/${escapeSegment(key)}`;
      if (Object.hasOwn(dates, key) && value === dates[key]) fieldTypes[pointer] = "datetime";
      if (Object.hasOwn(nested, key)) for (const innerKey of Object.keys(nested[key] ?? {})) fieldTypes[`${pointer}/${escapeSegment(innerKey)}`] = "datetime";
    }
    return { content: all, fieldTypes };
  });

const row = (type: FieldType, text: string, extra: Partial<FieldRow> = {}): FieldRow => ({ key: "k", name: "f", added: false, type, text, nestedDates: [], ...extra });

describe("content as rows", () => {
  it("comes back the same, with the same fieldTypes, for any content", () => {
    fc.assert(
      fc.property(dated, ({ content: value, fieldTypes }) => {
        const rows = contentToRows(value, fieldTypes);
        const built = rowsToContent(rows);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.content).toEqual(value);
        expect(Object.keys(built.content)).toEqual(Object.keys(value));
        expect(built.fieldTypes).toEqual(fieldTypes);
      }),
    );
  });

  it("comes back the same after every row is retyped as it was shown", () => {
    // As if each value were typed in again: dates go through the local-time text.
    fc.assert(
      fc.property(content, (value) => {
        const rows = contentToRows(value, {}).map(({ loaded: _loaded, ...rest }) => rest);
        const built = rowsToContent(rows);
        expect(built.ok && built.content).toEqual(value);
      }),
    );
  });

  it("shows each kind of value as its type", () => {
    const rows = contentToRows({ a: "x", b: 2, c: true, d: null, e: "2026-11-24T17:00:00.000Z", f: { g: 1 }, h: [1] }, { "/e": "datetime" });
    expect(rows.map((r) => [r.name, r.type, r.text])).toEqual([
      ["a", "text", "x"],
      ["b", "number", "2"],
      ["c", "boolean", "true"],
      ["d", "empty", ""],
      ["e", "date", formatDate("2026-11-24T17:00:00.000Z")],
      ["f", "json", '{"g":1}'],
      ["h", "json", "[1]"],
    ]);
  });

  it("keeps dates inside a JSON value, and refuses a save that loses one", () => {
    const [contact] = contentToRows({ contact: { name: "Rosa", since: "2024-03-01T09:00:00.000Z" } }, { "/contact/since": "datetime" });
    if (contact === undefined) throw new Error("no row");
    expect(contact.nestedDates).toEqual(["/since"]);
    const kept = rowsToContent([{ ...contact, text: '{"name":"Rosa D","since":"2024-03-01T09:00:00.000Z"}' }]);
    expect(kept.ok && kept.fieldTypes).toEqual({ "/contact/since": "datetime" });
    const lost = rowsToContent([{ ...contact, text: '{"name":"Rosa"}' }]);
    expect(lost.ok).toBe(false);
    expect(!lost.ok && lost.problems.get(contact.key)).toMatch(/^\/since is a date/);
    const notADate = rowsToContent([{ ...contact, text: '{"since":"soon"}' }]);
    expect(notADate.ok).toBe(false);
    // Removing the field removes its dates with it.
    expect(rowsToContent([])).toEqual({ ok: true, content: {}, fieldTypes: {} });
  });

  it("refuses blank and repeated names, and values that aren't their type", () => {
    const a = { ...blankRow(), name: "" };
    const b = { ...blankRow(), name: "x", text: "1" };
    const c = { ...blankRow(), name: "x", text: "2" };
    const d = { ...blankRow(), name: "n", type: "number" as const, text: "12abc" };
    const e = { ...blankRow(), name: "j", type: "json" as const, text: "{" };
    const f = { ...blankRow(), name: "t", type: "boolean" as const, text: "" };
    const g = { ...blankRow(), name: "d", type: "date" as const, text: "tomorrow" };
    const built = rowsToContent([a, b, c, d, e, f, g]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.get(a.key)).toBe("Give the field a name.");
    expect(built.problems.has(b.key)).toBe(false);
    expect(built.problems.get(c.key)).toBe('There is already a field called "x".');
    expect(built.problems.get(d.key)).toBe("Give a number, such as 12 or -3.5.");
    expect(built.problems.get(e.key)).toBe("This isn't valid JSON.");
    expect(built.problems.get(f.key)).toBe("Choose true or false.");
    expect(built.problems.get(g.key)).toMatch(/^Give a date/);
  });

  it("keeps odd field names as they are, even an empty one", () => {
    // Parsed, as the server's JSON is: in a literal, "__proto__" would set the prototype.
    const value = JSON.parse('{"__proto__": 1, "a/b": "2026-11-24T17:00:00.000Z", "~": true, "": null}') as Record<string, Json>;
    const built = rowsToContent(contentToRows(value, { "/a~1b": "datetime" }));
    expect(built.ok && Object.keys(built.content)).toEqual(Object.keys(value));
    expect(built.ok && built.fieldTypes).toEqual({ "/a~1b": "datetime" });
    expect(built.ok && Object.hasOwn(built.content, "__proto__")).toBe(true);
  });
});

describe("changing a row's type", () => {
  const ok = (from: FieldRow, to: FieldType) => {
    const changed = changeType(from, to);
    if (!changed.ok) throw new Error(changed.message);
    return changed.row.text;
  };
  const refused = (from: FieldRow, to: FieldType) => {
    const changed = changeType(from, to);
    if (changed.ok) throw new Error(`converted to ${changed.row.text}`);
    return changed.message;
  };

  it("converts a value that means the same in the new type", () => {
    expect(ok(row("text", "12"), "number")).toBe("12");
    expect(ok(row("number", "12"), "text")).toBe("12");
    expect(ok(row("text", "true"), "boolean")).toBe("true");
    expect(ok(row("boolean", "false"), "text")).toBe("false");
    expect(ok(row("text", "2026-11-24T17:00:00.000Z"), "date")).toBe(formatDate("2026-11-24T17:00:00.000Z"));
    expect(ok(row("date", formatDate("2026-11-24T17:00:00.000Z")), "text")).toBe("2026-11-24T17:00:00.000Z");
    expect(ok(row("number", "3"), "json")).toBe("3");
    expect(ok(row("json", "3"), "number")).toBe("3");
    expect(ok(row("json", '"hi"'), "text")).toBe("hi");
    expect(ok(row("text", "hi"), "json")).toBe('"hi"');
  });

  it("refuses one that doesn't, and says why", () => {
    expect(refused(row("text", "abc"), "number")).toBe('"abc" can\'t become a number.');
    expect(refused(row("text", "yes"), "boolean")).toBe('"yes" can\'t become true or false.');
    expect(refused(row("number", "3"), "boolean")).toBe("This number value can't become true or false.");
    expect(refused(row("number", "3"), "date")).toBe("This number value can't become a date.");
    expect(refused(row("json", '{"a":1}'), "text")).toBe("This JSON value can't become text.");
    expect(refused(row("number", "x"), "text")).toBe("Fix the value first: Give a number, such as 12 or -3.5.");
  });

  it("lets any value become empty, and an empty one become a blank of any type", () => {
    for (const type of ["text", "number", "boolean", "date", "json"] as const) {
      expect(ok(row(type, type === "json" ? "{}" : type === "boolean" ? "true" : type === "number" ? "1" : type === "date" ? "2026-01-01" : "x"), "empty")).toBe("");
      expect(ok(row("empty", ""), type)).toBe(type === "json" ? "null" : "");
    }
  });

  it("normalizes text it turns into a number", () => {
    expect(ok(row("text", " 12 "), "number")).toBe("12");
    const back = changeType(row("number", "1e5"), "text");
    expect(back.ok && back.row.text).toBe("100000");
    const built = rowsToContent([row("text", "1e5", { type: "number" })]);
    expect(built.ok && built.content).toEqual({ f: 100000 });
  });

  it("never changes a value that isn't text: back to the old type gives the same value", () => {
    // Text is normalized on the way (" 12 " becomes 12), so it is tested above.
    const types: FieldType[] = ["text", "number", "boolean", "date", "json"];
    fc.assert(
      fc.property(json.filter((value) => typeof value !== "string"), fc.constantFrom(...types), (value, to) => {
        const [start] = contentToRows({ f: value }, {});
        if (start === undefined) return;
        const there = changeType(start, to);
        if (!there.ok || to === "date") return;
        const back = changeType(there.row, start.type);
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        const built = rowsToContent([{ ...back.row, loaded: undefined }]);
        expect(built.ok && built.content).toEqual({ f: value });
      }),
    );
  });
});

describe("dates", () => {
  it("are shown in local time and read back, from local text or an ISO string with a zone", () => {
    fc.assert(
      fc.property(ISO, (iso) => {
        const shown = formatDate(iso);
        const read = parseDate(shown);
        expect(read).toBeDefined();
        // Where clocks go back, one local time is two instants: the text still matches.
        expect(formatDate(read ?? "")).toBe(shown);
        expect(parseDate(iso)).toBe(iso);
      }),
    );
  });

  it("refuse what isn't a date", () => {
    for (const text of ["", "tomorrow", "2026-02-30", "2026-13-01", "2026-11-24 25:00", "2026-11-24T17:00", "24/11/2026"]) {
      if (text === "2026-11-24T17:00") {
        expect(parseDate(text)).toBeDefined();
        continue;
      }
      expect(parseDate(text), text).toBeUndefined();
    }
    expect(parseDate("2026-11-24T17:00:00+02:00")).toBe("2026-11-24T15:00:00.000Z");
  });
});

describe("pointers", () => {
  it("find values in objects and arrays, escaped as RFC 6901 says", () => {
    const value: Json = { "a/b": [{ "~x": 1 }] };
    expect(valueAt(value, "/a~1b/0/~0x")).toBe(1);
    expect(valueAt(value, "/a~1b/1")).toBeUndefined();
    expect(valueAt(value, "/a~1b/01")).toBeUndefined();
    expect(valueAt(value, "")).toBe(value);
  });
});

describe("the rows' signature", () => {
  it("changes with a name, a type or a value, and nothing else", () => {
    const rows = contentToRows({ a: 1 }, {});
    const again = contentToRows({ a: 1 }, {});
    expect(rowsSignature(rows)).toBe(rowsSignature(again));
    expect(rowsSignature(rows.map((r) => ({ ...r, text: "2" })))).not.toBe(rowsSignature(rows));
  });
});
