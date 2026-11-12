// The canonical form of a JSON value: RFC 8785, the JSON Canonicalization
// Scheme. Equal values give equal text, whatever their key order, so a hash
// or a signature over the text is the same on every replica.
//
// Pure. Object keys are sorted by UTF-16 code units, which is JavaScript's
// default string sort, and numbers and strings are written as JSON.stringify
// writes them, which is what RFC 8785 specifies.

/** Whether the string has a lone surrogate, which RFC 8785 doesn't allow. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function writeString(value: string, path: string): string {
  if (hasLoneSurrogate(value)) {
    throw new TypeError(`Cannot canonicalize ${path}: the string has a lone surrogate`);
  }
  return JSON.stringify(value);
}

function write(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize ${path}: ${String(value)} is not a finite number`);
      }
      return JSON.stringify(value);
    case "string":
      return writeString(value, path);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize ${path}: ${typeof value} is not a JSON value`);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Cannot canonicalize ${path}: the array has a hole at ${index}`);
      }
      items.push(write(value[index], `${path}/${index}`));
    }
    return `[${items.join(",")}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Cannot canonicalize ${path}: only plain objects and arrays are JSON`);
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${writeString(key, `a key in ${path}`)}:${write(record[key], `${path}/${key}`)}`);
  return `{${members.join(",")}}`;
}

/**
 * @internal The RFC 8785 canonical JSON text of value. Throws TypeError for
 * anything that isn't JSON: undefined, functions, symbols, bigints,
 * non-finite numbers, class instances, sparse arrays, and strings (values or
 * keys) with a lone surrogate.
 */
export function canonicalize(value: unknown): string {
  return write(value, "the value");
}
