/**
 * The gym's world.
 *
 * All of it lives in one serialisable object held in localStorage. That is not
 * a shortcut, it is the property the whole grading model depends on: if the
 * entire observable world is one JSON value, then "did the agent do the task"
 * becomes a comparison between two JSON values rather than an argument about
 * what the screen looked like.
 */

export type Folder = "inbox" | "archive" | "trash" | "sent";

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
  folder: Folder;
  read: boolean;
  starred: boolean;
  labels: string[];
}

export interface MailState {
  emails: Email[];
  selectedId: string | null;
  composer: { to: string; subject: string; body: string } | null;
}

/** Matches any non-empty value during grading. Used for text a model writes. */
export const ANY = "<<any>>";

export const STORAGE_KEY = "clickgym.mail.v1";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function seedState(): MailState {
  return {
    selectedId: null,
    composer: null,
    emails: [
      {
        id: "m1",
        from: "ayesha@northwind.example",
        to: "you@clickgym.example",
        subject: "Invoice INV-2026-0871 is overdue",
        body:
          "Hi,\n\nOur records show INV-2026-0871 for PKR 45,000 is 12 days " +
          "overdue. Could you confirm when payment will be released?\n\nAyesha",
        receivedAt: "2026-08-21T09:14:00Z",
        folder: "inbox",
        read: false,
        starred: false,
        labels: [],
      },
      {
        id: "m2",
        from: "noreply@dispatch.example",
        to: "you@clickgym.example",
        subject: "Your order has shipped",
        body: "Order 55-2210 is on its way. Tracking: DX9920114.",
        receivedAt: "2026-08-21T11:02:00Z",
        folder: "inbox",
        read: true,
        starred: false,
        labels: [],
      },
      {
        id: "m3",
        from: "hiring@brightlane.example",
        to: "you@clickgym.example",
        subject: "Interview scheduling",
        body:
          "Are you free Thursday at 15:00 or Friday at 11:00 for a technical " +
          "conversation? Either works for us.",
        receivedAt: "2026-08-22T08:40:00Z",
        folder: "inbox",
        read: false,
        starred: false,
        labels: [],
      },
      {
        id: "m4",
        from: "newsletter@weeklybytes.example",
        to: "you@clickgym.example",
        subject: "Weekly Bytes #212",
        body: "Five things worth reading this week.",
        receivedAt: "2026-08-22T06:00:00Z",
        folder: "inbox",
        read: false,
        starred: false,
        labels: [],
      },
    ],
  };
}
