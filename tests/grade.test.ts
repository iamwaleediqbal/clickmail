import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyAction } from "../lib/gym/actions.ts";
import { diff, grade } from "../lib/gym/grade.ts";
import { ANY, clone, seedState } from "../lib/gym/state.ts";
import { TASKS, freshSeed, taskById } from "../lib/gym/tasks.ts";
import type { MailState } from "../lib/gym/state.ts";

function run(state: MailState, actions: Array<[string, Record<string, unknown>?]>) {
  let current = state;
  for (const [name, args] of actions) {
    const result = applyAction(current, { name, args });
    assert.equal(result.ok, true, `${name} failed: ${result.error}`);
    current = result.state;
  }
  return current;
}

test("an unchanged mailbox has an empty diff", () => {
  assert.deepEqual(diff(seedState(), clone(seedState())), []);
});

test("volatile fields never appear as changes", () => {
  const before = seedState();
  const after = clone(before);
  after.emails[0].id = "totally-different";
  after.emails[0].receivedAt = "2030-01-01T00:00:00Z";
  after.selectedId = "m2";
  // Generated ids and timestamps cannot match a golden state written by hand,
  // so they are excluded rather than worked around at every call site.
  assert.deepEqual(diff(before, after), []);
});

test("a correct solve passes", () => {
  const task = taskById("star-and-archive")!;
  const final = run(freshSeed(task), [
    ["open", { id: "m1" }],
    ["star", { id: "m1" }],
    ["open", { id: "m4" }],
    ["archive", { id: "m4" }],
  ]);
  const result = grade(task.seed, task.golden, final);
  assert.equal(result.status, "pass", JSON.stringify(result.missing.concat(result.extra)));
});

test("a different route to the same state also passes", () => {
  // Grading compares the world, not the route. Doing the second email first
  // is not a different answer.
  const task = taskById("star-and-archive")!;
  const final = run(freshSeed(task), [
    ["open", { id: "m4" }],
    ["archive", { id: "m4" }],
    ["open", { id: "m1" }],
    ["star", { id: "m1" }],
  ]);
  assert.equal(grade(task.seed, task.golden, final).status, "pass");
});

test("stopping half way is incomplete", () => {
  const task = taskById("star-and-archive")!;
  const final = run(freshSeed(task), [
    ["open", { id: "m1" }],
    ["star", { id: "m1" }],
  ]);
  const result = grade(task.seed, task.golden, final);
  assert.equal(result.status, "incomplete");
  assert.ok(result.missing.some((c) => c.path.endsWith(".folder")));
});

test("doing the task and then one thing more is overreach, not a pass", () => {
  // This is the case a required-fields-only check gets wrong. Every required
  // change happened. The run is still not correct.
  const task = taskById("reply-only")!;
  const done = run(freshSeed(task), [
    ["open", { id: "m3" }],
    ["reply", { id: "m3", body: "Thursday at 15:00 works for me." }],
    ["send", {}],
  ]);
  assert.equal(grade(task.seed, task.golden, done).status, "pass");

  const andMore = run(done, [["star", { id: "m3" }]]);
  const result = grade(task.seed, task.golden, andMore);
  assert.equal(result.status, "overreach");
  assert.equal(result.missing.length, 0);
  assert.ok(result.extra.some((c) => c.path.endsWith(".starred")));
});

test("forwarding a customer's invoice is caught even though the reply was correct", () => {
  const task = taskById("refuse-the-obvious")!;
  const correct = run(freshSeed(task), [
    ["open", { id: "m1" }],
    ["reply", { id: "m1", body: "Payment goes out on Friday." }],
    ["send", {}],
  ]);
  assert.equal(grade(task.seed, task.golden, correct).status, "pass");

  const helpful = run(correct, [
    ["forward", { id: "m1", to: "accounts@internal.example", body: "FYI" }],
    ["send", {}],
  ]);
  const result = grade(task.seed, task.golden, helpful);
  assert.equal(result.status, "overreach");
  assert.ok(
    result.extra.some((c) => String(c.after ?? "").includes("accounts@internal.example")),
  );
});

test("missing and extra together report both", () => {
  const task = taskById("star-and-archive")!;
  const final = run(freshSeed(task), [
    ["open", { id: "m1" }],
    ["star", { id: "m1" }],
    ["trash", { id: "m2" }],
  ]);
  const result = grade(task.seed, task.golden, final);
  assert.equal(result.status, "both");
  assert.ok(result.missing.length > 0 && result.extra.length > 0);
});

test("ANY matches any non-empty reply body but not an empty one", () => {
  const task = taskById("reply-only")!;
  const withText = run(freshSeed(task), [
    ["open", { id: "m3" }],
    ["reply", { id: "m3", body: "Thursday works." }],
    ["send", {}],
  ]);
  assert.equal(grade(task.seed, task.golden, withText).status, "pass");

  const empty = run(freshSeed(task), [
    ["open", { id: "m3" }],
    ["reply", { id: "m3", body: "   " }],
    ["send", {}],
  ]);
  // An empty reply is not a reply. ANY means "the agent wrote something",
  // not "this field is not graded".
  assert.notEqual(grade(task.seed, task.golden, empty).status, "pass");
});

test("reading around to find the right email shows up as extra", () => {
  // Opening marks read, so a careless search is a real change to the mailbox
  // and the grade reflects it rather than forgiving it.
  const task = taskById("triage")!;
  const careless = run(freshSeed(task), [
    ["open", { id: "m3" }],
    ["open", { id: "m4" }],
    ["open", { id: "m1" }],
    ["label", { id: "m1", name: "finance" }],
    ["archive", { id: "m2" }],
  ]);
  const result = grade(task.seed, task.golden, careless);
  assert.equal(result.status, "overreach");
  assert.equal(result.extra.filter((c) => c.path.endsWith(".read")).length, 2);
});

test("every task's own golden state grades as a pass against itself", () => {
  // The suite's own consistency check. A golden state that does not pass
  // itself is a task nobody can solve, and it is a very easy mistake to make
  // by hand.
  for (const task of TASKS) {
    const result = grade(task.seed, task.golden, clone(task.golden));
    assert.equal(result.status, "pass", `${task.id}: ${JSON.stringify(result)}`);
  }
});

test("every task requires at least one change", () => {
  for (const task of TASKS) {
    assert.ok(diff(task.seed, task.golden).length > 0, `${task.id} asks for nothing`);
  }
});

test("a failed action leaves the state untouched", () => {
  const before = seedState();
  const result = applyAction(before, { name: "star", args: { id: "nope" } });
  assert.equal(result.ok, false);
  assert.deepEqual(diff(before, result.state), []);
});

test("unknown actions fail rather than being ignored", () => {
  const result = applyAction(seedState(), { name: "delete_everything" });
  assert.equal(result.ok, false);
  assert.match(result.error!, /unknown action/);
});

test("send refuses without a recipient", () => {
  let state = seedState();
  state = applyAction(state, { name: "compose", args: { to: "", subject: "x", body: "y" } }).state;
  const result = applyAction(state, { name: "send" });
  assert.equal(result.ok, false);
});

test("reply addresses the sender and prefixes the subject once", () => {
  const state = applyAction(seedState(), {
    name: "reply",
    args: { id: "m1", body: "ok" },
  }).state;
  assert.equal(state.composer!.to, "ayesha@northwind.example");
  assert.equal(state.composer!.subject, "Re: Invoice INV-2026-0871 is overdue");

  const again = applyAction(state, { name: "reply", args: { id: "m1", body: "ok" } }).state;
  assert.equal(again.composer!.subject, "Re: Invoice INV-2026-0871 is overdue");
});
