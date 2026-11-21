import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.ts";
import { errorMessage, formatDay } from "../src/app/format.ts";

describe("formatting", () => {
  it("shows the year only outside the current one", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(formatDay("2026-11-12T10:00:00Z", now)).not.toMatch(/2026/);
    expect(formatDay("2025-11-12T10:00:00Z", now)).toMatch(/2025/);
    expect(formatDay("not a date", now)).toBe("not a date");
  });

  it("says what a refusal means", () => {
    expect(errorMessage(new ApiError(412, "STALE_VERSION", "x"))).toBe("This changed since you opened it. Reload to see the new version.");
    expect(errorMessage(new ApiError(400, "INVALID_INPUT", "name must not be blank"))).toBe("name must not be blank");
    expect(errorMessage(new ApiError(409, "SOMETHING_NEW", "A new refusal"))).toBe("A new refusal (SOMETHING_NEW)");
    expect(errorMessage(new Error("bug"))).toBe("Something went wrong in this page. Reload it to try again.");
  });
});
