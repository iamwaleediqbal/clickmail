/**
 * Executing one evaluation and recording it as a timeline.
 *
 * The loop asks the model, records the reply, records the reasoning, performs
 * the action against the environment, and records what the environment said
 * back. Each of those is its own entry, because "the run failed" is not a
 * finding and "it reasoned correctly then called a control that does not
 * exist" is.
 */

import { parseTurn } from "../agent/parse.ts";
import type { GymClient } from "../bridge.ts";
import { type Grade, grade } from "../gym/grade.ts";
import { SYSTEM_PROMPT, serialize } from "../gym/serialize.ts";
import type { MailState } from "../gym/state.ts";
import type { Task } from "../gym/tasks.ts";
import { freshSeed, turnsFor } from "../gym/tasks.ts";
import type { ActionStatus, TimelineEntry, Usage } from "./entries.ts";
import { usageOf } from "./entries.ts";
import type { RunRecord, RunStatus } from "./runs.ts";

const MAX_SILENT = 3;

function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, number>;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return { input, output, total: u.total_tokens ?? input + output };
}

/** Controls the interface genuinely does not offer, versus ones that misfired. */
const NO_CONTROL = new Set(["forward", "label"]);

export interface ExecuteOptions {
  task: Task;
  model: string;
  runId: string;
  client: GymClient;
  signal?: AbortSignal;
  onEntry?: (entries: TimelineEntry[]) => void;
}

export async function execute(options: ExecuteOptions): Promise<RunRecord> {
  const { task, model, runId, client, signal, onEntry } = options;
  const startedAt = Date.now();
  const entries: TimelineEntry[] = [];
  const push = (entry: TimelineEntry) => {
    entries.push(entry);
    onEntry?.([...entries]);
  };

  let status: RunStatus = "completed";
  let detail: string | undefined;
  let verdict: Grade | null = null;
  let turns = 0;
  // Declared before the first finish() call: that helper closes over it, and a
  // let declared further down would still be in its temporal dead zone when an
  // early failure calls finish(). TypeScript does not catch that through a
  // closure — it only throws at run time, on the unhappy path.
  let state: MailState | null = null;

  const seeded = await client.reset(freshSeed(task)).catch(() => null);
  if (!seeded) {
    return finish("infrastructure_error", "The environment did not accept the starting state.");
  }

  state = seeded.state;
  const transcript: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Task: ${task.prompt}\n\nMailbox:\n${serialize(state)}` },
  ];
  let silent = 0;

  const maxTurns = turnsFor(task, "tool");

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return finish("cancelled");
    turns = turn;

    const askedAt = Date.now();
    let content = "";
    let usage: Usage = { input: 0, output: 0, total: 0 };
    let cost = 0;
    let answeredBy: string | undefined;

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: transcript }),
        signal,
      });
      const data = await response.json();
      if (!response.ok) {
        return finish(
          // 403 is a session that lapsed, not a provider that failed. Both are
          // configuration rather than transport, and both stay unscored: an
          // attempt that never reached a model is an absent measurement.
          response.status === 401 || response.status === 403
            ? "config_error"
            : "infrastructure_error",
          String(data.detail ?? data.error ?? "The model was unreachable."),
        );
      }
      content = String(data.content ?? "");
      usage = readUsage(data.usage);
      cost = typeof data.cost === "number" ? data.cost : 0;
      answeredBy = data.model ? String(data.model) : undefined;
    } catch (error) {
      if (signal?.aborted) return finish("cancelled");
      return finish("infrastructure_error", String(error instanceof Error ? error.message : error));
    }

    const parsed = parseTurn(content);

    push({
      id: `${runId}-t${turn}-think`,
      entry_type: "model_thinking",
      turn,
      at: Date.now(),
      text: parsed.thought,
      latencyMs: Date.now() - askedAt,
      usage,
      cost,
      model: answeredBy,
    });

    push({
      id: `${runId}-t${turn}-say`,
      entry_type: "model_response",
      turn,
      at: Date.now(),
      text: content,
      parseError: parsed.action ? undefined : parsed.error,
    });

    if (!parsed.action) {
      silent += 1;
      if (silent >= MAX_SILENT) return finish("no_action");
      transcript.push({ role: "assistant", content });
      transcript.push({
        role: "user",
        content: "That reply contained no action. Reply with one JSON action object.",
      });
      continue;
    }
    silent = 0;

    if (parsed.action.name === "finish") {
      push({
        id: `${runId}-t${turn}-act`,
        entry_type: "action",
        turn,
        at: Date.now(),
        action_name: "finish",
        args: {},
        status: "terminal",
        metadata: {},
      });
      return finish("completed");
    }

    // Captured before the request goes out: the screenshot for this action
    // comes back on a later message carrying this same id.
    const requestId = client.nextId;
    const reply = await client.apply(parsed.action).catch(() => null);
    if (!reply) return finish("infrastructure_error", "The environment stopped answering.");

    const actionStatus: ActionStatus = reply.ok
      ? "applied"
      : NO_CONTROL.has(parsed.action.name)
        ? "unavailable"
        : "rejected";

    push({
      id: `${runId}-t${turn}-act`,
      entry_type: "action",
      turn,
      at: Date.now(),
      action_name: parsed.action.name,
      args: parsed.action.args ?? {},
      status: actionStatus,
      error: reply.error,
      screenshot: reply.shot,
      requestId,
      metadata: {},
    });

    state = reply.state;
    transcript.push({ role: "assistant", content });
    transcript.push({
      role: "user",
      content: reply.ok
        ? `Done. Mailbox now:\n${serialize(state)}`
        : `That action failed: ${reply.error}\n\nMailbox:\n${serialize(state)}`,
    });
  }

  return finish("max_turns");

  function finish(nextStatus: RunStatus, nextDetail?: string): RunRecord {
    status = nextStatus;
    detail = nextDetail;
    const scored = status !== "infrastructure_error" && status !== "config_error";
    if (scored) {
      verdict = grade(task.seed, task.golden, state ?? task.seed);
    }
    const sum = usageOf(entries);
    return {
      id: runId,
      taskId: task.id,
      taskTitle: task.title,
      model,
      runner: "browser",
      mode: "tool",
      status,
      detail,
      startedAt,
      durationMs: Date.now() - startedAt,
      turns,
      maxTurns,
      tokens: sum.usage,
      cost: sum.cost,
      entries,
      verdict,
    };
  }
}

/** Attach a screenshot that arrived after the action entry was written. */
/**
 * Pin captured screenshots onto the actions they show.
 *
 * Keyed by bridge request id rather than by turn. A capture takes two animation
 * frames plus rasterisation, so a picture can land after the next turn has
 * already started; matching on "the current turn" silently pinned that picture
 * to the wrong action, or dropped it when the next action did not exist yet.
 * Re-applying the whole map on every update also means a shot that arrived
 * before its entry was rendered is picked up on the next pass instead of lost.
 */
export function attachScreenshots(
  entries: TimelineEntry[],
  shots: Map<number, string>,
): TimelineEntry[] {
  if (!shots.size) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.entry_type !== "action" || entry.screenshot || entry.requestId === undefined) {
      return entry;
    }
    const shot = shots.get(entry.requestId);
    if (!shot) return entry;
    changed = true;
    return { ...entry, screenshot: shot };
  });
  return changed ? next : entries;
}
