import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ActionEntry, TimelineEntry } from "../lib/harness/entries.ts";
import { attachScreenshots } from "../lib/harness/execute.ts";

function action(turn: number, requestId?: number): ActionEntry {
  return {
    id: `t${turn}-act`,
    entry_type: "action",
    turn,
    at: turn * 1000,
    action_name: "open",
    args: { id: `m-${turn}` },
    status: "applied",
    requestId,
    metadata: {},
  };
}

function thinking(turn: number): TimelineEntry {
  return {
    id: `t${turn}-think`,
    entry_type: "model_thinking",
    turn,
    at: turn * 1000,
    text: "…",
    latencyMs: 10,
    usage: { input: 1, output: 1, total: 2 },
    cost: 0,
  };
}

function shotOf(entries: TimelineEntry[], turn: number): string | undefined {
  const entry = entries.find((e) => e.entry_type === "action" && e.turn === turn);
  return entry && entry.entry_type === "action" ? entry.screenshot : undefined;
}

test("a screenshot lands on the action whose request produced it", () => {
  const entries = [thinking(1), action(1, 2), thinking(2), action(2, 3)];
  const next = attachScreenshots(entries, new Map([[2, "shot-a"]]));

  assert.equal(shotOf(next, 1), "shot-a");
  assert.equal(shotOf(next, 2), undefined);
});

test("a late screenshot does not attach to whichever turn is current", () => {
  // The regression this guards: capture takes two frames plus rasterisation, so
  // turn 1's picture can land after turn 2's action already exists. Matching on
  // "the latest turn" pinned it to the wrong action.
  const entries = [thinking(1), action(1, 2), thinking(2), action(2, 3)];
  const next = attachScreenshots(entries, new Map([[3, "shot-b"]]));

  assert.equal(shotOf(next, 1), undefined);
  assert.equal(shotOf(next, 2), "shot-b");
});

test("a screenshot arriving before its entry is picked up on the next pass", () => {
  const shots = new Map([[3, "shot-c"]]);
  const early = attachScreenshots([thinking(1), action(1, 2)], shots);
  assert.equal(shotOf(early, 1), undefined);

  const later = attachScreenshots([...early, thinking(2), action(2, 3)], shots);
  assert.equal(shotOf(later, 2), "shot-c");
});

test("an existing screenshot is never overwritten", () => {
  const kept: ActionEntry = { ...action(1, 2), screenshot: "original" };
  const next = attachScreenshots([kept], new Map([[2, "replacement"]]));

  assert.equal(shotOf(next, 1), "original");
});

test("entries without a request id are left alone", () => {
  const next = attachScreenshots([action(1, undefined)], new Map([[2, "shot"]]));
  assert.equal(shotOf(next, 1), undefined);
});

test("no shots means the same array back, so React skips the re-render", () => {
  const entries = [thinking(1), action(1, 2)];
  assert.equal(attachScreenshots(entries, new Map()), entries);
  assert.equal(attachScreenshots(entries, new Map([[99, "unrelated"]])), entries);
});
