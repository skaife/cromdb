import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Routed } from "./routed.tsx";

function Broken(): never {
  throw new Error("secret detail at line 42");
}

afterEach(() => vi.restoreAllMocks());

describe("a screen that throws", () => {
  it("shows our own page with Reload, never the error, and logs the error to the console", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    render(
      <Routed path="/databases">
        <Broken />
      </Routed>,
    );
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByText("Reload the page. If it happens again, the server log or the browser console has the details.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret detail");
    expect(document.body.textContent).not.toMatch(/at line|Error:|stack/i);
    expect(logged.mock.calls.some((call) => call.some((arg) => arg instanceof Error && arg.message === "secret detail at line 42"))).toBe(true);
    expect(fetched).not.toHaveBeenCalled();
  });
});
