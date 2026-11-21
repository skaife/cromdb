// Writes src/api/schema.ts from the built server's route table (run
// "npm run build" first). Usage: node scripts/gen-api.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverOpenApi } from "./server-openapi.ts";
import { generate } from "./api-types.ts";

const target = join(import.meta.dirname, "..", "src", "api", "schema.ts");
writeFileSync(target, generate(await serverOpenApi()));
console.log(`Wrote ${target}`);
