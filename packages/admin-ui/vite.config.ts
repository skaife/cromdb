// Builds the admin UI into dist/: index.html and assets/, which the server
// serves (packages/server/src/http/static.ts). "npm run dev" serves it with
// hot reload on http://localhost:5173, sending /api and /auth on to a
// cromdb-server (scripts/dev-server.ts in the server package, by default on
// 127.0.0.1:8080; CROMDB_DEV_SERVER names another).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const target = process.env["CROMDB_DEV_SERVER"] ?? "http://127.0.0.1:8080";

/** The font's license goes out with the font files (the SIL Open Font License asks for that). */
function fontLicense(): Plugin {
  return {
    name: "cromdb-font-license",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", name: "inter-LICENSE.txt", source: readFileSync(require.resolve("@fontsource-variable/inter/LICENSE")) });
    },
  };
}

export default defineConfig({
  plugins: [react(), fontLicense()],
  build: {
    // Nothing inline in the page, so the CSP needs no hashes or 'unsafe-inline'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The server checks Origin against its public URL, which in dev is
      // this address; so Origin passes as the browser sent it.
      "/api": { target },
      "/auth": { target },
    },
  },
});
