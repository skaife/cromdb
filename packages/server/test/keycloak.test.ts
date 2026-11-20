// Login against real Keycloak: the same scenario suite the fake provider
// runs (login-scenarios.ts), with the attack cases, and the record of
// Keycloak's shapes that keeps the fake honest. Run by "npm run
// test:keycloak", which starts Keycloak in Docker and sets KEYCLOAK_URL;
// skipped without it. With KEYCLOAK_RECORD=1 the shapes are recorded
// instead of compared (after raising the pinned version).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keycloakHarness, KEYCLOAK_VERSION } from "./keycloak-harness.js";
import { loginScenarios } from "./login-scenarios.js";
import { providerShapes, recordingFile } from "./provider-shapes.js";

const url = process.env["KEYCLOAK_URL"];

describe.skipIf(url === undefined)(`login with Keycloak ${KEYCLOAK_VERSION}`, () => {
  loginScenarios(() => keycloakHarness(url ?? ""));
});

describe.skipIf(url === undefined)(`Keycloak ${KEYCLOAK_VERSION}'s shapes`, () => {
  it("are the ones recorded for this version", async () => {
    const live = await providerShapes(await keycloakHarness(url ?? ""));
    const file = recordingFile(KEYCLOAK_VERSION);
    if (process.env["KEYCLOAK_RECORD"] === "1") {
      writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
    }
    expect(existsSync(file), `no recording for Keycloak ${KEYCLOAK_VERSION}: run with KEYCLOAK_RECORD=1`).toBe(true);
    expect(live).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });
});
