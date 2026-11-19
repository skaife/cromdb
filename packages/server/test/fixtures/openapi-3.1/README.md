# OpenAPI 3.1 schema

`schema.json` is the JSON Schema for OpenAPI 3.1 documents published by the
OpenAPI Initiative, unchanged:

  https://spec.openapis.org/oas/3.1/schema/2022-10-07
  sha256 da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0

It is licensed under the Apache License 2.0 (`LICENSE`, from
https://github.com/OAI/OpenAPI-Specification).

The server's tests check its `openapi.json` against it with Ajv
(`test/openapi.test.ts`). Ajv resolves the schema's `$dynamicRef: "#meta"`
to the wrong place, so the test reads it with each one replaced by
`$ref: "#/$defs/schema"`. The only `$dynamicAnchor: "meta"` in the file is
on `$defs/schema`, so the two mean the same here.
