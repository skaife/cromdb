import { afterAll, describe, it } from "vitest";
import { registerContractTests } from "@cromdb/driver/contract";
import { contractOptions, tempDir } from "./helpers.js";

const dir = tempDir();
afterAll(() => dir.remove());

registerContractTests({ describe, it }, "level 4", contractOptions(dir));
