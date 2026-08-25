import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * Guards on how a rate limit is handled.
 *
 * A 429 is a statement about the account, not the request: every free model
 * draws on the same pool. Treating it as a transient error meant three retries
 * with backoff, then the same again against the next model in the chain, then
 * the whole thing repeated for each remaining task — roughly thirty requests
 * spent discovering a limit that the first response had already reported.
 *
 * These read the source rather than exercising the network, because the
 * behaviour worth protecting is a policy decision that is easy to undo by
 * adding one number back to a set.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

test("429 is not in the retryable set", () => {
  const source = read("app/api/agent/route.ts");
  const declaration = source.match(/const RETRYABLE = new Set\(\[([^\]]*)\]\)/);

  assert.ok(declaration, "the retryable status list should still exist");
  const codes = declaration[1].split(",").map((value) => Number(value.trim()));
  assert.ok(
    !codes.includes(429),
    "429 must not be retried — every free model draws on the same pool",
  );
});

test("the route reports a quota failure as 429 rather than a generic transport error", () => {
  const source = read("app/api/agent/route.ts");

  assert.match(source, /quota: true/, "a quota failure needs its own flag");
  assert.match(source, /status: 429/, "the caller should see the real status");
});

test("the runner throws a dedicated error for quota rather than continuing", () => {
  const source = read("runner/run.ts");

  assert.match(source, /class QuotaError/);
  assert.match(source, /throw new QuotaError/);
});

test("the runner checks the quota before spending any of it", () => {
  const source = read("runner/run.ts");

  assert.match(source, /auth\/key/, "the free limits endpoint does not draw on the quota");
  assert.match(source, /await checkQuota\(\)/, "and it has to actually be called");
});

test("a batch stops after the first infrastructure failure", () => {
  const source = read("runner/run.ts");

  // Five more tasks failing the same way is not five more measurements.
  assert.match(source, /stopping the batch/);
});

test("a batch that measured nothing does not overwrite what was published", () => {
  const source = read("runner/run.ts");

  assert.match(
    source,
    /index\.json is left as it was/,
    "six infrastructure failures must not replace real recorded runs",
  );
});

test("a spent quota ends the whole session, not just the task that discovered it", () => {
  /*
   * The recording script runs this process once per task, so a quota stop that
   * only breaks the batch loop inside one invocation is not a stop at all: the
   * next task starts a fresh process, spends a request finding out the quota is
   * gone, and does it again for every task left. Under --all there is nobody at
   * the keyboard to notice.
   */
  const runner = read("runner/run.ts");
  const script = read("record-runs.sh");

  assert.match(
    runner,
    /process\.exit\(stopKind === "quota" \? 3 : 1\)/,
    "a quota stop must be distinguishable from a batch that merely recorded nothing",
  );
  assert.match(
    runner,
    /if \(stopKind === "quota"\) \{[\s\S]*process\.exit\(3\)/,
    "and it must still exit 3 after keeping the runs that did complete",
  );
  assert.match(
    script,
    /RUN_STATUS" -eq 3/,
    "the recording script never reads the exit code that tells it to stop",
  );
  assert.ok(
    /-eq 3 \][\s\S]{0,400}?STOP="yes"/.test(script),
    "reading the code is not the same as acting on it",
  );
});

test("screenshots from a run that recorded nothing are not left behind", () => {
  /*
   * The failure this exists for is on disk right now as this is written: a run
   * wrote its screenshots, failed before it reached a model, and exited on the
   * path that leaves index.json alone. The prune only ran on the success path,
   * so 380KB of images stayed in public/runs/shots — committed, deployed, and
   * unreachable, because no run in the index refers to them.
   */
  const source = read("runner/run.ts");

  assert.match(source, /async function pruneShots/, "the prune should be callable from both paths");
  const nothingRecorded = source.slice(0, source.indexOf("index.json is left as it was"));
  assert.match(
    nothingRecorded.slice(-1200),
    /await pruneShots\(published\)/,
    "the path that records nothing must still clean up after itself",
  );
});
