// Self-signed certificates for the HTTPS tests, made with node:crypto alone so
// the tests need no openssl program on any OS. A minimal DER encoder for one
// X.509 v3 certificate: an EC P-256 key, signed by itself, for localhost and
// 127.0.0.1.

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);

/**
 * A DER INTEGER for the unsigned big-endian bytes. DER needs the shortest
 * form: no leading zero bytes, except one where the next byte's top bit is
 * set (it would read as negative otherwise). OpenSSL refuses any other, so a
 * random serial starting with a zero byte made about one certificate in 500
 * unusable.
 */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  const minimal = bytes.subarray(start);
  return tlv(0x02, (minimal[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}

function oid(text: string): Buffer {
  const [a = 0, b = 0, ...rest] = text.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let value = n >> 7; value > 0; value >>= 7) groups.unshift(0x80 | (value & 0x7f));
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A new self-signed certificate and its key, both PEM. commonName tells two apart. */
export function selfSigned(commonName = "localhost"): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const now = Date.now();
  const subjectAltName = sequence(tlv(0x82, Buffer.from("localhost", "ascii")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = tlv(0xa3, sequence(sequence(oid("2.5.29.17"), tlv(0x04, subjectAltName))));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ECDSA_SHA256,
    name(commonName),
    sequence(time(new Date(now - 3_600_000)), time(new Date(now + 10 * 365 * 86_400_000))),
    name(commonName),
    spki,
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return { cert: pem("CERTIFICATE", certificate), key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
