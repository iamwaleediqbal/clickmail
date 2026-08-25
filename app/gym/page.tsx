"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MailApp } from "../../components/MailApp.tsx";
import { GYM_ORIGIN_MARKER, type FromGym, isToGym } from "../../lib/bridge.ts";
import { type Action, applyAction } from "../../lib/gym/actions.ts";
import { capture } from "../../lib/gym/capture.ts";
import { resolvePoint } from "../../lib/gym/computer.ts";
import { performComputer } from "../../lib/gym/pointer.ts";
import { type MailState, hydrate, seedState, storageKeyFor } from "../../lib/gym/state.ts";

/**
 * The environment.
 *
 * Standalone it is simply a mail client. Embedded, it answers requests on the
 * bridge. Either way the state lives in one local-storage key and every change
 * goes through the same reducer, so a person and an agent cannot get different
 * behaviour out of it.
 */
function GymApp() {
  // ?run=<id> namespaces this instance's storage. Each evaluation mounts a
  // fresh frame with a fresh id, so runs cannot see each other.
  const runId = useSearchParams().get("run");
  const storageKey = useMemo(() => storageKeyFor(runId), [runId]);

  const [state, setState] = useState<MailState>(() => seedState());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(state);
  latest.current = state;

  const persist = useCallback((next: MailState) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Private windows and blocked site data both throw; the app works without it.
    }
  }, [storageKey]);

  useEffect(() => {
    // Only restore when standalone. Under evaluation the harness seeds the
    // mailbox, and restoring first would let stale state into a scored run.
    if (window.parent !== window || runId) return;
    try {
      const saved = window.localStorage.getItem(storageKey);
      // Through hydrate, because a mailbox saved by an earlier version of
      // this app is missing whatever fields were added since.
      if (saved) setState(hydrate(JSON.parse(saved)));
    } catch {
      /* see above */
    }
  }, [runId, storageKey]);

  useEffect(() => {
    function reply(message: FromGym) {
      window.parent?.postMessage(message, window.location.origin);
    }

    /**
     * Answer, then photograph. React has to paint the new state before the
     * capture can show it, so the shot follows on a second message rather than
     * holding the reply until the picture is ready.
     */
    async function replyThenCapture(message: Extract<FromGym, { type: "state" }>) {
      reply(message);
      const node = rootRef.current;
      if (!node) return;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const shot = await capture(node);
      if (shot) reply({ ...message, shot });
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!isToGym(event.data)) return;
      const message = event.data;

      if (message.type === "reset") {
        latest.current = message.state;
        setState(message.state);
        persist(message.state);
        void replyThenCapture({
          marker: GYM_ORIGIN_MARKER,
          type: "state",
          id: message.id,
          state: message.state,
          ok: true,
        });
        return;
      }

      if (message.type === "snapshot") {
        reply({
          marker: GYM_ORIGIN_MARKER,
          type: "state",
          id: message.id,
          state: latest.current,
          ok: true,
        });
        return;
      }

      /**
       * Coordinate-driven input. The point is resolved from whatever convention
       * the model answered in, hit-tested against the live DOM, and driven with
       * real events — so the reducer is reached the same way a person's click
       * reaches it, or not reached at all if the click missed.
       */
      if (message.type === "computer") {
        const { x, y } = message.action.args as { x?: unknown; y?: unknown };
        const point =
          typeof x === "number" && typeof y === "number"
            ? resolvePoint(x, y, message.viewport)
            : null;

        const node = rootRef.current;
        const result = node
          ? performComputer(node, message.action, point)
          : { ok: false, error: "the environment is not mounted" };

        // React commits the reducer's state change asynchronously, so the
        // authoritative state is read back after a paint rather than from the
        // ref, which the event handler may not have updated yet.
        void (async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          void replyThenCapture({
            marker: GYM_ORIGIN_MARKER,
            type: "state",
            id: message.id,
            state: latest.current,
            ok: result.ok,
            error: result.error,
            hit: result.hit,
          });
        })();
        return;
      }

      if (message.type === "apply") {
        const result = applyAction(latest.current, message.action);
        latest.current = result.state;
        setState(result.state);
        persist(result.state);
        void replyThenCapture({
          marker: GYM_ORIGIN_MARKER,
          type: "state",
          id: message.id,
          state: result.state,
          ok: result.ok,
          error: result.error,
        });
      }
    }

    window.addEventListener("message", onMessage);
    window.parent?.postMessage(
      { marker: GYM_ORIGIN_MARKER, type: "ready" } satisfies FromGym,
      window.location.origin,
    );
    return () => window.removeEventListener("message", onMessage);
  }, [persist]);

  const dispatch = useCallback(
    (action: Action) => {
      const result = applyAction(latest.current, action);
      latest.current = result.state;
      setState(result.state);
      persist(result.state);
    },
    [persist],
  );

  return (
    <div ref={rootRef} className="min-h-svh bg-background">
      <MailApp state={state} dispatch={dispatch} />
    </div>
  );
}

export default function Gym() {
  return (
    <Suspense fallback={<div className="min-h-svh bg-background" />}>
      <GymApp />
    </Suspense>
  );
}
