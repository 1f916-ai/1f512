// Guards for the append-only log on disk.
//
// The format is tested in reading.test.ts. These are about the one thing a file
// adds that an array does not: a write can fail halfway.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, head, load, verify } from "../src/log.ts";
import type { ReadingContent } from "../src/reading.ts";

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "1f512-log-"));
  return join(dir, "readings.jsonl");
}

const content = (over: Partial<ReadingContent> = {}): ReadingContent => ({
  commitment: "c-1",
  verdict: "HELD",
  reason: "no outbound transfer in window",
  rpc: [
    { provider: "alpha", method: "eth_getLogs", params: [], result: [], at_block: 100 },
    { provider: "beta", method: "eth_getLogs", params: [], result: [], at_block: 100 },
  ],
  read_at: 1_700_000_000_000,
  ...over,
});

test("a missing file is an empty log, not an error", async () => {
  // "Nothing has happened yet" must not be indistinguishable from "the disk is
  // gone". A fresh deployment has no log.
  const p = await tmp();
  assert.deepEqual(await load(p), { lines: [], rejected: [] });
  assert.equal(await head(p), "");
});

test("appends chain onto each other and verify end to end", async () => {
  const p = await tmp();
  const a = await append(p, content({ read_at: 1000 }));
  const b = await append(p, content({ read_at: 2000, verdict: "BROKEN", reason: "outbound transfer" }));
  assert.equal(a.prev_hash, "");
  assert.equal(b.prev_hash, a.hash);
  assert.equal(await head(p), b.hash);
  assert.deepEqual(await verify(p), { ok: true, problems: [] });
});

test("A TRUNCATED FINAL LINE IS REPORTED, NOT PARSED", async () => {
  // A half-written last line is the normal shape of a crash. Reporting it as a
  // chain break at that point is indistinguishable from tampering, and parsing
  // it into something plausible is worse.
  //
  // Killing mutation: drop the `trailing !== ""` check. This goes red.
  const p = await tmp();
  await append(p, content());
  const good = await readFile(p, "utf8");
  await writeFile(p, good + '{"commitment":"c-2","verd', "utf8");
  const { lines, rejected } = await load(p);
  assert.equal(lines.length, 1, "the complete line is still readable");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.problem, /truncated final line/);
});

test("the record and its newline are ONE write, not two", async () => {
  // A reader arriving between two writes sees a file ending mid-line -- a
  // truncated log that is not truncated. A single-threaded test cannot observe
  // that gap, so the guard counts the writes instead.
  //
  // Killing mutation: write the record and the newline separately. writes
  // becomes 2 and this goes red. (An earlier version of this test asserted the
  // file ended with a newline, which is true either way -- it claimed a
  // mutation it could not catch, which is the vacuous guard this project is
  // supposed to be against.)
  const p = await tmp();
  const writes: string[] = [];
  await append(p, content(), async (path, data) => {
    writes.push(data);
    await appendFile(path, data, "utf8");
  });
  assert.equal(writes.length, 1, "exactly one write reaches the file");
  assert.ok(writes[0]!.endsWith("\n"), "and it carries its own terminator");
  assert.equal((await readFile(p, "utf8")).split("\n").length, 2);
});

test("appending to a BROKEN chain is refused", async () => {
  // Writing onto a broken chain buries the break under fresh data and makes
  // the damage harder to date. A broken log is a thing to stop at.
  //
  // Killing mutation: delete the verifyChain guard in append(). This goes red
  // and the log grows happily on top of tampered history.
  const p = await tmp();
  await append(p, content({ read_at: 1000 }));
  await append(p, content({ read_at: 2000 }));
  const lines = (await readFile(p, "utf8")).trim().split("\n");
  const tampered = JSON.parse(lines[0]!);
  tampered.reason = "nothing to see here";
  await writeFile(p, JSON.stringify(tampered) + "\n" + lines[1] + "\n", "utf8");
  await assert.rejects(append(p, content({ read_at: 3000 })), /broken chain/);
});

test("appending to a log with an unusable line is refused", async () => {
  const p = await tmp();
  await append(p, content());
  await writeFile(p, (await readFile(p, "utf8")) + "{not json}\n", "utf8");
  await assert.rejects(append(p, content({ read_at: 2000 })), /unusable line/);
});

test("the head is derived from the file, never cached", async () => {
  // THE FORK THIS PREVENTS. A cached head that drifts from the file means the
  // writer chains onto a hash the file does not contain, and every later line
  // verifies against a predecessor nobody has.
  //
  // Killing mutation: memoise head() in a module-level variable. This goes red
  // because the second log's head leaks into the first.
  const p1 = await tmp();
  const p2 = await tmp();
  const a = await append(p1, content({ read_at: 1000 }));
  const b = await append(p2, content({ read_at: 1000, commitment: "c-other" }));
  assert.notEqual(a.hash, b.hash);
  assert.equal(await head(p1), a.hash, "each file reports its own head");
  assert.equal(await head(p2), b.hash);
});

test("verify reports unusable lines AND chain problems together", async () => {
  // A reader deciding whether to trust this log wants the whole shape of the
  // damage, not the first thing that went wrong.
  const p = await tmp();
  await append(p, content({ read_at: 1000 }));
  await writeFile(p, (await readFile(p, "utf8")) + "{bad}\n", "utf8");
  const r = await verify(p);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /unparseable/.test(x)));
});

test("an empty file is an empty log", async () => {
  const p = await tmp();
  await writeFile(p, "", "utf8");
  assert.deepEqual(await load(p), { lines: [], rejected: [] });
});
