/**
 * Running one evaluation in the computer-use action space.
 *
 * Kept apart from the semantic loop on purpose. The two share a task, a golden
 * state and a grader, and nothing else: this one hands the model a picture and
 * takes coordinates back, and every difference between them is a difference in
 * what is being measured. Folding them into one function with a flag would hide
 * that, and the comparison between the two is the entire reason both exist.
 */

import { parseTurn } from "../agent/parse.ts";
import type { GymClient } from "../bridge.ts";
import { CAPTURE } from "../gym/capture.ts";
import { type Viewport, computerPrompt, describeResolution, resolvePoint } from "../gym/computer.ts";
import { type Grade, grade } from "../gym/grade.ts";
import type { MailState } from "../gym/state.ts";
import type { Task } from "../gym/tasks.ts";
import { freshSeed, turnsFor } from "../gym/tasks.ts";
import type { ActionStatus, TimelineEntry, Usage } from "./entries.ts";
import { usageOf } from "./entries.ts";
import type { RunRecord, RunStatus } from "./runs.ts";

const MAX_SILENT = 3;
/** How long to wait for the screen to be photographed before giving up on it. */
const SHOT_MS = 5_000;

const VIEWPORT: Viewport = {
  width: CAPTURE.width,
  height: CAPTURE.height,
  imageWidth: CAPTURE.imageWidth,
  imageHeight: CAPTURE.imageHeight,
};

function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, number>;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return { input, output, total: u.total_tokens ?? input + output };
}

export interface ExecuteComputerOptions {
  task: Task;
  model: string;
  runId: string;
  client: GymClient;
  signal?: AbortSignal;
  onEntry?: (entries: TimelineEntry[]) => void;
}

export async function executeComputer(options: ExecuteComputerOptions): Promise<RunRecord> {
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
  // Declared before the first finish(), which closes over it.
  let state: MailState | null = null;

  // Screenshots arrive on their own message after the reply they belong to.
  const shots = new Map<number, string>();
  const waiting = new Map<number, (shot: string) => void>();
  client.shots((id, shot) => {
    shots.set(id, shot);
    waiting.get(id)?.(shot);
    waiting.delete(id);
  });

  function shotFor(requestId: number): Promise<string | null> {
    const existing = shots.get(requestId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve(null);
      }, SHOT_MS);
      waiting.set(requestId, (shot) => {
        clearTimeout(timer);
        resolve(shot);
      });
    });
  }

  const resetId = client.nextId;
  const seeded = await client.reset(freshSeed(task)).catch(() => null);
  if (!seeded) {
    return finish("infrastructure_error", "The environment did not accept the starting state.");
  }
  state = seeded.state;

  let screen = await shotFor(resetId);
  if (!screen) {
    // Without a picture there is no observation at all, so there is nothing to
    // ask the model. That is an environment failure, not a model one.
    return finish("infrastructure_error", "The environment could not be photographed.");
  }

  const system = computerPrompt(VIEWPORT);
  // Only the current screenshot is ever sent. Carrying every past frame would
  // multiply the token bill by the turn count for a picture the model has
  // already acted on, and free-tier context is the binding constraint here.
  const history: string[] = [];
  let silent = 0;

  const maxTurns = turnsFor(task, "computer");

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return finish("cancelled");
    turns = turn;

    const askedAt = Date.now();
    let content = "";
    let usage: Usage = { input: 0, output: 0, total: 0 };
    let cost = 0;
    let answeredBy: string | undefined;
    let reasoning: string | undefined;

    const instruction = [
      `Task: ${task.prompt}`,
      history.length ? `\nWhat you have done so far:\n${history.join("\n")}` : "",
      `\nThis is the screen now. Reply with one JSON action.`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          mode: "computer",
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                { type: "text", text: instruction },
                { type: "image_url", image_url: { url: screen } },
              ],
            },
          ],
        }),
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
      reasoning = typeof data.reasoning === "string" && data.reasoning ? data.reasoning : undefined;
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
      reasoning,
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
      history.push(`turn ${turn}: replied without an action`);
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
        screenshot: screen,
        metadata: {},
      });
      return finish("completed");
    }

    const { x, y } = parsed.action.args as { x?: unknown; y?: unknown };
    const point =
      typeof x === "number" && typeof y === "number" ? resolvePoint(x, y, VIEWPORT) : null;

    const requestId = client.nextId;
    const reply = await client
      .computer({ name: parsed.action.name, args: parsed.action.args ?? {} }, VIEWPORT)
      .catch(() => null);
    if (!reply) return finish("infrastructure_error", "The environment stopped answering.");

    const actionStatus: ActionStatus = reply.ok ? "applied" : "rejected";

    push({
      id: `${runId}-t${turn}-act`,
      entry_type: "action",
      turn,
      at: Date.now(),
      action_name: parsed.action.name,
      args: parsed.action.args ?? {},
      status: actionStatus,
      error: reply.error,
      requestId,
      metadata: {
        // Written down rather than applied silently: which convention the
        // numbers were read as is a judgement, and a judgement that cannot be
        // reviewed is indistinguishable from a bug.
        point: point
          ? {
              raw: point.raw,
              convention: point.convention,
              css: { x: Math.round(point.x), y: Math.round(point.y) },
              label: describeResolution(point),
              outOfBounds: point.outOfBounds,
            }
          : undefined,
        hit: reply.hit,
      },
    });

    state = reply.state;
    history.push(
      `turn ${turn}: ${parsed.action.name}${point ? ` at ${describeResolution(point)}` : ""} → ${
        reply.ok ? `hit ${reply.hit ?? "something"}` : (reply.error ?? "failed")
      }`,
    );

    const next = await shotFor(requestId);
    if (next) screen = next;
  }

  return finish("max_turns");

  function finish(nextStatus: RunStatus, nextDetail?: string): RunRecord {
    status = nextStatus;
    detail = nextDetail;
    const scored = status !== "infrastructure_error" && status !== "config_error";
    if (scored) verdict = grade(task.seed, task.golden, state ?? task.seed);
    const sum = usageOf(entries);

    return {
      id: runId,
      taskId: task.id,
      taskTitle: task.title,
      model,
      runner: "browser",
      mode: "computer",
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

/** Attach the shots this loop collected onto the record it produced. */
export { VIEWPORT as COMPUTER_VIEWPORT };
