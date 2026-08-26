import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ACTION_NAMES, READING_PANE, applyAction } from "../lib/mail/actions.ts";
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

test("no ignore pattern can swallow a route", () => {
  /*
   * `.vercelignore` follows .gitignore matching: a pattern with no slash in it
   * matches a directory of that name at ANY depth. In the harness an unanchored
   * `tools/`, written to keep the mutation scripts out of the build, also
   * matched `app/tools/` — so that route was never uploaded, the nav linked to
   * a 404, and every local check passed, because the pattern was correct about
   * the directory it was named for.
   *
   * There is no colliding directory here today. The point is that adding one
   * later must not silently break the deployment.
   */
  const patterns = readFileSync(path.join(ROOT, ".vercelignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const unanchored = patterns.filter((line) => !line.startsWith("/"));
  assert.deepEqual(unanchored, [], "these match at any depth, including inside app/");
});

test("the reading pane's actions are refused while a draft covers it", () => {
  /*
   * The composer replaces the reader rather than sitting beside it — look at
   * MailApp: `state.composer ? <Composer/> : <Reader/>`. So while a draft is
   * open not one `reader-*` control is on screen, and a person has to send,
   * save or discard before reaching one again.
   *
   * The reducer performed them anyway, which is the same defect as `forward`
   * and `mark_read` above, in its conditional form: an action the reducer takes
   * that the interface offers no way to reach. Those two never have a control.
   * These have one most of the time, which is what made it easy to miss — and
   * three real agent runs hit it, each spending a turn and four seconds of
   * browser timeout on a button that could not appear.
   */
  const state = seedState();
  const target = state.emails.find((e) => e.folder === "inbox");
  assert.ok(target);

  const composing = applyAction(state, {
    name: "compose",
    args: { to: "a@b.example", subject: "draft", body: "half written" },
  });
  assert.ok(composing.state.composer, "the fixture has no draft open, so this proves nothing");

  for (const name of READING_PANE) {
    const result = applyAction(composing.state, {
      name,
      args: { id: target.id, name: "finance", to: "x@y.example" },
    });
    assert.equal(result.ok, false, `${name} was performed while a draft covered its control`);
    assert.match(String(result.error), /draft is open/, `${name} failed without saying why`);
  }

  // The draft survives being refused. Losing it would be worse than the bug.
  const after = applyAction(composing.state, { name: "archive", args: { id: target.id } });
  assert.deepEqual(after.state.composer, composing.state.composer);
});

test("every action refused while composing has a control in the reading pane", () => {
  // The list is written out, so it is checked against what the reader actually
  // renders rather than against itself. `reader-*` ids only exist inside the
  // Reader, which is precisely the thing the composer replaces.
  const ids = rendered();
  for (const name of READING_PANE) {
    const control =
      name === "reply" ? "reader-reply" :
      name === "mark_unread" ? "reader-unread" :
      name === "label" ? "reader-label-add" :
      `reader-${name.replace(/_/g, "-")}`;
    assert.ok(ids.has(control), `${name} is refused while composing but has no "${control}" to be blocked from`);
  }
});

test("the README's mutation list is the list the tool actually runs", () => {
  // Two lists of the same thing, in different files, is one list and one lie
  // waiting to happen — this one was already a case short. A reader counting
  // the bullet points is counting something real or they are not.
  const root = path.join(import.meta.dirname, "..");
  const tool = readFileSync(path.join(root, "tools", "mail-mutation-check.py"), "utf8");
  const readme = readFileSync(path.join(root, "README.md"), "utf8");

  const cases = [...tool.matchAll(/^ {4}\("([^"]+)",/gm)].map((m) => m[1]);
  assert.ok(cases.length >= 10, "the mutation cases should still be parseable");

  for (const name of cases) {
    assert.ok(readme.includes(`- ${name}`), `the README does not list "${name}"`);
  }

  const claimed = readme.match(/reintroduces (\d+) bugs/)?.[1];
  assert.equal(Number(claimed), cases.length, "the README's count disagrees with the tool");
});

test("every member the contract publishes is documented", () => {
  // A published member nobody wrote down is a member nobody can rely on, and
  // an undocumented one is how a contract stops being a contract.
  const root = path.join(import.meta.dirname, "..");
  const automation = readFileSync(path.join(root, "lib", "mail", "automation.ts"), "utf8");
  const readme = readFileSync(path.join(root, "README.md"), "utf8");

  const api = automation.slice(automation.indexOf("const api: GymAutomation = {"));
  const members = [...api.matchAll(/^ {4}(\w+)[(:]/gm)].map((m) => m[1]);

  assert.ok(members.includes("reset") && members.includes("state"), members.join(", "));
  for (const member of members) {
    assert.ok(readme.includes(member), `the README never mentions \`${member}\``);
  }
});
