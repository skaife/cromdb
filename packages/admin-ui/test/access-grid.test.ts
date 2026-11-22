import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { editable, effective, gridLists, gridRows, LISTS, newRow, rowNote, rowWarns, sameLists, saveProblem, setBox, type Lists } from "../src/screens/access/grid.ts";

const SERVER = "cromdb-server";
const ME = "p-ada";

function lists(change: Partial<Lists> = {}): Lists {
  return { admins: [ME, SERVER], creators: [ME], writers: [ME], readers: [ME], noAccess: [], ...change };
}

describe("the access grid", () => {
  it("has a row per name, the server first, then everyone, then you, then the others as they first appear", () => {
    const rows = gridRows(lists({ readers: [ME, "p-bob", "*"], writers: [ME, "p-carol"], noAccess: ["p-dana"] }), ME);
    expect(rows.map((row) => row.id)).toEqual([SERVER, "*", ME, "p-carol", "p-bob", "p-dana"]);
    expect(rows[0]?.in).toEqual({ admins: true, creators: false, writers: false, readers: false, noAccess: false });
  });

  it("gives back the lists it was made from, each in any order", () => {
    const name = fc.constantFrom(ME, SERVER, "*", "p-bob", "p-carol", "p-dana");
    const list = fc.uniqueArray(name);
    fc.assert(
      fc.property(fc.record({ admins: list, creators: list, writers: list, readers: list, noAccess: list }), (given) => {
        expect(sameLists(gridLists(gridRows(given, ME)), given)).toBe(true);
      }),
    );
  });

  it("keeps each list in its own order when saved unchanged", () => {
    const name = fc.constantFrom(ME, SERVER, "*", "p-bob", "p-carol", "p-dana");
    const list = fc.uniqueArray(name);
    fc.assert(
      fc.property(fc.record({ admins: list, creators: list, writers: list, readers: list, noAccess: list }), (given) => {
        expect(gridLists(gridRows(given, ME), given)).toEqual(given);
      }),
    );
  });

  it("drops a row with no box ticked, and adds people as readers", () => {
    let rows = gridRows(lists({ readers: [ME, "p-bob"] }), ME);
    rows = setBox(rows, "p-bob", "readers", false);
    expect(gridLists(rows).readers).toEqual([ME]);
    expect(rowNote(rows, "p-bob", ME)).toBe("Removed when you save");
    rows = [...rows, newRow("p-carol")];
    expect(gridLists(rows).readers).toEqual([ME, "p-carol"]);
  });

  it("locks the server's row, and never makes everyone an admin or locked out", () => {
    for (const list of LISTS) expect(editable(SERVER, list)).toBe(false);
    expect(editable("*", "admins")).toBe(false);
    expect(editable("*", "noAccess")).toBe(false);
    expect(editable("*", "readers")).toBe(true);
    const rows = setBox(gridRows(lists(), ME), SERVER, "admins", false);
    expect(gridLists(rows).admins).toContain(SERVER);
  });

  it("counts everyone's boxes toward each person's access, as the engine does", () => {
    const rows = gridRows(lists({ writers: [ME, "p-carol"], readers: [ME, "*"] }), ME);
    expect(effective(rows, "p-carol")).toMatchObject({ writers: true, readers: true });
    expect(rowNote(rows, "p-carol", ME)).toBeUndefined();
    const without = setBox(rows, "*", "readers", false);
    expect(rowNote(without, "p-carol", ME)).toBe("Writer without reader: can't edit anything");
    expect(rowWarns(without, "p-carol", ME)).toBe(true);
  });

  it("says when someone is locked out, keeping their other boxes", () => {
    const rows = gridRows(lists({ readers: [ME, "p-dana"], noAccess: ["p-dana"] }), ME);
    expect(rowNote(rows, "p-dana", ME)).toBe("Locked out. The other boxes are kept but have no effect.");
    expect(gridLists(rows).readers).toContain("p-dana");
  });

  it("refuses a grid that would take away your own admin, or lock you out", () => {
    const rows = gridRows(lists(), ME);
    expect(saveProblem(rows, ME)).toBeUndefined();
    expect(saveProblem(setBox(rows, ME, "admins", false), ME)).toMatch(/can't remove yourself from the admins/);
    expect(saveProblem(setBox(rows, ME, "noAccess", true), ME)).toMatch(/can't lock yourself out/);
    expect(rowWarns(setBox(rows, ME, "admins", false), ME, ME)).toBe(true);
    expect(rowNote(rows, ME, ME)).toBe("You can't lock yourself out");
  });
});
