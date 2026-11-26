// cromdb-server health: asks a running server whether it is up, for a
// container's health check. It touches no data, so it works while the
// server holds the data directory's lock.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseListen } from "../settings.js";
import { CommandError, UsageError, type Io } from "./io.js";

/** The address health asks when --listen isn't given: the container's port. */
export const HEALTH_LISTEN = "127.0.0.1:8080";

const HEALTH_PATH = "/api/v0/health";

/** How long each attempt may take; the image's HEALTHCHECK allows 5 s for both. */
const ATTEMPT_MS = 2_000;

/** GETs the health route; resolves with the status and body, rejects on any connection or TLS failure. */
function ask(scheme: "https" | "http", host: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      host,
      port,
      path: HEALTH_PATH,
      method: "GET",
      timeout: ATTEMPT_MS,
      headers: { accept: "application/json" },
      agent: false as const,
    };
    // The certificate isn't checked: this asks the server's own port, and its
    // certificate names the public host, not 127.0.0.1.
    const req = scheme === "https" ? httpsRequest({ ...options, rejectUnauthorized: false }) : httpRequest(options);
    req.on("timeout", () => req.destroy(new Error(`no answer in ${ATTEMPT_MS / 1000} s`)));
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.end();
  });
}

function isOk(answer: { status: number; body: string }): boolean {
  if (answer.status !== 200) return false;
  try {
    return (JSON.parse(answer.body) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

/** Exit 0 if the server answers {"status":"ok"} over HTTPS or HTTP, else 1. */
export async function health(io: Io, listen: string | undefined): Promise<number> {
  const parsed = parseListen(listen ?? HEALTH_LISTEN);
  if (!parsed.ok) throw new UsageError(`--listen: ${parsed.problem}`);
  const host = parsed.value.host === "0.0.0.0" ? "127.0.0.1" : parsed.value.host === "::" ? "::1" : parsed.value.host;
  const { port } = parsed.value;
  const failures: string[] = [];
  for (const scheme of ["https", "http"] as const) {
    try {
      const answer = await ask(scheme, host, port);
      if (isOk(answer)) {
        io.out(`ok (${scheme})`);
        return 0;
      }
      failures.push(`${scheme}: answered ${answer.status}`);
    } catch (error) {
      failures.push(`${scheme}: ${(error as Error).message}`);
    }
  }
  throw new CommandError(`The server at ${host}:${port} isn't healthy. ${failures.join("; ")}`);
}
