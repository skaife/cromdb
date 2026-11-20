// The test certificates themselves: every one must load. A serial number
// encoded the wrong way once made about one in 500 unusable, which showed up
// as an occasional failure of whichever HTTPS test drew it.

import { createSecureContext } from "node:tls";
import { describe, expect, it } from "vitest";
import { selfSigned } from "./certificates.js";

describe("selfSigned", () => {
  it("makes certificates that always load with their key", () => {
    let unusable = 0;
    for (let n = 0; n < 2000; n++) {
      const { cert, key } = selfSigned();
      try {
        createSecureContext({ cert, key });
      } catch {
        unusable++;
      }
    }
    expect(unusable).toBe(0);
  });
});
