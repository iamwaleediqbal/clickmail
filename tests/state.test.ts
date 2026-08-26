import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { FOLDER_ORDER, STORAGE_KEY, hydrate, seedState } from "../lib/mail/state.ts";

/**
 * What survives a refresh.
 *
 * The gym is a normal web app: someone can open it, move mail around, close the
 * tab and come back. That restored mailbox is data written by whatever version
 * of this app they last used, read by this one — and it has broken exactly that
 * way before, when `query` was added and a restored save came back with it
 * `undefined`, taking the first render down rather than degrading.
 */

/* ------------------------------------------------------------------ */
/* The mailbox, restored                                               */
/* ------------------------------------------------------------------ */

test("a mailbox saved by this version comes back identical", () => {
  const state = seedState();
  const restored = hydrate(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
});

test("a mailbox saved before a field existed comes back usable", () => {
  // The actual bug: `query` was added, a restored save had no `query`, and
  // `state.query.trim()` threw on the first render.
  const old = JSON.parse(JSON.stringify(seedState())) as Record<string, unknown>;
  delete old.query;
  delete old.folder;

  const restored = hydrate(old);
  assert.equal(typeof restored.query, "string");
  assert.ok(FOLDER_ORDER.includes(restored.folder));
});

test("nothing that can be in storage makes hydrate throw", () => {
  const junk: unknown[] = [
    undefined,
    null,
    0,
    "",
    "not json, but something parsed it anyway",
    [],
    {},
    { emails: null },
    { emails: [] }, // an empty array is a corrupt save, not an empty mailbox
    { emails: "nope" },
    { selectedId: 42 },
    { folder: "banana" },
    { folder: null },
    { query: 7 },
    { composer: "yes" },
    { composer: { to: 5 } },
    { emails: [{ id: "a" }] }, // a message missing every other field
    { emails: [{ id: "a", labels: "finance" }] },
    { emails: [null] },
  ];

  for (const raw of junk) {
    let restored;
    assert.doesNotThrow(() => {
      restored = hydrate(raw);
    }, `hydrate threw on ${JSON.stringify(raw)}`);

    assert.ok(Array.isArray(restored!.emails) && restored!.emails.length, "no mail came back");
    assert.equal(typeof restored!.query, "string");
    assert.ok(FOLDER_ORDER.includes(restored!.folder), `folder came back as ${restored!.folder}`);
    assert.ok(
      restored!.selectedId === null || typeof restored!.selectedId === "string",
      "selectedId came back as neither null nor a string",
    );

    // The two the junk list named and then never checked. `{composer: "yes"}`
    // sat in this array while the loop asserted only on emails, query, folder
    // and selectedId — so the case that crashes the app on the next action was
    // listed, run, and could not fail.
    const draft = restored!.composer;
    assert.ok(
      draft === null ||
        (typeof draft.to === "string" &&
          typeof draft.subject === "string" &&
          typeof draft.body === "string"),
      `composer came back as ${JSON.stringify(draft)}`,
    );

    for (const mail of restored!.emails) {
      assert.ok(Array.isArray(mail.labels), `labels came back as ${JSON.stringify(mail.labels)}`);
      assert.equal(typeof mail.subject, "string");
      assert.equal(typeof mail.read, "boolean");
      assert.ok(FOLDER_ORDER.includes(mail.folder), `a message came back in ${mail.folder}`);
    }
  }
});

test("the storage key carries a version, so a shape change can be retired", () => {
  assert.match(STORAGE_KEY, /\.v\d+$/, `"${STORAGE_KEY}" has no version suffix`);
});

test("there is exactly one storage key, because there is no such thing as a run here", () => {
  // This application does not know what an evaluation is, and a per-run
  // storage namespace would be it knowing. The harness gets a clean world by
  // calling reset() on the published contract; there is nothing here to
  // namespace and nothing to clean up afterwards.
  const source = readFileSync(
    path.join(import.meta.dirname, "..", "lib", "mail", "state.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(source, /runId|storageKeyFor|clearRunStorage/);
});

