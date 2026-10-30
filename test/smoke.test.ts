import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("smoke", () => {
  it("loads", () => {
    expect(VERSION).toBe("0.2.0");
  });
});
