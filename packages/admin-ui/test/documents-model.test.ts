import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../src/api/schema.ts";
import { cellOf, loadColumns, saveColumns, titleOf } from "../src/screens/documents/columns.ts";
import { describeFilter, filterFromSearch, filterToSearch, NO_FILTER, toFindFilter, type Filter } from "../src/screens/documents/filter.ts";
import { clampWidth, PANEL_DEFAULT, PANEL_MIN, panelMax, storedWidth, widthAfterKey } from "../src/components/SidePanel.tsx";

const doc = (content: Record<string, unknown>, fieldTypes: Record<string, "datetime"> = {}): Schemas["Document"] => ({
  id: "0f8a2c1e-aaaa-bbbb-cccc-1234567890ab",
  parentId: "0f8a2c1e-aaaa-bbbb-cccc-1234567890ab",
  version: "v1",
  deleted: false,
  content,
  fieldTypes,
  readers: ["*"],
  writers: ["*"],
  createdAt: "2026-11-21T10:00:00.000Z",
  createdBy: "p-ada",
  updatedAt: "2026-11-21T10:00:00.000Z",
  updatedBy: "p-ada",
  updatedOn: "i-1",
  inConflict: false,
  access: { read: true, update: true, delete: true },
});

describe("the filter", () => {
  const condition = fc.record({
    field: fc.string(),
    type: fc.constantFrom("text" as const, "number" as const, "boolean" as const, "empty" as const, "date" as const),
    value: fc.string(),
  });
  const filters: fc.Arbitrary<Filter> = fc.record({
    conditions: fc.array(condition, { maxLength: 4 }).map((list) => list.map((c) => (c.type === "empty" ? { ...c, value: "" } : c))),
    inConflict: fc.boolean(),
    topLevel: fc.boolean(),
    orphaned: fc.boolean(),
    parentId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  });

  it("survives the address: what goes in comes back", () => {
    fc.assert(
      fc.property(filters, (filter) => {
        const search = new URLSearchParams(filterToSearch(filter).toString());
        expect(filterFromSearch(search)).toEqual(filter);
      }),
    );
  });

  it("becomes find's filter with typed values", () => {
    const checked = toFindFilter({
      conditions: [
        { field: "status", type: "text", value: "open" },
        { field: "priority", type: "number", value: "2" },
        { field: "urgent", type: "boolean", value: "true" },
        { field: "assignee", type: "empty", value: "" },
        { field: "due", type: "date", value: "2026-11-24T17:00:00Z" },
      ],
      inConflict: true,
      topLevel: false,
      orphaned: true,
      parentId: "p",
    });
    expect(checked).toEqual({
      ok: true,
      filter: {
        where: { status: "open", priority: 2, urgent: true, assignee: null, due: "2026-11-24T17:00:00.000Z" },
        whereTypes: { due: "datetime" },
        inConflict: true,
        orphaned: true,
        parentId: "p",
      },
    });
    expect(toFindFilter(NO_FILTER)).toEqual({ ok: true, filter: undefined });
  });

  it("says what is wrong with a condition", () => {
    const checked = toFindFilter({
      ...NO_FILTER,
      conditions: [
        { field: "", type: "text", value: "x" },
        { field: "n", type: "number", value: "many" },
        { field: "n", type: "number", value: "2" },
        { field: "b", type: "boolean", value: "yes" },
        { field: "d", type: "date", value: "soon" },
      ],
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect([...checked.problems]).toEqual([
      [0, "Name the field."],
      [1, "Give a number."],
      [3, "Choose true or false."],
      [4, "Give a date as YYYY-MM-DD HH:MM."],
    ]);
    const twice = toFindFilter({ ...NO_FILTER, conditions: [{ field: "n", type: "text", value: "a" }, { field: "n", type: "text", value: "b" }] });
    expect(!twice.ok && twice.problems.get(1)).toBe("n is in the filter already.");
  });

  it("reads as a line of phrases", () => {
    expect(describeFilter({ ...NO_FILTER, conditions: [{ field: "status", type: "text", value: "open" }, { field: "a", type: "empty", value: "" }], inConflict: true, orphaned: true })).toEqual([
      'status = "open"',
      "a is empty",
      "in conflict",
      "orphans",
    ]);
  });
});

describe("columns", () => {
  afterEach(() => window.localStorage.clear());

  it("are kept per database, in the browser", () => {
    saveColumns("d-1", ["status", "priority"]);
    expect(loadColumns("d-1")).toEqual(["status", "priority"]);
    expect(loadColumns("d-2")).toEqual([]);
    saveColumns("d-1", []);
    expect(window.localStorage.getItem("cromdb.columns.d-1")).toBeNull();
  });

  it("survive bad stored data and blocked storage", () => {
    window.localStorage.setItem("cromdb.columns.d-1", "{not json");
    expect(loadColumns("d-1")).toEqual([]);
    window.localStorage.setItem("cromdb.columns.d-1", JSON.stringify(["a", 3, "", "a", "b"]));
    expect(loadColumns("d-1")).toEqual(["a", "b"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadColumns("d-1")).toEqual([]);
    expect(() => saveColumns("d-1", ["x"])).not.toThrow();
  });

  it("show each kind of value", () => {
    const d = doc({ s: "open", n: 2, b: false, e: null, due: "2026-11-24T17:00:00.000Z", j: { long: "x".repeat(100) } }, { "/due": "datetime" });
    expect(cellOf(d, "s")).toEqual({ text: "open" });
    expect(cellOf(d, "n")).toEqual({ text: "2" });
    expect(cellOf(d, "b")).toEqual({ text: "false" });
    expect(cellOf(d, "e")).toEqual({ text: "empty", muted: true });
    expect(cellOf(d, "missing")).toEqual({ text: "", muted: true });
    expect(cellOf(d, "due").text).toMatch(/^2026-11-2[45] /);
    expect(cellOf(d, "j").text).toHaveLength(61);
  });
});

describe("a document's title", () => {
  it("is the title field, else the first text field that isn't a date, else none", () => {
    expect(titleOf(doc({ a: "first", title: "The title" }))).toBe("The title");
    expect(titleOf(doc({ title: 3, due: "2026-11-24T17:00:00.000Z", name: "Named" }, { "/due": "datetime" }))).toBe("Named");
    expect(titleOf(doc({ title: "  ", n: 1 }))).toBeUndefined();
  });
});

describe("the side panel's width", () => {
  afterEach(() => window.localStorage.clear());

  it("stays between 320 pixels and 70% of the window", () => {
    expect(panelMax(1280)).toBe(896);
    expect(panelMax(300)).toBe(PANEL_MIN);
    fc.assert(
      fc.property(fc.integer({ min: -2000, max: 5000 }), fc.integer({ min: 200, max: 4000 }), (wanted, window) => {
        const width = clampWidth(wanted, window);
        expect(width).toBeGreaterThanOrEqual(PANEL_MIN);
        expect(width).toBeLessThanOrEqual(panelMax(window));
      }),
    );
  });

  it("moves with the arrow keys, Home and End; left widens it", () => {
    expect(widthAfterKey("ArrowLeft", false, 460, 1280)).toBe(476);
    expect(widthAfterKey("ArrowRight", true, 460, 1280)).toBe(396);
    expect(widthAfterKey("Home", false, 460, 1280)).toBe(PANEL_MIN);
    expect(widthAfterKey("End", false, 460, 1280)).toBe(896);
    expect(widthAfterKey("ArrowRight", false, PANEL_MIN, 1280)).toBe(PANEL_MIN);
    expect(widthAfterKey("Enter", false, 460, 1280)).toBeUndefined();
  });

  it("is remembered, and the default when nothing good is", () => {
    expect(storedWidth("w")).toBe(PANEL_DEFAULT);
    window.localStorage.setItem("cromdb.w", "600");
    expect(storedWidth("w")).toBe(600);
    window.localStorage.setItem("cromdb.w", "wide");
    expect(storedWidth("w")).toBe(PANEL_DEFAULT);
  });
});
