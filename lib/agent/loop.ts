/**
 * The agent loop. Runs in the browser.
 *
 * Every turn: serialise the mailbox, ask the model for one action, apply it,
 * repeat. The loop reports why it stopped, using the same distinctions the
 * evaluation platform this is modelled on uses, because "it failed" is not a
 * finding and "it stopped emitting actions on turn three" is.
 */

import { type Action, applyAction } from "../gym/actions.ts";
import { SYSTEM_PROMPT, serialize } from "../gym/serialize.ts";
import type { MailState } from "../gym/state.ts";

export type Stop =
  | "finished"
  | "max_turns"
  | "no_action"
  | "transport_error"
  | "cancelled";

export interface Step {
  turn: number;
  thought: string;
  action: Action | null;
  applied: boolean;
  error?: string;
  raw: string;
}

export interface RunOutcome {
  state: MailState;
  steps: Step[];
  stop: Stop;
  detail?: string;
}

const MAX_NO_ACTION = 3;

export async function runAgent(options: {
  model: string;
  prompt: string;
  initial: MailState;
  maxTurns?: number;
  signal?: AbortSignal;
  onStep?: (step: Step, state: MailState) => void;
}): Promise<RunOutcome> {
  const { model, prompt, initial, maxTurns = 12, signal, onStep } = options;
  let state = initial;
  const steps: Step[] = [];
  const transcript: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Task: ${prompt}\n\nMailbox:\n${serialize(state)}` },
  ];
  let noActionStreak = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { state, steps, stop: "cancelled" };

    let content: string;
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: transcript }),
        signal,
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 502) {
          return { state, steps, stop: "transport_error", detail: data.detail };
        }
        return { state, steps, stop: "transport_error", detail: data.error };
      }
      content = String(data.content ?? "");
    } catch (error) {
      if (signal?.aborted) return { state, steps, stop: "cancelled" };
      return { state, steps, stop: "transport_error", detail: String(error) };
    }

    const parsed = parseTurn(content);
    const step: Step = {
      turn,
      thought: parsed.thought,
      action: parsed.action,
      applied: false,
      raw: content,
    };

    if (!parsed.action) {
      // A model that narrates instead of acting is a specific failure and
      // gets its own stop reason rather than being folded into "ran out".
      noActionStreak += 1;
      step.error = parsed.error ?? "no action in reply";
      steps.push(step);
      onStep?.(step, state);
      if (noActionStreak >= MAX_NO_ACTION) {
        return { state, steps, stop: "no_action" };
      }
      transcript.push({ role: "assistant", content });
      transcript.push({
        role: "user",
        content: "That reply contained no action. Reply with one JSON action object.",
      });
      continue;
    }

    noActionStreak = 0;
    if (parsed.action.name === "finish") {
      step.applied = true;
      steps.push(step);
      onStep?.(step, state);
      return { state, steps, stop: "finished" };
    }

    const result = applyAction(state, parsed.action);
    step.applied = result.ok;
    step.error = result.error;
    state = result.state;
    steps.push(step);
    onStep?.(step, state);

    transcript.push({ role: "assistant", content });
    transcript.push({
      role: "user",
      content: result.ok
        ? `Done. Mailbox now:\n${serialize(state)}`
        : `That action failed: ${result.error}\n\nMailbox:\n${serialize(state)}`,
    });
  }

  return { state, steps, stop: "max_turns" };
}

/**
 * Read one turn.
 *
 * Models fence JSON, prefix it with prose, and occasionally emit two objects.
 * Extracting the first balanced object is more forgiving than JSON.parse on
 * the whole string and less forgiving than a regex that would match text
 * inside the thought field.
 */
export function parseTurn(raw: string): {
  thought: string;
  action: Action | null;
  error?: string;
} {
  const candidate = firstObject(raw);
  if (!candidate) return { thought: "", action: null, error: "no JSON object found" };

  try {
    const parsed = JSON.parse(candidate) as {
      thought?: unknown;
      action?: { name?: unknown; args?: unknown };
    };
    const name = parsed.action?.name;
    if (typeof name !== "string") {
      return { thought: String(parsed.thought ?? ""), action: null, error: "no action name" };
    }
    return {
      thought: String(parsed.thought ?? ""),
      action: {
        name,
        args:
          parsed.action?.args && typeof parsed.action.args === "object"
            ? (parsed.action.args as Record<string, unknown>)
            : {},
      },
    };
  } catch (error) {
    // Truncated JSON is a model failure. Recording it as one, rather than
    // throwing, keeps it in the timeline where it belongs.
    return { thought: "", action: null, error: `unparseable: ${String(error)}` };
  }
}

function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
