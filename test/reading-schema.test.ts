// Reading-line schema + golden vectors (soft-power Rank 1).
//
// Each test names the mutation that kills it. A schema that only encodes HELD
// is not a schema for this project — UNREADABLE and DEFAULTED are first-class.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { VERDICTS, verifyChain, type Reading } from "../src/reading.ts";
import {
  assertFourVerdictSchema,
  loadReadingSchema,
  loadVector,
  schemaVerdictEnum,
  validateReadingJsonl,
  validateReadingLine,
  VECTORS_DIR,
} from "../src/reading-schema.ts";
import type { JsonSchema } from "../src/json-schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the schema names all four verdicts — happy-path-only is refused", () => {
  // Killing mutation: remove UNREADABLE or DEFAULTED from
  // schemas/reading-line.json properties.verdict.enum. This goes red, and a
  // stranger validating against the mutated schema would silently accept a
  // log that can never admit failure.
  const problems = assertFourVerdictSchema();
  assert.deepEqual(problems, []);
  assert.deepEqual(schemaVerdictEnum().slice().sort(), VERDICTS.slice().sort());
});

test("a schema that drops UNREADABLE is caught before any line is checked", () => {
  // Killing mutation: ship a schema whose enum is only ["HELD","BROKEN"].
  // assertFourVerdictSchema must refuse it — otherwise the validator becomes
  // a status-page rubber stamp.
  const schema = structuredClone(loadReadingSchema()) as JsonSchema;
  const props = schema.properties as Record<string, JsonSchema>;
  props.verdict = { ...props.verdict, enum: ["HELD", "BROKEN"] };
  const problems = assertFourVerdictSchema(schema);
  assert.ok(problems.some((p) => /UNREADABLE/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /DEFAULTED/.test(p)), problems.join("; "));
});

test("golden vectors for all four verdicts validate and recompute their hashes", async () => {
  // Killing mutation: delete schemas/vectors/unreadable.json (or defaulted).
  // The suite must not be green on a three-verdict corpus.
  const lines: Reading[] = [];
  for (const v of VERDICTS) {
    const line = loadVector(v);
    assert.equal(line.verdict, v, `vector ${v} must carry its own verdict`);
    const errors = validateReadingLine(line);
    assert.deepEqual(errors, [], `${v} vector must validate: ${errors.join("; ")}`);
    lines.push(line);
  }
  // The chained JSONL specimen must verify as a hash chain, not just as shapes.
  const problems = await verifyChain(lines);
  assert.deepEqual(problems, [], `four-verdict chain must verify: ${JSON.stringify(problems)}`);
});

test("four-verdicts.jsonl validates line-by-line", () => {
  // Killing mutation: drop the DEFAULTED line from the JSONL. Count goes to 3
  // and this fails — a corpus that never defaults is not the acceptance specimen.
  const text = readFileSync(join(VECTORS_DIR, "four-verdicts.jsonl"), "utf8");
  const failures = validateReadingJsonl(text);
  assert.deepEqual(failures, []);
  const verdicts = text
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as Reading).verdict)
    .sort();
  assert.deepEqual(verdicts, [...VERDICTS].sort());
});

test("HELD with fewer than two rpc exchanges is refused", () => {
  // Killing mutation: remove the allOf/if/then minItems:2 rule for
  // HELD|BROKEN|DEFAULTED. A single-sourced HELD would then validate — the
  // exact false green agreement.ts exists to prevent.
  const held = loadVector("HELD");
  const slim = { ...held, rpc: held.rpc.slice(0, 1) };
  const errors = validateReadingLine(slim);
  assert.ok(
    errors.some((e) => /minItems|rpc/i.test(e)),
    `expected minItems failure, got: ${errors.join("; ") || "(none)"}`,
  );
});

test("UNREADABLE may carry a single rpc exchange (one_failed)", () => {
  // The asymmetric case: one provider answered, one did not. Publishing the
  // one answer is evidence of disagreement-with-silence, not a single-source
  // HELD. Schema must ACCEPT this — refusing it would push operators to invent
  // a fake second exchange.
  const unread = loadVector("UNREADABLE");
  assert.equal(unread.rpc.length, 1);
  assert.deepEqual(validateReadingLine(unread), []);
});

test("a URL-shaped provider is refused — labels only", () => {
  // Killing mutation: drop the provider pattern that rejects :// and /.
  // A keyed RPC URL would then validate into an append-only public log.
  const held = loadVector("HELD");
  const leaked = {
    ...held,
    rpc: held.rpc.map((x, i) =>
      i === 0 ? { ...x, provider: "https://rpc.example/v2/SECRETKEY" } : x,
    ),
  };
  const errors = validateReadingLine(leaked);
  assert.ok(
    errors.some((e) => /provider|pattern/i.test(e)),
    `expected provider rejection, got: ${errors.join("; ") || "(none)"}`,
  );
});

test("an unknown verdict is refused", () => {
  // Killing mutation: widen the enum with "OK" or delete the enum. "OK" is how
  // status pages launder UNREADABLE into reassurance.
  const held = loadVector("HELD");
  const errors = validateReadingLine({ ...held, verdict: "OK" });
  assert.ok(errors.some((e) => /enum|verdict/i.test(e)), errors.join("; "));
});

test("schema file lives where the stranger CLI looks", () => {
  // Killing mutation: move the schema without updating READING_SCHEMA_PATH.
  const schema = loadReadingSchema();
  assert.equal(schema.title, "1f512 reading line");
  assert.ok(readFileSync(join(ROOT, "schemas", "reading-line.json"), "utf8").length > 100);
});
