// The log on disk: append-only JSONL, one reading per line.
//
// The format is decided in reading.ts. This file is about the one thing a file
// adds that an array does not: A WRITE CAN FAIL HALFWAY.
//
// A hash chain whose last line is truncated is not a chain with a bad last
// line -- it is a chain a verifier reports as broken from that point on, which
// is indistinguishable from tampering. So:
//
//   - a line is appended whole or not at all (write the newline WITH the line);
//   - a truncated trailing line is detected on read and reported as such,
//     rather than parsed into a plausible-looking record;
//   - the head is derived by READING the log, never cached in a sidecar file
//     that can disagree with it.
//
// That last one matters most. A cached head that drifts from the file is how a
// chain silently forks: the writer keeps chaining onto a hash the file does not
// contain, and every line after it verifies against a predecessor nobody has.

import { appendFile, readFile } from "node:fs/promises";
import { seal, verifyChain, type Reading, type ReadingContent } from "./reading.ts";

export interface LoadResult {
  lines: Reading[];
  /** Lines that were present but unusable, with why. Never silently dropped. */
  rejected: { lineNumber: number; raw: string; problem: string }[];
}

/**
 * Read a log file. A missing file is an empty log, not an error: the first run
 * of a fresh deployment has no log, and treating that as a failure would make
 * "nothing has happened yet" indistinguishable from "the disk is gone".
 */
export async function load(path: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { lines: [], rejected: [] };
    throw e;
  }
  const lines: Reading[] = [];
  const rejected: LoadResult["rejected"] = [];
  if (text === "") return { lines, rejected };

  const parts = text.split("\n");
  // A well-formed file ends with a newline, so the final split element is "".
  // Anything else means the last write was cut off mid-line.
  const trailing = parts.pop();
  if (trailing !== "") {
    rejected.push({
      lineNumber: parts.length + 1,
      raw: (trailing ?? "").slice(0, 200),
      problem: "truncated final line: the last append did not complete",
    });
  }
  parts.forEach((raw, i) => {
    if (raw === "") return;
    try {
      lines.push(JSON.parse(raw) as Reading);
    } catch (e) {
      rejected.push({ lineNumber: i + 1, raw: raw.slice(0, 200), problem: `unparseable: ${String(e).slice(0, 120)}` });
    }
  });
  return { lines, rejected };
}

/**
 * The hash the next line must chain onto. Derived from the file every time.
 *
 * Deliberately NOT cached. A head kept in a sidecar can disagree with the log,
 * and then the writer chains onto a hash the file does not contain -- a silent
 * fork where every later line verifies against a predecessor nobody has.
 */
export async function head(path: string): Promise<string> {
  const { lines } = await load(path);
  return lines.length === 0 ? "" : lines[lines.length - 1]!.hash;
}

/**
 * Append one reading, chained onto whatever the file currently ends with.
 *
 * Returns the sealed line. Throws if the log does not verify BEFORE the append:
 * writing a new line onto a broken chain buries the break under fresh data and
 * makes the damage harder to date. A broken log is a thing to stop at, not a
 * thing to grow.
 */
export type Appender = (path: string, data: string) => Promise<void>;

const defaultAppender: Appender = (path, data) => appendFile(path, data, "utf8");

export async function append(
  path: string,
  content: ReadingContent,
  write: Appender = defaultAppender,
): Promise<Reading> {
  const { lines, rejected } = await load(path);
  if (rejected.length > 0) {
    throw new Error(
      `refusing to append to a log with ${rejected.length} unusable line(s): ${rejected[0]!.problem} at line ${rejected[0]!.lineNumber}`,
    );
  }
  const problems = await verifyChain(lines);
  if (problems.length > 0) {
    throw new Error(
      `refusing to append to a broken chain: ${problems[0]!.problem} at line ${problems[0]!.index} (${problems[0]!.detail})`,
    );
  }
  const prev = lines.length === 0 ? "" : lines[lines.length - 1]!.hash;
  const line = await seal(content, prev);
  // THE NEWLINE GOES WITH THE LINE, IN ONE WRITE. Writing the record and then
  // the separator leaves a window where the file ends mid-line, and a reader
  // arriving in that window sees a truncated log that is not truncated.
  //
  // The writer is injectable ONLY so this property is testable: a single
  // threaded test cannot observe the gap between two writes, so the guard
  // counts the calls instead. Without the seam the test could assert nothing
  // and the comment above would be a claim nobody checks.
  await write(path, JSON.stringify(line) + "\n");
  return line;
}

/** Verify a log file end to end. Returns every problem, including unusable lines. */
export async function verify(path: string): Promise<{ ok: boolean; problems: string[] }> {
  const { lines, rejected } = await load(path);
  const problems = rejected.map((r) => `line ${r.lineNumber}: ${r.problem}`);
  for (const p of await verifyChain(lines)) {
    problems.push(`line ${p.index}: ${p.problem} — ${p.detail}`);
  }
  return { ok: problems.length === 0, problems };
}
