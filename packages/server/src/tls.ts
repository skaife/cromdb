// The certificate and key the server serves HTTPS with, and their reloading
// when they are renewed (for example by certbot), without a restart.

import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext, type SecureContextOptions } from "node:tls";
import type { TlsFiles } from "./settings.js";

export class TlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsError";
  }
}

/**
 * Reads the two files and checks that they make a usable pair: PEM that
 * parses, and a key that matches the certificate. Returns them for a
 * secure context.
 */
export function loadTlsFiles(files: TlsFiles): { cert: Buffer; key: Buffer } {
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = readFileSync(files.certFile);
  } catch (error) {
    throw new TlsError(`Can't read the certificate file ${files.certFile}: ${(error as Error).message}`);
  }
  try {
    key = readFileSync(files.keyFile);
  } catch (error) {
    throw new TlsError(`Can't read the key file ${files.keyFile}: ${(error as Error).message}`);
  }
  try {
    createSecureContext({ cert, key });
  } catch (error) {
    throw new TlsError(`The certificate and key can't be used together: ${(error as Error).message}`);
  }
  return { cert, key };
}

/** When the certificate in the file stops being valid, as an ISO time, or undefined if it can't be read. */
export function certificateValidUntil(certFile: string): string | undefined {
  try {
    const validTo = new Date(new X509Certificate(readFileSync(certFile)).validTo);
    return Number.isNaN(validTo.getTime()) ? undefined : validTo.toISOString();
  } catch {
    return undefined;
  }
}

/** A hash of both files' contents, to see when they change. They are small, so reading them is cheap. */
function signature(files: TlsFiles): string {
  try {
    return createHash("sha256").update(readFileSync(files.certFile)).update("\0").update(readFileSync(files.keyFile)).digest("hex");
  } catch {
    return "unreadable";
  }
}

export interface Reloadable {
  setSecureContext(options: SecureContextOptions): void;
}

/**
 * Looks at the files every intervalMs and, when they change and still make a
 * usable pair, gives the server the new pair. A pair that doesn't load (the
 * certificate renewed before the key, say) is logged once and tried again
 * when either file changes; the server keeps serving the last good pair.
 * Reading follows symbolic links, so certbot's live/ links work.
 */
export class CertificateWatcher {
  readonly #files: TlsFiles;
  readonly #log: (message: string) => void;
  #loaded: string;
  #failed: string | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(files: TlsFiles, log: (message: string) => void) {
    this.#files = files;
    this.#log = log;
    this.#loaded = signature(files);
  }

  /** The pair to start with. Throws TlsError. */
  initial(): { cert: Buffer; key: Buffer } {
    this.#loaded = signature(this.#files);
    return loadTlsFiles(this.#files);
  }

  start(server: Reloadable, intervalMs: number): void {
    this.#timer = setInterval(() => this.check(server), intervalMs);
    this.#timer.unref();
  }

  /** One look at the files. Returns whether a new pair was loaded. */
  check(server: Reloadable): boolean {
    const now = signature(this.#files);
    if (now === this.#loaded || now === this.#failed) {
      return false;
    }
    try {
      server.setSecureContext(loadTlsFiles(this.#files));
    } catch (error) {
      this.#failed = now;
      this.#log(`The renewed certificate files were not loaded; still serving the previous ones. ${(error as Error).message}`);
      return false;
    }
    this.#loaded = now;
    this.#failed = undefined;
    this.#log("Loaded renewed certificate files.");
    return true;
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}
