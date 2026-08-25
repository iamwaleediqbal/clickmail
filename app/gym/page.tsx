"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MailApp } from "../../components/MailApp.tsx";
import { type Action, applyAction } from "../../lib/mail/actions.ts";
import { install } from "../../lib/mail/automation.ts";
import { type MailState, hydrate, seedState, STORAGE_KEY } from "../../lib/mail/state.ts";

/**
 * The gym.
 *
 * A mail client, and nothing else. It is a public page: anyone can open it and
 * click around, and that is the intended way to understand what an agent is
 * being asked to operate.
 *
 * What it does *not* contain is the reason this file is short. No tasks, no
 * grader, no notion of a run, no model, no key. Those belong to the harness,
 * which drives this page from outside with a real browser and reads the world
 * through the automation contract. The gym holds state; something else decides
 * whether that state is correct.
 *
 * The contract is the entire interface: `reset()` and `state()`. A harness that
 * needed more than that would be one that could only ever drive this app.
 */
export default function Gym() {
  const [state, setState] = useState<MailState>(() => seedState());
  const latest = useRef(state);
  latest.current = state;

  const persist = useCallback((next: MailState) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private windows and blocked site data both throw; the app works without it.
    }
  }, []);

  const commit = useCallback(
    (next: MailState) => {
      latest.current = next;
      setState(next);
      persist(next);
    },
    [persist],
  );

  // Restore what a visitor left behind. A run always calls reset() first, so a
  // restored mailbox can never leak into a scored one.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      // Through hydrate, because a mailbox saved by an earlier version of this
      // app is missing whatever fields were added since.
      if (saved) commit(hydrate(JSON.parse(saved)));
    } catch {
      /* see above */
    }
  }, [commit]);

  useEffect(() => install(() => latest.current, commit), [commit]);

  const dispatch = useCallback(
    (action: Action) => commit(applyAction(latest.current, action).state),
    [commit],
  );

  return (
    <div className="min-h-svh bg-background">
      <MailApp state={state} dispatch={dispatch} />
    </div>
  );
}
