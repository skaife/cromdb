// cromdb-server start: serves until stopped.

import { startServer } from "../server.js";
import type { Io } from "./io.js";

/**
 * Serves until SIGINT or SIGTERM, or until a server admin asks for a restart
 * (only when CROMDB_RESTART_ON_EXIT=1 says something starts it again). Either
 * way it stops cleanly and exits 0.
 */
export async function start(io: Io, dataDir: string, listen: string | undefined, backupsDir?: string): Promise<number> {
  let restart: (() => void) | undefined;
  const restarted = new Promise<void>((resolve) => {
    restart = resolve;
  });
  const server = await startServer({
    dataDir,
    ...(listen === undefined ? {} : { listen }),
    ...(backupsDir === undefined ? {} : { backupsDir }),
    onRestart: () => restart?.(),
  });
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      io.out(`${signal}: stopping`);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    void restarted.then(() => stop("Restart asked for"));
  });
  await server.close();
  return 0;
}
