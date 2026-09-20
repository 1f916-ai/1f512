#!/usr/bin/env node
// Validate a reading JSON or JSONL file against schemas/reading-line.json.
// No install step beyond Node >= 22.6:
//   node --experimental-strip-types examples/validate-reading.ts schemas/vectors/four-verdicts.jsonl
//
// Soft-power: this is the check a stranger runs without trusting our process.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFourVerdictSchema,
  loadReadingSchema,
  validateReadingJsonl,
  validateReadingLine,
} from "../src/reading-schema.ts";

function usage(): never {
  console.error(`usage: node --experimental-strip-types examples/validate-reading.ts <file.json|file.jsonl>
       node --experimental-strip-types examples/validate-reading.ts --schema-check`);
  process.exit(2);
}

const arg = process.argv[2];
if (!arg) usage();

if (arg === "--schema-check") {
  const problems = assertFourVerdictSchema(loadReadingSchema());
  if (problems.length) {
    console.error("SCHEMA DISHONEST:");
    for (const p of problems) console.error("  -", p);
    process.exit(1);
  }
  console.log("schema names all four verdicts: HELD BROKEN UNREADABLE DEFAULTED");
  process.exit(0);
}

const path = resolve(arg);
const text = readFileSync(path, "utf8");
const schema = loadReadingSchema();

const schemaProblems = assertFourVerdictSchema(schema);
if (schemaProblems.length) {
  console.error("SCHEMA DISHONEST (refusing to validate against a happy-path schema):");
  for (const p of schemaProblems) console.error("  -", p);
  process.exit(1);
}

if (path.endsWith(".jsonl") || text.includes("\n") && text.trim().startsWith("{") && text.indexOf("\n{") !== -1) {
  const failures = validateReadingJsonl(text, schema);
  if (failures.length === 0) {
    const n = text.split("\n").filter((l) => l.trim()).length;
    console.log(`ok: ${n} reading line(s) validate`);
    process.exit(0);
  }
  for (const f of failures) {
    console.error(`line ${f.lineNumber}:`);
    for (const e of f.errors) console.error("  -", e);
  }
  process.exit(1);
}

const line = JSON.parse(text);
const errors = validateReadingLine(line, schema);
if (errors.length === 0) {
  console.log(`ok: ${path} validates as a reading line (${line.verdict})`);
  process.exit(0);
}
for (const e of errors) console.error("  -", e);
process.exit(1);
