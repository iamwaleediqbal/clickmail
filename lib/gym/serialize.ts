/**
 * What the agent sees.
 *
 * A compact text rendering of the mailbox rather than a screenshot. Every email
 * carries the id the actions take, so the model never has to guess a handle,
 * and the format is stable between turns so a model can tell what changed.
 *
 * Bodies are truncated. A model that needs the full text can open the email,
 * and paying for four full bodies on every turn of every attempt is how a free
 * quota disappears before lunch.
 */

import type { MailState } from "./state.ts";

const BODY_PREVIEW = 140;

export function serialize(state: MailState): string {
  const lines: string[] = [];
  const folders = ["inbox", "archive", "trash", "sent"] as const;

  for (const folder of folders) {
    const emails = state.emails.filter((e) => e.folder === folder);
    if (!emails.length) continue;
    lines.push(`## ${folder} (${emails.length})`);
    for (const email of emails) {
      const flags = [
        email.read ? "read" : "unread",
        email.starred ? "starred" : null,
        email.labels.length ? `labels=${email.labels.join(",")}` : null,
        state.selectedId === email.id ? "open" : null,
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`[${email.id}] from=${email.from} to=${email.to}`);
      lines.push(`  subject: ${email.subject}`);
      lines.push(`  ${flags}`);
      const body =
        state.selectedId === email.id
          ? email.body
          : email.body.slice(0, BODY_PREVIEW) +
            (email.body.length > BODY_PREVIEW ? "..." : "");
      lines.push(`  body: ${body.replace(/\n+/g, " ")}`);
    }
    lines.push("");
  }

  if (state.composer) {
    lines.push("## composer (unsent)");
    lines.push(`  to: ${state.composer.to}`);
    lines.push(`  subject: ${state.composer.subject}`);
    lines.push(`  body: ${state.composer.body || "(empty)"}`);
  } else {
    lines.push("## composer: closed");
  }

  return lines.join("\n").trim();
}

export const SYSTEM_PROMPT = `You are operating an email client.

Reply with exactly one JSON object and nothing else:
{"thought": "one short sentence", "action": {"name": "...", "args": {...}}}

Actions:
  open        {"id"}
  star        {"id"}
  unstar      {"id"}
  mark_read   {"id"}
  mark_unread {"id"}
  archive     {"id"}
  trash       {"id"}
  label       {"id", "name"}
  reply       {"id", "body"}          opens the composer, addressed for you
  forward     {"id", "to", "body"}    opens the composer
  compose     {"to", "subject", "body"}
  send        {}                      sends whatever is in the composer
  discard     {}
  finish      {}                      you are done

Rules:
  One action per reply.
  Opening an email marks it read. That is a change to the mailbox.
  Do only what the task asks. Extra tidying counts against you.
  Call finish when the task is complete.`;
