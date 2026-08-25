import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ACTION_NAMES, applyAction } from "../lib/gym/actions.ts";
import { SYSTEM_PROMPT } from "../lib/gym/serialize.ts";
import { FOLDER_ORDER, seedState } from "../lib/gym/state.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/**
 * Does every control the driver reaches for actually exist?
 *
 * `solvable.test.ts` proves the reducer can reach each golden state. That is a
 * different claim from "a browser can perform this task", and the difference is
 * where every bug in this project has lived: a scraper reading class names that
 * had been renamed, a driver clicking a `label` control the interface never
 * had, a reducer performing `forward` with no button on screen.
 *
 * These cross-check the three layers against each other without a browser. They
 * cannot prove a click lands — only a real run does that — but they catch every
 * mismatch that has actually occurred here.
 */

const APP = read("components/MailApp.tsx");
const DRIVER = read("runner/driver.ts");
const ACTIONS = read("lib/gym/actions.ts");

/**
 * The folders the rail actually offers, read out of the component.
 *
 * Parsed rather than imported because pulling a .tsx into a plain node test
 * would need a build step, and this suite deliberately has none.
 */
const RAIL_FOLDERS = [
  ...APP.slice(APP.indexOf("const FOLDER_LOOK"), APP.indexOf("const FOLDERS"))
    .matchAll(/^\s{2}([a-z]+): \{ label:/gm),
].map((m) => m[1]);

/**
 * Declared so an agent can discover they are unavailable, and never performed.
 * `forward` is the whole point of one task; `mark_read` has no control because
 * opening a message is how it becomes read.
 */
const DECLARED_UNAVAILABLE = ["forward", "mark_read"];

/** Test ids the interface renders, including the templated per-message ones. */
function renderedTestIds(): { fixed: Set<string>; templated: Set<string> } {
  const fixed = new Set<string>();
  const templated = new Set<string>();

  for (const [, id] of APP.matchAll(/data-testid="([^"]+)"/g)) fixed.add(id);
  for (const [, tpl] of APP.matchAll(/data-testid=\{`([^`]+)`\}/g)) {
    // `open-${email.id}` → prefix "open-"
    templated.add(tpl.replace(/\$\{[^}]+\}/g, ""));
  }
  return { fixed, templated };
}

/** Test ids the browser driver clicks or fills. */
function drivenTestIds(): string[] {
  const found = new Set<string>();
  for (const [, id] of DRIVER.matchAll(/click\(page,\s*[`"]([^`"$]+)[`"]\)/g)) found.add(id);
  for (const [, id] of DRIVER.matchAll(/getByTestId\("([^"]+)"\)/g)) found.add(id);
  // Templated: click(page, `open-${id}`) and the control lookup table.
  for (const [, prefix] of DRIVER.matchAll(/click\(page,\s*`([a-z-]+)-\$\{/g)) {
    found.add(`${prefix}-`);
  }
  for (const [, id] of DRIVER.matchAll(/^\s+[a-z_]+: "([a-z-]+)",$/gm)) found.add(id);
  return [...found];
}

test("the interface renders every control the driver operates", () => {
  const { fixed, templated } = renderedTestIds();
  const missing = drivenTestIds().filter(
    (id) => !fixed.has(id) && ![...templated].some((prefix) => id === prefix),
  );

  assert.deepEqual(
    missing,
    [],
    `the browser driver reaches for controls the interface does not render: ${missing.join(", ")}`,
  );
});

test("every action the reducer performs has a control on screen", () => {
  // The mirror of the above: a reducer richer than the interface lets an agent
  // driving it directly do things no person using the app can.
  const performed = [...ACTIONS.matchAll(/^\s{4}case "([a-z_]+)":/gm)].map((m) => m[1]);
  assert.ok(performed.length > 5, "the action list should have parsed");

  for (const name of performed) {
    if (DECLARED_UNAVAILABLE.includes(name)) continue;
    assert.match(
      DRIVER,
      new RegExp(`case "${name}"`),
      `${name} is performed by the reducer but the browser driver cannot reach it`,
    );
  }
});

test("actions with no control are refused by the reducer, not merely undocumented", () => {
  // Checked by calling it rather than by reading it. The previous version of
  // this test scanned the source for `return fail(` and passed on any code that
  // happened to contain those words — including an implementation that went on
  // to perform the action anyway.
  const seed = seedState();

  for (const name of DECLARED_UNAVAILABLE) {
    const before = JSON.stringify(seed);
    const result = applyAction(seed, {
      name,
      args: { id: "m1", to: "someone@elsewhere.example" },
    });

    assert.equal(result.ok, false, `${name} has no control, so it must be refused`);
    assert.equal(
      JSON.stringify(result.state),
      before,
      `${name} was refused but still changed the mailbox`,
    );
  }
});

test("reading-pane controls are opened before they are used", () => {
  // The environment's stated contract: a control that only exists once a
  // message is open cannot be used without opening it, for every driver alike.
  for (const name of ["archive", "trash", "spam", "not_spam", "restore", "delete_forever", "label"]) {
    const start = DRIVER.indexOf(`case "${name}"`);
    assert.ok(start > 0, `${name} should be handled`);

    // Bounded at the end of the block that actually runs. A fixed-width window
    // bled into the following case and found an `open` belonging to a different
    // action, so the test passed while the control it names went unopened.
    const body = DRIVER.slice(start);
    const end = body.indexOf("return ", body.indexOf("{"));
    const block = body.slice(0, end > 0 ? end : 400);

    assert.match(
      block,
      /click\(page, `open-\$\{id\}`\)/,
      `${name} lives in the reading pane, so the driver must open the message first`,
    );
  }
});

test("the folder rail renders a control for every folder that exists", () => {
  /*
   * The one the static checks missed and a paid run found.
   *
   * The rail was a hand-written array of five while the world had seven, so
   * `folder-spam` did not exist and every task about spam was unreachable. The
   * previous version of this test only asserted that the rail was rendered from
   * *a* list — never that the list was complete.
   */
  assert.ok(RAIL_FOLDERS.length > 0, "the rail's folder table should have parsed");
  assert.deepEqual(
    [...FOLDER_ORDER].sort(),
    [...RAIL_FOLDERS].sort(),
    "every folder in the world needs a button in the rail",
  );

  assert.match(APP, /data-testid=\{`folder-\$\{id\}`\}/, "the rail is rendered from that list");
  assert.match(DRIVER, /click\(page, `folder-\$\{folder\}`\)/, "and the driver clicks it");
});

test("the rail is derived from the folder list, not written out again", () => {
  // Deriving it is what makes the omission above impossible to repeat: a new
  // folder without a button is a type error, not a task nobody can complete.
  assert.match(APP, /FOLDER_ORDER\.map\(/, "the rail must be built from FOLDER_ORDER");
  assert.match(
    APP,
    /Record<Folder, \{ label: string; Icon/,
    "and the lookup must be total, so a missing folder fails to compile",
  );
});

test("the search box the actions rely on is rendered and driven", () => {
  assert.match(APP, /data-testid="search"/);
  assert.match(DRIVER, /getByTestId\("search"\)/);
});

/* -------------------------------------------------------------------- */
/* What the model is told it can do                                      */
/* -------------------------------------------------------------------- */

test("the model is told about every action the reducer accepts", () => {
  /*
   * The omission that cost two paid runs.
   *
   * `spam`, `not_spam`, `restore` and `delete_forever` existed in the reducer,
   * the interface and the driver — and were absent from the prompt. An agent
   * asked to rescue a message from spam was never told the action for it
   * existed, improvised with `archive`, and was marked down for the harness's
   * omission rather than its own reasoning.
   */
  // Matched as its own line, not as a substring. `includes(name)` passed when
  // the entry was renamed to `not_spam_XX`, because that string contains the
  // one being searched for — the third time a test here proved nothing.
  const listed = new Set(
    SYSTEM_PROMPT.split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );

  for (const name of ACTION_NAMES) {
    assert.ok(listed.has(name), `${name} is a real action the model is never told about`);
  }
});

test("actions that will always fail are marked so in the prompt", () => {
  // Otherwise an agent spends turns discovering it, which is a fine thing to
  // measure once and a waste of a turn budget every time after.
  for (const name of ["forward", "mark_read"]) {
    const line = SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith(name));
    assert.ok(line, `${name} should be listed`);
    assert.match(line, /NOT AVAILABLE/, `${name} is refused, so the prompt must say so`);
  }
});

test("the prompt is generated, not written out by hand", () => {
  // Three hand-written copies of the action space is how they drifted.
  const source = read("lib/gym/serialize.ts");

  assert.match(source, /\$\{actionReference\(\)\}/, "the action list must be generated");
  assert.ok(
    !/^\s{2}archive\s+\{/m.test(source),
    "a hand-written action table must not come back",
  );
});

test("the reference page and the prompt come from the same table", () => {
  const tools = read("app/tools/page.tsx");

  assert.match(tools, /Object\.keys\(CATALOG\)/, "the page must read the catalogue");
  assert.ok(
    !/\{ name: "archive", args:/.test(tools),
    "a second hand-written table must not come back",
  );
});
