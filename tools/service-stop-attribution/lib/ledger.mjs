/**
 * A durable per-stop ledger: one JSON object per line, appended, never rewritten.
 *
 * A ledger rather than a live report because the question this answers is asked
 * after the fact. When a stop lands, the only evidence that will ever exist is
 * what was written down at the time, and the 11:06 stop is the case that proves
 * the point: nothing in the surviving record names what caused it.
 *
 * Append-only also means a reader can diff two ledgers and see exactly which
 * stops are new, which is how a watcher notices a recurrence.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/** The ledger's own schema version, so a future reader can tell. */
export const LEDGER_VERSION = 1;

export function appendStop(ledgerPath, stop, extra = {}) {
  const record = {
    ledgerVersion: LEDGER_VERSION,
    ...stop,
    ...extra,
  };
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

/**
 * Read a ledger, skipping any trailing partial line. A process killed
 * mid-write is the normal way a ledger ends, and a half-written line is not a
 * reason to refuse the whole file.
 */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const out = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A truncated final line, or a line from a future writer. Skipping it is
      // correct: the record it would have described was never completed.
      continue;
    }
  }
  return out;
}

/**
 * The stops in `stops` that the ledger does not already contain, keyed on the
 * pair that is stable across a re-read of the same journal: the unit and the
 * invocation the stop belonged to. Using `detectedAtMs` alone would duplicate
 * every record whenever the journal window is re-read.
 */
export function newStops(ledger, stops) {
  const seen = new Set(
    ledger
      .filter((r) => r.ledgerVersion === LEDGER_VERSION)
      .map((r) => `${r.unit ?? ""}:${r.invocationId ?? ""}`),
  );
  return stops.filter((s) => !seen.has(`${s.unit}:${s.invocationId ?? ""}`));
}
