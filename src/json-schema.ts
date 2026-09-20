// Tiny JSON-Schema subset evaluator. No dependencies.
// Covers the keywords used by schemas/reading-line.json so a stranger can
// validate a reading line without installing ajv. Not a general-purpose engine.

export type JsonSchema = Record<string, unknown>;

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function typeOk(value: unknown, want: string): boolean {
  const got = jsonType(value);
  if (want === got) return true;
  if (want === "integer") return typeof value === "number" && Number.isInteger(value);
  if (want === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

/** Validate `value` against `schema`. Returns human-readable error paths. */
export function validate(schema: JsonSchema, value: unknown, path = "$", root?: JsonSchema): string[] {
  const r = root ?? schema;
  const errors: string[] = [];

  if (schema.$ref !== undefined) {
    const ref = String(schema.$ref);
    if (!ref.startsWith("#/")) return [`${path}: only local $ref supported (got ${ref})`];
    let cur: unknown = r;
    for (const p of ref.slice(2).split("/")) {
      if (cur === null || typeof cur !== "object" || !(p in (cur as object))) {
        return [`${path}: unresolved $ref ${ref}`];
      }
      cur = (cur as Record<string, unknown>)[p];
    }
    return validate(cur as JsonSchema, value, path, r);
  }

  if (schema.type !== undefined) {
    const want = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!want.some((t) => typeOk(value, t))) {
      errors.push(`${path}: expected type ${want.join("|")}, got ${jsonType(value)}`);
    }
  }

  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    const hit = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!hit) errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined && typeof schema.items === "object" && schema.items !== null) {
      value.forEach((item, i) => {
        errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`, r));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj)) errors.push(`${path}: missing required field "${key}"`);
      }
    }
    if (schema.properties !== undefined && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        if (key in obj) errors.push(...validate(sub, obj[key], `${path}.${key}`, r));
      }
    }
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      const allowed = new Set(Object.keys(schema.properties as object));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}: additional property "${key}" not allowed`);
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      errors.push(...validate(sub as JsonSchema, value, path, r));
    }
  }

  if (schema.if !== undefined) {
    const ok = validate(schema.if as JsonSchema, value, path, r).length === 0;
    const branch = ok ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validate(branch as JsonSchema, value, path, r));
  }

  if (Array.isArray(schema.oneOf)) {
    const n = (schema.oneOf as JsonSchema[]).filter((sub) => validate(sub, value, path, r).length === 0).length;
    if (n !== 1) errors.push(`${path}: matched ${n} of oneOf branches, need exactly 1`);
  }

  return errors;
}
