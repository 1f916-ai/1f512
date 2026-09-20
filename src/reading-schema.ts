// Reading-line schema surface: load the frozen JSON Schema, validate a line,
// and refuse a schema that quietly drops UNREADABLE or DEFAULTED.
//
// Soft-power Rank 1 for 1f512: a format that only encodes the happy path is
// not a format for this project. The four verdicts are the product.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, type JsonSchema } from "./json-schema.ts";
import { VERDICTS, type Reading, type Verdict } from "./reading.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const READING_SCHEMA_PATH = join(HERE, "..", "schemas", "reading-line.json");
export const VECTORS_DIR = join(HERE, "..", "schemas", "vectors");

const VECTOR_FILES: Record<Verdict, string> = {
  HELD: "held.json",
  BROKEN: "broken.json",
  UNREADABLE: "unreadable.json",
  DEFAULTED: "defaulted.json",
};

/** Load the checked-in reading-line schema from disk. */
export function loadReadingSchema(path: string = READING_SCHEMA_PATH): JsonSchema {
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

/**
 * The verdict enum the schema claims. Exposed so tests can assert it equals
 * VERDICTS from reading.ts — dropping UNREADABLE or DEFAULTED from the schema
 * is the mutation this module exists to make expensive.
 */
export function schemaVerdictEnum(schema: JsonSchema = loadReadingSchema()): Verdict[] {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const en = props?.verdict?.enum;
  if (!Array.isArray(en)) throw new Error("reading-line schema is missing properties.verdict.enum");
  return en as Verdict[];
}

/**
 * A schema that cannot name UNREADABLE or DEFAULTED is not this project's
 * schema. Returns problems; empty means the schema still tells the whole truth.
 *
 * Killing mutation: delete UNREADABLE or DEFAULTED from
 * schemas/reading-line.json enum — this returns a non-empty list and the
 * golden-vector suite goes red.
 */
export function assertFourVerdictSchema(schema: JsonSchema = loadReadingSchema()): string[] {
  const claimed = schemaVerdictEnum(schema);
  const problems: string[] = [];
  for (const v of VERDICTS) {
    if (!claimed.includes(v)) {
      problems.push(
        `schema verdict enum is missing ${v} — a happy-path-only format is invalid here`,
      );
    }
  }
  for (const v of claimed) {
    if (!(VERDICTS as readonly string[]).includes(v)) {
      problems.push(`schema verdict enum has unknown value ${JSON.stringify(v)}`);
    }
  }
  if (claimed.length !== VERDICTS.length) {
    problems.push(
      `schema verdict enum length ${claimed.length} !== VERDICTS length ${VERDICTS.length}`,
    );
  }
  return problems;
}

/** Validate one reading line against the frozen schema. Empty = ok. */
export function validateReadingLine(
  line: unknown,
  schema: JsonSchema = loadReadingSchema(),
): string[] {
  return validate(schema, line);
}

/** Validate a JSONL document (one reading per line; blank lines ignored). */
export function validateReadingJsonl(
  text: string,
  schema: JsonSchema = loadReadingSchema(),
): { lineNumber: number; errors: string[] }[] {
  const out: { lineNumber: number; errors: string[] }[] = [];
  const parts = text.split("\n");
  const rows = parts.at(-1) === "" ? parts.slice(0, -1) : parts;
  rows.forEach((raw, i) => {
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out.push({ lineNumber: i + 1, errors: [`unparseable JSON: ${String(e).slice(0, 120)}`] });
      return;
    }
    const errors = validateReadingLine(parsed, schema);
    if (errors.length) out.push({ lineNumber: i + 1, errors });
  });
  return out;
}

/** Load a named golden vector. */
export function loadVector(verdict: Verdict): Reading {
  return JSON.parse(readFileSync(join(VECTORS_DIR, VECTOR_FILES[verdict]), "utf8")) as Reading;
}
