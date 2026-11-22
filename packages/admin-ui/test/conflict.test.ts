import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Schemas } from "../src/api/schema.ts";
import { canonical, conflictFields, conflictRows, orderVersions, sameNames } from "../src/screens/documents/conflict.ts";

type Version = Schemas["ConflictVersion"];

function version(id: string, content: Record<string, unknown>, extra: Partial<Version> & { fieldTypes?: Record<string, "datetime"> } = {}): Version {
  const { fieldTypes = {}, ...rest } = extra;
  return {
    document: {
      id,
      parentId: "d",
      version: `${id}-v`,
      deleted: rest.deleted ?? false,
      content,
      fieldTypes,
      readers: ["*"],
      writers: ["*"],
      createdAt: "2026-11-20T10:00:00.000Z",
      createdBy: "p-ada",
      updatedAt: "2026-11-21T10:00:00.000Z",
      updatedBy: "p-ada",
      updatedOn: `i-${id}`,
      inConflict: true,
      access: { read: true, update: true, delete: true },
    },
    isPrimary: false,
    authorized: true,
    deleted: false,
    ...rest,
  };
}

describe("a conflict as a table", () => {
  it("lists every field, the primary's first, and marks the rows that differ", () => {
    const versions = [
      version("b", { title: "Quote", status: "open", note: "oak" }),
      version("a", { title: "Quote", status: "quoted", sent: true }, { isPrimary: true }),
    ];
    expect(conflictFields(versions)).toEqual(["title", "status", "sent", "note"]);
    const rows = conflictRows(orderVersions(versions));
    expect(rows.map((row) => [row.field, row.differs, row.cells.map((cell) => cell.text)])).toEqual([
      ["title", false, ["Quote", "Quote"]],
      ["status", true, ["quoted", "open"]],
      ["sent", true, ["true", "(no field)"]],
      ["note", true, ["(no field)", "oak"]],
    ]);
  });

  it("compares values as JSON whatever the key order, and a date apart from the same text", () => {
    const rows = conflictRows([
      version("a", { j: { x: 1, y: [1, 2] }, due: "2026-11-24T17:00:00.000Z" }, { fieldTypes: { "/due": "datetime" } }),
      version("b", { j: { y: [1, 2], x: 1 }, due: "2026-11-24T17:00:00.000Z" }),
    ]);
    expect(rows.map((row) => [row.field, row.differs])).toEqual([
      ["j", false],
      ["due", true],
    ]);
    expect(rows[0]?.cells[0]).toEqual({ text: '{"x":1,"y":[1,2]}', json: true });
  });

  it("counts a date inside a JSON value toward whether it differs", () => {
    const rows = conflictRows([
      version("a", { c: { since: "2024-03-01T09:00:00.000Z" } }, { fieldTypes: { "/c/since": "datetime" } }),
      version("b", { c: { since: "2024-03-01T09:00:00.000Z" } }),
    ]);
    expect(rows[0]?.differs).toBe(true);
  });

  it("leaves a version that deletes the document out of the field comparison", () => {
    const rows = conflictRows([version("a", { title: "T", step: 2 }, { isPrimary: true }), version("b", { title: "T", step: 2 }), version("c", {}, { deleted: true })]);
    expect(rows.map((row) => [row.field, row.differs, row.cells.map((cell) => cell.text)])).toEqual([
      ["title", false, ["T", "T", ""]],
      ["step", false, ["2", "2", ""]],
    ]);
  });

  it("marks a row as differing exactly when two kept versions hold different values", () => {
    const value = fc.oneof(fc.constant(undefined), fc.jsonValue());
    fc.assert(
      fc.property(fc.array(value, { minLength: 2, maxLength: 4 }), (values) => {
        const normal = values.map((v) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown)));
        const versions = normal.map((v, i) => version(`v${i}`, v === undefined ? {} : { f: v }));
        const rows = conflictRows(versions);
        if (normal.every((v) => v === undefined)) {
          expect(rows).toEqual([]);
          return;
        }
        const distinct = new Set(normal.map((v) => (v === undefined ? "absent" : canonical(v))));
        expect(rows[0]?.differs).toBe(distinct.size > 1);
      }),
    );
  });

  it("puts the primary first and keeps the others in the order given", () => {
    const ordered = orderVersions([version("b", {}), version("c", {}), version("a", {}, { isPrimary: true })]);
    expect(ordered.map((v) => v.document.id)).toEqual(["a", "b", "c"]);
  });

  it("compares readers and writers in any order", () => {
    expect(sameNames(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameNames(["a"], ["a", "b"])).toBe(false);
  });
});
