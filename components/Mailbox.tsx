"use client";

import type { Folder, MailState } from "../lib/gym/state.ts";

const FOLDERS: Folder[] = ["inbox", "archive", "sent", "trash"];

export function Mailbox({ state }: { state: MailState }) {
  return (
    <div>
      {FOLDERS.map((folder) => {
        const emails = state.emails.filter((e) => e.folder === folder);
        if (!emails.length) return null;
        return (
          <div key={folder}>
            <p className="folder-title">
              {folder} ({emails.length})
            </p>
            <div className="mail">
              {emails.map((email) => (
                <div
                  key={email.id}
                  className={[
                    "mail-row",
                    email.read ? "" : "unread",
                    state.selectedId === email.id ? "open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="mail-from">{email.from.split("@")[0]}</span>
                  <span className="subject">{email.subject}</span>
                  <span className="tags">
                    {email.starred && <span className="tag">starred</span>}
                    {email.labels.map((label) => (
                      <span className="tag" key={label}>
                        {label}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {state.composer && (
        <>
          <p className="folder-title">composer (unsent)</p>
          <div className="mail">
            <div className="mail-row">
              <span className="mail-from">to</span>
              <span className="subject">{state.composer.to || "(empty)"}</span>
            </div>
            <div className="mail-row">
              <span className="mail-from">subject</span>
              <span className="subject">{state.composer.subject || "(empty)"}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
