/**
 * Deterministic JSON serialization for hashing workflow definitions (docs/36 §3.5):
 * object keys sorted recursively (by UTF-16 code units, the default string order), array
 * order preserved, no insignificant whitespace. Strings and numbers use JSON.stringify's
 * own encoding, which is deterministic (shortest round-trip number form; `-0` becomes `0`).
 *
 * Accepts only the JSON value subset — null, booleans, finite numbers, strings, arrays and
 * plain objects. Anything else (undefined, NaN/Infinity, bigint, functions, symbols, class
 * instances such as Date, sparse arrays, cycles) throws a TypeError instead of being dropped
 * or converted, because a silently altered value would produce a hash of something other
 * than the definition. `$comment` keys are ordinary keys here and are therefore hashed.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value at ${path}`);
  }

  const obj = value as object;
  if (ancestors.has(obj)) throw new TypeError(`canonicalJson: circular reference at ${path}`);
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new TypeError(`canonicalJson: sparse array at ${path}[${i}]`);
        parts.push(serialize(obj[i], `${path}[${i}]`, ancestors));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: non-plain object at ${path}`);
    if (Object.getOwnPropertySymbols(obj).length > 0) throw new TypeError(`canonicalJson: symbol keys at ${path}`);
    const record = obj as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`);
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
}
