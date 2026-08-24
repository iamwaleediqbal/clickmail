/**
 * The action space.
 *
 * These are semantic actions against the application's own model, not pixel
 * clicks against a screenshot. That is a deliberate limit and it is worth being
 * straight about it: this gym measures whether a model can plan and follow
 * instructions in an application, not whether it can locate a button in an
 * image. A pixel-level gym needs a real browser driver and a machine to run it
 * on, and neither is free.
 *
 * Everything downstream of here would be identical either way, because grading
 * never looks at how a change was made.
 */

import { type Email, type MailState, clone } from "./state.ts";

export interface Action {
  name: string;
  args?: Record<string, unknown>;
}

export interface ApplyResult {
  state: MailState;
  ok: boolean;
  error?: string;
}

const FOLDERS = new Set(["inbox", "archive", "trash", "sent"]);

export const ACTION_NAMES = [
  "open",
  "star",
  "unstar",
  "mark_read",
  "mark_unread",
  "archive",
  "trash",
  "label",
  "compose",
  "reply",
  "forward",
  "send",
  "discard",
  "finish",
] as const;

export function applyAction(state: MailState, action: Action): ApplyResult {
  const next = clone(state);
  const args = action.args ?? {};
  const id = typeof args.id === "string" ? args.id : undefined;

  const find = (): Email | undefined => next.emails.find((e) => e.id === id);

  switch (action.name) {
    case "open": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      // Opening marks read. Modelled because it is the most common source of
      // an unintended state change: an agent that opens three emails looking
      // for the right one has changed three read flags.
      email.read = true;
      next.selectedId = email.id;
      return { state: next, ok: true };
    }
    case "star":
    case "unstar": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      email.starred = action.name === "star";
      return { state: next, ok: true };
    }
    case "mark_read":
    case "mark_unread": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      email.read = action.name === "mark_read";
      return { state: next, ok: true };
    }
    case "archive":
    case "trash": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      email.folder = action.name === "archive" ? "archive" : "trash";
      if (next.selectedId === email.id) next.selectedId = null;
      return { state: next, ok: true };
    }
    case "label": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      const name = String(args.name ?? "").trim();
      if (!name) return fail(state, "label needs a name");
      if (!email.labels.includes(name)) email.labels.push(name);
      email.labels.sort();
      return { state: next, ok: true };
    }
    case "compose": {
      next.composer = {
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
      };
      return { state: next, ok: true };
    }
    case "reply": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      next.composer = {
        to: email.from,
        subject: email.subject.startsWith("Re: ")
          ? email.subject
          : `Re: ${email.subject}`,
        body: String(args.body ?? ""),
      };
      return { state: next, ok: true };
    }
    case "forward": {
      const email = find();
      if (!email) return fail(state, `no email with id ${id}`);
      const to = String(args.to ?? "").trim();
      if (!to) return fail(state, "forward needs a recipient");
      next.composer = {
        to,
        subject: email.subject.startsWith("Fwd: ")
          ? email.subject
          : `Fwd: ${email.subject}`,
        body: String(args.body ?? email.body),
      };
      return { state: next, ok: true };
    }
    case "send": {
      if (!next.composer) return fail(state, "nothing to send");
      if (!next.composer.to.trim()) return fail(state, "no recipient");
      next.emails.push({
        id: `sent-${next.emails.length + 1}`,
        from: "you@clickgym.example",
        to: next.composer.to,
        subject: next.composer.subject,
        body: next.composer.body,
        receivedAt: "2026-08-24T00:00:00Z",
        folder: "sent",
        read: true,
        starred: false,
        labels: [],
      });
      next.composer = null;
      return { state: next, ok: true };
    }
    case "discard": {
      next.composer = null;
      return { state: next, ok: true };
    }
    case "finish":
      return { state: next, ok: true };
    default:
      return fail(state, `unknown action ${action.name}`);
  }
}

function fail(state: MailState, error: string): ApplyResult {
  // The state is returned unchanged rather than partially mutated. A failed
  // action that half-applies is the worst outcome available: the run continues
  // from a world nobody described.
  return { state, ok: false, error };
}

export function isFolder(value: unknown): value is string {
  return typeof value === "string" && FOLDERS.has(value);
}
