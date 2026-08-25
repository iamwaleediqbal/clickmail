import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ACTION_NAMES, applyAction } from "../lib/mail/actions.ts";
import { FOLDER_ORDER, seedState } from "../lib/mail/state.ts";

/**
 * The application, and the promises it makes to whatever is driving it.
 *
 * The gym is one half of a pair that now lives in two repositories. It cannot
 * check that the harness's action space matches what it renders — that check
 * happens at run time now, against the deployed build, because a grep across
 * two source trees is not a check at all.
 *
 * What it can do, and what this file does, is make sure the app keeps its own
 * side: every action the reducer performs has a control a person could press,
 * every control is announced through the contract, and nothing here quietly
 * offers an agent something a person cannot do.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = readFileSync(path.join(ROOT, "components/MailApp.tsx"), "utf8");
const AUTOMATION = readFileSync(path.join(ROOT, "lib/mail/automation.ts"), "utf8");

/** Every test id the interface renders, including the templated ones. */
function rendered(): Set<string> {
  const ids = new Set<string>();
  for (const [, id] of APP.matchAll(/data-testid="([^"]+)"/g)) ids.add(id);
  for (const [, tpl] of APP.matchAll(/data-testid=\{`([^`]+)`\}/g)) {
    if (tpl.includes("${id}") && tpl.startsWith("folder-")) {
      for (const folder of FOLDER_ORDER) ids.add(`folder-${folder}`);
    } else {
      ids.add(tpl.replace(/\$\{[^}]+\}/g, "*"));
    }
  }
  return ids;
}

test("every folder in the world has a control in the rail", () => {
  // A folder an agent is asked about and cannot reach is not a hard task, it is
  // an unreachable one. `spam` was missing once and two tasks were impossible.
  const ids = rendered();
  for (const folder of FOLDER_ORDER) {
    assert.ok(ids.has(`folder-${folder}`), `no control for the ${folder} folder`);
  }
});

test("the rail is derived from the folder list, not written out again", () => {
  // Two lists that must agree is one list that will not.
  assert.match(APP, /FOLDER_ORDER\.map/, "the rail should be generated from FOLDER_ORDER");
  assert.match(APP, /data-testid=\{`folder-\$\{id\}`\}/, "and each button keyed by folder id");
});

test("the controls an agent needs are all on screen", () => {
  const ids = rendered();
  for (const id of ["mail-list", "search", "search-clear", "compose", "reader-label-add"]) {
    assert.ok(ids.has(id), `the interface renders no "${id}"`);
  }
});

test("an action with no control is refused by the reducer, not quietly performed", () => {
  /*
   * The failure this exists for: the reducer performed `forward` and `mark_read`
   * while the interface had no control for either. An agent driving the reducer
   * could do things no person using this app can do, which makes the two
   * different worlds and any score from one meaningless about the other.
   */
  const state = seedState();
  const target = state.emails[0]!.id;

  for (const [name, args] of [
    ["forward", { id: target, to: "someone@example.com" }],
    ["mark_read", { id: target }],
  ] as const) {
    const result = applyAction(state, { name, args });
    assert.equal(result.ok, false, `${name} was performed, and there is no control for it`);
    assert.ok(result.error, `${name} failed without saying why`);
  }
});

test("the contract announces what is rendered, so a driver can check it", () => {
  /*
   * The harness reads this at the start of every run and refuses to spend a
   * turn if a control it needs is absent. That check replaced a test which read
   * the harness's source — impossible once the two repositories separated, and
   * weaker anyway: this one answers for the build that is deployed rather than
   * for the source somebody read.
   */
  assert.match(AUTOMATION, /controls\(\)/, "the contract does not announce controls");
  assert.match(
    AUTOMATION,
    /querySelectorAll\("\[data-testid\]"\)/,
    "controls() must report what is actually rendered, not a hand-written list",
  );
});

test("the reducer offers exactly the vocabulary the app can perform", () => {
  // A sanity floor: the action list is what the harness builds a prompt from,
  // so an empty or truncated one would silently shrink what a model may try.
  assert.ok(ACTION_NAMES.length >= 18, `only ${ACTION_NAMES.length} actions`);
  assert.ok(ACTION_NAMES.includes("open_folder"), "navigation must be possible");
  assert.ok(ACTION_NAMES.includes("search"), "search must be possible");
});

test("Save draft files a draft, rather than rewriting the open composer", () => {
  /*
   * The button dispatched `compose`, which sets the *open* composer and nothing
   * else. Clicking Save did nothing a person could see: the composer stayed
   * open, the drafts folder stayed the same size, and Discard threw the work
   * away. It also left an agent asked to save a draft with no durable change to
   * be graded on, because `composer` is gone the moment the composer closes and
   * a verdict is computed from the final snapshot.
   */
  assert.match(
    APP,
    /data-testid="composer-save"[\s\S]{0,400}?name: "save_draft"/,
    "the Save button does not file the draft",
  );

  const before = seedState().emails.filter((e) => e.folder === "drafts").length;
  const opened = applyAction(seedState(), {
    name: "compose",
    args: { to: "a@b.example", subject: "Later", body: "half a thought" },
  });
  const saved = applyAction(opened.state, { name: "save_draft", args: {} });

  assert.equal(saved.ok, true, "save_draft was refused with a draft open");
  assert.equal(
    saved.state.emails.filter((e) => e.folder === "drafts").length,
    before + 1,
    "the draft never reached the drafts folder",
  );
  assert.equal(saved.state.composer, null, "the composer stayed open after saving");
});

test("every control the composer offers leads somewhere", () => {
  // A button wired to an action that does not do what the button says is worse
  // than a missing button: the missing one is discoverable.
  for (const [id, action] of [
    ["composer-send", "send"],
    ["composer-save", "save_draft"],
    ["composer-discard", "discard"],
  ] as const) {
    assert.match(
      APP,
      new RegExp(`data-testid="${id}"[\\s\\S]{0,400}?name: "${action}"`),
      `${id} does not dispatch ${action}`,
    );
  }
});
