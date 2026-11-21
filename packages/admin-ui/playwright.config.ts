// The admin UI in real browsers, against a real cromdb-server serving the
// built page, with the fake login provider (scripts/dev-server.ts in the
// server package). Build everything first: npm run build at the root.
//
// Each test runs at desktop width and again at phone width, in Chromium and
// Firefox. Set CROMDB_SCREENS to a folder to save a screenshot of each screen
// there.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const PORT = 5199;
const PROVIDER_PORT = 5198;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

export default defineConfig({
  testDir: "e2e",
  // One server for all: the tests run one at a time, so what one makes the next can count on.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  timeout: 30_000,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["github"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"], viewport: DESKTOP } },
    { name: "chromium-phone", use: { ...devices["Desktop Chrome"], viewport: PHONE } },
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"], viewport: DESKTOP } },
    { name: "firefox-phone", use: { ...devices["Desktop Firefox"], viewport: PHONE } },
  ],
  webServer: {
    command: [
      "node ../server/scripts/dev-server.ts --fresh",
      `--public-url http://127.0.0.1:${PORT} --listen 127.0.0.1:${PORT}`,
      `--provider-port ${PROVIDER_PORT} --data "${join(tmpdir(), "cromdb-admin-ui-e2e")}"`,
    ].join(" "),
    url: `http://127.0.0.1:${PORT}/api/v0/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
