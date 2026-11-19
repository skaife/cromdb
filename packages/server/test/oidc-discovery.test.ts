import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkIssuer } from "../src/oidc-discovery.js";
import { fakeIssuer, type FakeIssuer } from "./helpers.js";

let fake: FakeIssuer;
let discovery: Record<string, unknown>;
let jwks: Record<string, unknown>;

beforeAll(async () => {
  fake = await fakeIssuer();
  discovery = fake.discovery;
  jwks = fake.jwks;
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.discovery = { ...discovery };
  fake.jwks = { ...jwks };
});

describe("checking a provider", () => {
  it("accepts one that does what login needs", async () => {
    await expect(checkIssuer(fake.issuer)).resolves.toBeUndefined();
  });

  it("accepts an EC signing key", async () => {
    fake.jwks = { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] };
    await expect(checkIssuer(fake.issuer)).resolves.toBeUndefined();
  });

  it("needs the issuer exactly as the provider states it", async () => {
    await expect(checkIssuer(`${fake.issuer}/`)).rejects.toThrow(`The provider's issuer is "${fake.issuer}"`);
  });

  it("explains a provider that can't be reached or isn't one", async () => {
    await expect(checkIssuer(`${fake.issuer}-missing`)).rejects.toThrow("gave HTTP 404");
    await expect(checkIssuer("http://127.0.0.1:9/realms/x")).rejects.toThrow("Couldn't fetch the discovery document");
  });

  const refusals: [string, () => void, string][] = [
    ["no token endpoint", () => delete fake.discovery["token_endpoint"], "no token_endpoint"],
    ["no code flow", () => (fake.discovery["response_types_supported"] = ["id_token"]), 'response type "code"'],
    ["no PKCE S256", () => (fake.discovery["code_challenge_methods_supported"] = ["plain"]), "S256"],
    ["only HS256 tokens", () => (fake.discovery["id_token_signing_alg_values_supported"] = ["HS256"]), "RS256 or ES256"],
    ["no keys", () => (fake.jwks = { keys: [] }), "no RS256 or ES256 signing key"],
    ["only an encryption key", () => (fake.jwks = { keys: [{ kty: "RSA", use: "enc", n: "n", e: "e" }] }), "signing key"],
    ["only a P-384 key", () => (fake.jwks = { keys: [{ kty: "EC", crv: "P-384", x: "x", y: "y" }] }), "signing key"],
    ["keys that aren't an object", () => (fake.jwks = [] as never), "not a JSON object"],
  ];
  for (const [name, change, message] of refusals) {
    it(`refuses a provider with ${name}`, async () => {
      change();
      await expect(checkIssuer(fake.issuer)).rejects.toThrow(message);
    });
  }
});
