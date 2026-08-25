/**
 * The boundary between the harness and the environment.
 *
 * The gym is a separate application served at /gym. The harness embeds it and
 * talks to it over postMessage rather than importing its state, so grading can
 * only ever depend on what the environment reports — not on internals no real
 * agent could see.
 */

import type { Action } from "./gym/actions.ts";
import type { ComputerAction, Viewport } from "./gym/computer.ts";
import type { MailState } from "./gym/state.ts";

export const GYM_ORIGIN_MARKER = "clickgym" as const;

export type GymRequest =
  | { type: "reset"; id: number; state: MailState }
  | { type: "apply"; id: number; action: Action }
  /** Coordinate-driven: the gym hit-tests the point and fires real events. */
  | { type: "computer"; id: number; action: ComputerAction; viewport: Viewport }
  | { type: "snapshot"; id: number };

export type ToGym = GymRequest & { marker: typeof GYM_ORIGIN_MARKER };

export type FromGym =
  | { marker: typeof GYM_ORIGIN_MARKER; type: "ready" }
  | {
      marker: typeof GYM_ORIGIN_MARKER;
      type: "state";
      id: number;
      state: MailState;
      ok: boolean;
      error?: string;
      /** JPEG data URL of the environment after this action, when capture worked. */
      shot?: string;
      /** What the pointer landed on, for coordinate actions only. */
      hit?: string;
    };

export function isFromGym(data: unknown): data is FromGym {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { marker?: unknown }).marker === GYM_ORIGIN_MARKER
  );
}

export function isToGym(data: unknown): data is ToGym {
  return isFromGym(data) && (data as { type: string }).type !== "ready";
}

/** Request/response pairs with ids, so replies cannot be matched to the wrong action. */
export class GymClient {
  private seq = 0;
  private pending = new Map<number, (reply: Extract<FromGym, { type: "state" }>) => void>();
  private onReady?: () => void;
  private onShot?: (id: number, shot: string) => void;

  /**
   * Written as an ordinary field rather than a constructor parameter property.
   *
   * `constructor(private frame: ...)` is TypeScript that emits code, and Node's
   * type stripping refuses it outright — so the whole module, guards included,
   * could not be imported by a test at all. The guards are the part of this file
   * that decides whether a message from an unknown source gets treated as the
   * environment's answer, which is exactly the part worth testing.
   */
  private frame: () => Window | null | undefined;

  constructor(frame: () => Window | null | undefined) {
    this.frame = frame;
    window.addEventListener("message", this.receive);
  }

  private receive = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (!isFromGym(event.data)) return;
    if (event.data.type === "ready") {
      this.onReady?.();
      return;
    }
    const resolve = this.pending.get(event.data.id);
    if (resolve) {
      this.pending.delete(event.data.id);
      resolve(event.data);
      return;
    }
    // The screenshot arrives after the reply it belongs to, since the page has
    // to paint before it can be photographed.
    if (event.data.shot) this.onShot?.(event.data.id, event.data.shot);
  };

  ready(callback: () => void) {
    this.onReady = callback;
  }

  /** Called when a late screenshot arrives for a request already answered. */
  shots(callback: (id: number, shot: string) => void) {
    this.onShot = callback;
  }

  /** The id the next request will use, so a caller can match a late shot to it. */
  get nextId(): number {
    return this.seq + 1;
  }

  dispose() {
    window.removeEventListener("message", this.receive);
    this.pending.clear();
  }

  private send(message: GymRequest): Promise<Extract<FromGym, { type: "state" }>> {
    const target = this.frame();
    if (!target) return Promise.reject(new Error("the environment is not loaded"));
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, resolve);
      target.postMessage({ ...message, marker: GYM_ORIGIN_MARKER }, window.location.origin);
      setTimeout(() => {
        if (this.pending.delete(message.id)) {
          reject(new Error("the environment did not answer"));
        }
      }, 5000);
    });
  }

  reset(state: MailState) {
    return this.send({ type: "reset", id: ++this.seq, state });
  }

  apply(action: Action) {
    return this.send({ type: "apply", id: ++this.seq, action });
  }

  /** Drive by coordinates. The gym resolves the point and dispatches real events. */
  computer(action: ComputerAction, viewport: Viewport) {
    return this.send({ type: "computer", id: ++this.seq, action, viewport });
  }

  snapshot() {
    return this.send({ type: "snapshot", id: ++this.seq });
  }
}
