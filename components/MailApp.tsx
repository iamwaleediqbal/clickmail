"use client";

import {
  Archive,
  ChevronLeft,
  Clock,
  FileText,
  Inbox,
  Mail,
  PenSquare,
  Reply,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type Action, matchesQuery } from "@/lib/gym/actions";
import { FOLDER_ORDER, type Email, type Folder, type MailState } from "@/lib/gym/state";
import { cn } from "@/lib/utils";

/**
 * How each folder is shown — as a total map, and derived from FOLDER_ORDER.
 *
 * This was a hand-written array of five while the world had seven, so the spam
 * folder had no button. Every task about spam was unreachable, and the agent
 * that hit it did the right thing: retried, tested navigation against another
 * folder, searched, and concluded the folder did not exist. It was diagnosing
 * this list.
 *
 * `Record<Folder, ...>` makes the next such omission a compile error rather
 * than a run nobody can complete.
 */
const FOLDER_LOOK: Record<Folder, { label: string; Icon: typeof Inbox }> = {
  inbox: { label: "Inbox", Icon: Inbox },
  drafts: { label: "Drafts", Icon: FileText },
  outbox: { label: "Outbox", Icon: Clock },
  sent: { label: "Sent", Icon: Send },
  spam: { label: "Spam", Icon: ShieldAlert },
  archive: { label: "Archive", Icon: Archive },
  trash: { label: "Trash", Icon: Trash2 },
};

const FOLDERS = FOLDER_ORDER.map((id) => ({ id, ...FOLDER_LOOK[id] }));

/**
 * The environment's interface.
 *
 * Every control dispatches the same `Action` an agent sends, through the same
 * reducer. There is no human path and no agent path — whatever a person can do
 * here, an agent can do, and it lands in state identically. If those diverged
 * the gym would be measuring something other than what it claims to.
 *
 * Nothing here knows an evaluation exists.
 */
export function MailApp({
  state,
  dispatch,
}: {
  state: MailState;
  dispatch: (action: Action) => void;
}) {

  // The same predicate the reducer uses, so what the list hides the reducer
  // also treats as hidden. Two implementations would eventually disagree and an
  // agent could act on a message it cannot see.
  const emails = state.emails.filter(
    (e) => e.folder === state.folder && matchesQuery(e, state.query),
  );
  const open = state.emails.find((e) => e.id === state.selectedId) ?? null;
  const showing = open && open.folder === state.folder ? open : null;

  /*
   * Which pane a phone is looking at.
   *
   * Deliberately component state and not an action: going back to the list is a
   * viewport concern, and adding a `back` action to the reducer would put an
   * entry in the action space the agent is graded on for something that changes
   * nothing about the mailbox. Evaluation runs at 1180x720 where both panes are
   * visible, so this never affects a run.
   */
  const [pane, setPane] = useState<"list" | "reader">("list");
  const reading = Boolean(state.composer || showing) && pane === "reader";

  return (
    /*
     * Three panes on a desktop, two on a tablet, one on a phone.
     *
     * Evaluation always happens at 1180x720 — the Playwright viewport and the
     * harness iframe are both fixed — so these breakpoints never change what an
     * agent sees. They exist because this page is also linked as "Environment"
     * and someone will open it on a phone, where a 168px sidebar plus a list
     * plus a reading pane leaves room for none of them.
     */
    <div className="grid h-svh grid-cols-1 bg-background sm:grid-cols-[168px_minmax(0,1fr)] lg:grid-cols-[180px_minmax(0,340px)_minmax(0,1fr)]">
      {/* Below sm the folder rail becomes a horizontal strip, so the list and
          the reader get the full width instead of a third of it. */}
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-2 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3">
        <div className="hidden items-center gap-2 px-2 py-1 text-sm font-semibold sm:mb-3 sm:flex">
          <Mail className="size-4 text-primary" />
          Mailbox
        </div>
        {FOLDERS.map(({ id, label, Icon }) => {
          const count = state.emails.filter((e) => e.folder === id).length;
          const unread = state.emails.filter((e) => e.folder === id && !e.read).length;
          // Every folder is always listed, even when empty: an agent asked to
          // check spam must be able to see that spam exists.
          return (
            <button
              key={id}
              data-testid={`folder-${id}`}
              onClick={() => {
                dispatch({ name: "open_folder", args: { folder: id } });
                setPane("list");
              }}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                state.folder === id
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-background/60",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
              {unread > 0 ? (
                <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold tabular text-primary-foreground">
                  {unread}
                </span>
              ) : (
                count > 0 && (
                  <span className="ml-auto shrink-0 text-[10px] tabular text-muted-foreground">
                    {count}
                  </span>
                )
              )}
            </button>
          );
        })}
        <Button
          size="sm"
          className="mt-3"
          data-testid="compose"
          onClick={() => {
            dispatch({ name: "compose", args: {} });
            setPane("reader");
          }}
        >
          <PenSquare className="size-3.5" />
          Compose
        </Button>
      </nav>

      {/*
        Below lg there is room for one pane, so reading replaces the list the
        way every mail client on a phone does. Above lg both are present and
        neither is ever hidden — which is the layout an evaluation runs in.
      */}
      <div
        className={cn(
          "flex min-h-0 flex-col border-r",
          reading && "hidden lg:flex",
        )}
      >
        <div className="shrink-0 border-b p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              data-testid="search"
              value={state.query}
              onChange={(event) =>
                dispatch({ name: "search", args: { query: event.target.value } })
              }
              placeholder="Search mail"
              aria-label="Search mail"
              className={cn("h-8 pl-8 text-sm", state.query && "pr-8")}
            />
            {/*
              The control that makes a second search possible.

              Typing appends, as a keyboard does, and the only key that removes
              anything is Backspace — one character at a time. Without this
              button, an agent that searched for "invoice" and then needed the
              newsletter had to spend seven turns deleting before it could type
              again, or give up and scroll. That is not a hard task, it is a
              missing affordance: every mail client has this, and a turn budget
              was being spent on its absence.
            */}
            {state.query && (
              <button
                type="button"
                data-testid="search-clear"
                aria-label="Clear search"
                onClick={() => dispatch({ name: "search", args: { query: "" } })}
                className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="mail-list">
        {emails.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {state.query ? `No message matches "${state.query}".` : "Nothing here."}
          </p>
        )}
        {emails.map((email) => (
          <Row
            key={email.id}
            email={email}
            selected={state.selectedId === email.id}
            onOpen={() => {
              dispatch({ name: "open", args: { id: email.id } });
              setPane("reader");
            }}
            onStar={() =>
              dispatch({ name: email.starred ? "unstar" : "star", args: { id: email.id } })
            }
          />
        ))}
        </div>
      </div>

      <div className={cn("overflow-y-auto p-5", !reading && "hidden", "lg:block")}>
        {reading && (
          <button
            type="button"
            onClick={() => setPane("list")}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <ChevronLeft className="size-4" />
            All messages
          </button>
        )}
        {state.composer ? (
          <Composer composer={state.composer} dispatch={dispatch} />
        ) : showing ? (
          <Reader email={showing} dispatch={dispatch} />
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">Select a message.</p>
        )}
      </div>
    </div>
  );
}

function Row({
  email,
  selected,
  onOpen,
  onStar,
}: {
  email: Email;
  selected: boolean;
  onOpen: () => void;
  onStar: () => void;
}) {
  return (
    /*
     * Unread is carried four ways: a dot, an accent bar, weight, and full-
     * strength ink against the muted text of a read message. One signal was not
     * enough — weight alone is close to invisible at a glance, and it is the
     * first thing anyone looks for in a mail client.
     */
    <div
      data-testid={`mail-${email.id}`}
      data-read={email.read ? "read" : "unread"}
      className={cn(
        "relative flex items-start border-b transition-colors",
        selected && "bg-primary/5",
        !email.read && "bg-primary/[0.04]",
      )}
    >
      {!email.read && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] bg-primary"
        />
      )}
      <button
        data-testid={`open-${email.id}`}
        onClick={onOpen}
        aria-label={`${email.read ? "Read" : "Unread"}. Open: ${email.subject}`}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50"
      >
        <span className="relative shrink-0">
          <span
            className={cn(
              "grid size-7 place-items-center rounded-full text-xs font-semibold",
              email.read
                ? "bg-muted text-muted-foreground"
                : "bg-primary/15 text-primary",
            )}
          >
            {email.from.slice(0, 1).toUpperCase()}
          </span>
          {!email.read && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-primary"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs",
              email.read ? "text-muted-foreground" : "font-semibold text-foreground",
            )}
          >
            {email.from.split("@")[0]}
          </span>
          <span
            className={cn(
              "block truncate text-sm",
              email.read ? "text-muted-foreground" : "font-semibold text-foreground",
            )}
          >
            {email.subject || "(no subject)"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {email.body.replace(/\s+/g, " ").slice(0, 72) || "(no content)"}
          </span>
          {email.labels.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {email.labels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                >
                  {label}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      <button
        data-testid={`star-${email.id}`}
        onClick={onStar}
        aria-label={email.starred ? "Unstar" : "Star"}
        className={cn(
          "px-2.5 py-3 transition-colors",
          email.starred ? "text-status-warning" : "text-muted-foreground hover:text-status-warning",
        )}
      >
        <Star className={cn("size-4", email.starred && "fill-current")} />
      </button>
    </div>
  );
}

function Reader({ email, dispatch }: { email: Email; dispatch: (action: Action) => void }) {
  const [labelDraft, setLabelDraft] = useState("");

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          data-testid="reader-star"
          onClick={() =>
            dispatch({ name: email.starred ? "unstar" : "star", args: { id: email.id } })
          }
        >
          <Star className={cn("size-3.5", email.starred && "fill-current")} />
          {email.starred ? "Unstar" : "Star"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="reader-reply"
          onClick={() => dispatch({ name: "reply", args: { id: email.id, body: "" } })}
        >
          <Reply className="size-3.5" />
          Reply
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="reader-archive"
          onClick={() => dispatch({ name: "archive", args: { id: email.id } })}
        >
          <Archive className="size-3.5" />
          Archive
        </Button>
        {/*
          A real control, because the triage task's correct solve requires a
          label. It had none: the reducer applied labels while the interface
          offered no way to, so the task passed through the in-page harness and
          was impossible through Chromium.
        */}
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const name = labelDraft.trim();
            if (!name) return;
            dispatch({ name: "label", args: { id: email.id, name } });
            setLabelDraft("");
          }}
        >
          <Input
            data-testid="reader-label"
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            placeholder="Label"
            aria-label="Add a label"
            className="h-8 w-24 text-sm"
          />
          <Button size="sm" variant="outline" type="submit" data-testid="reader-label-add">
            <Tag className="size-3.5" />
            Add
          </Button>
        </form>

        {/*
          Which controls exist depends on where the message is, exactly as in a
          real client: you do not "archive" something already in the bin, and
          permanent delete is offered only where it is offered.
        */}
        {email.folder !== "spam" && email.folder !== "trash" && (
          <Button
            size="sm"
            variant="outline"
            data-testid="reader-spam"
            onClick={() => dispatch({ name: "spam", args: { id: email.id } })}
          >
            <ShieldAlert className="size-3.5" />
            Spam
          </Button>
        )}

        {email.folder === "spam" && (
          <Button
            size="sm"
            variant="outline"
            data-testid="reader-not-spam"
            onClick={() => dispatch({ name: "not_spam", args: { id: email.id } })}
          >
            <ShieldCheck className="size-3.5" />
            Not spam
          </Button>
        )}

        {email.folder === "trash" && (
          <Button
            size="sm"
            variant="outline"
            data-testid="reader-restore"
            onClick={() => dispatch({ name: "restore", args: { id: email.id } })}
          >
            <Undo2 className="size-3.5" />
            Restore
          </Button>
        )}

        {(email.folder === "spam" || email.folder === "trash") && (
          <Button
            size="sm"
            variant="outline"
            data-testid="reader-delete-forever"
            className="text-status-critical"
            onClick={() => dispatch({ name: "delete_forever", args: { id: email.id } })}
          >
            <Trash2 className="size-3.5" />
            Delete forever
          </Button>
        )}

        {email.folder !== "trash" && (
          <Button
            size="sm"
            variant="outline"
            data-testid="reader-trash"
            onClick={() => dispatch({ name: "trash", args: { id: email.id } })}
          >
            <Trash2 className="size-3.5" />
            Trash
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="reader-unread"
          onClick={() => dispatch({ name: "mark_unread", args: { id: email.id } })}
        >
          Mark unread
        </Button>
      </div>

      <div>
        <h2 className="text-lg font-semibold tracking-tight">{email.subject}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {email.from} &rarr; {email.to}
        </p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
        {email.body}
      </p>
    </article>
  );
}

function Composer({
  composer,
  dispatch,
}: {
  composer: NonNullable<MailState["composer"]>;
  dispatch: (action: Action) => void;
}) {
  const [to, setTo] = useState(composer.to);
  const [subject, setSubject] = useState(composer.subject);
  const [body, setBody] = useState(composer.body);

  // `send` reads whatever is in the composer, so the draft is written back
  // first. dispatch applies synchronously, so the send sees the saved draft.
  const save = () => dispatch({ name: "compose", args: { to, subject, body } });

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          data-testid="composer-send"
          disabled={!to.trim()}
          title={to.trim() ? "Send" : "A recipient is required"}
          onClick={() => {
            save();
            dispatch({ name: "send", args: {} });
          }}
        >
          <Send className="size-3.5" />
          Send
        </Button>
        <Button size="sm" variant="outline" data-testid="composer-save" onClick={save}>
          Save draft
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="composer-discard"
          onClick={() => dispatch({ name: "discard", args: {} })}
        >
          Discard
        </Button>
      </div>

      <h2 className="text-lg font-semibold tracking-tight">New message</h2>
      <div className="grid gap-2">
        <Input
          data-testid="composer-to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="To"
        />
        <Input
          data-testid="composer-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Subject"
        />
        <Textarea
          data-testid="composer-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write your message…"
          rows={10}
        />
      </div>
    </article>
  );
}
