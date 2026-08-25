/**
 * The gym's automation surface: how anything outside it reads the world.
 *
 * The gym is a public web application. Anyone can open it and use it as a mail
 * client. It holds one thing on behalf of an evaluation — **state** — and this
 * file is the only way anything reaches it.
 *
 * Before this, the Playwright driver read `localStorage` directly, with a key
 * it reconstructed itself. That worked, and it was the wrong shape: the harness
 * was reaching into the application's internals, so the two could only ever
 * ship together. Change how the gym persists anything and the harness breaks
 * for reasons that have nothing to do with grading. A real application under
 * test would never hand over its storage key.
 *
 * So the gym publishes a contract instead, and it is deliberately tiny:
 *
 *     reset()   start clean, and tell me what the world now is
 *     state()   tell me what the world is now
 *
 * That is the whole protocol. The harness fetches the initial state before the
 * agent starts, lets it act however it acts, fetches the final state when it
 * stops, and grades one against the other. Nothing about grading, tasks or
 * models appears here, because none of that is the application's business —
 * and because an environment that only has to answer these two questions is an
 * environment a real application can be made to imitate.
 *
 * Snapshots in, snapshots out. A verdict is then recomputed from the two saved
 * states as often as you like, without paying for another model run.
 */

import { hydrate, seedState, type MailState } from "./state.ts";

/** Bumped if the shape below ever changes. The harness checks it. */
export const AUTOMATION_VERSION = 1;

export interface GymAutomation {
  readonly version: number;
  /** Identifies which environment this is, so a harness cannot misread one for another. */
  readonly environment: string;
  /** Discard everything and start from the gym's own seed. Returns the new world. */
  reset(): MailState;
  /** The world as it stands. */
  state(): MailState;
  /**
   * Every control the interface is currently offering, by test id.
   *
   * Here because the alternative stopped working the day the harness moved to
   * its own repository. A grep across two source trees cannot check that the
   * action space the harness offers a model matches the buttons this app
   * actually renders — and that pair has drifted before, in both directions: an
   * action the reducer performed with no control on screen, and a control the
   * driver clicked that had been renamed.
   *
   * Asking the running application is better than either. It answers for the
   * build that is actually deployed rather than for the source someone read.
   */
  controls(): string[];
}

declare global {
  interface Window {
    clickmail?: GymAutomation;
  }
}

/**
 * Publish the contract on `window`.
 *
 * Read-and-reset only. There is deliberately no way to *install* an arbitrary
 * state from outside: the gym owns its own starting world, and a harness that
 * could write one would be grading a mailbox it had authored itself. Tasks say
 * what should change; they do not get to say what was there to begin with.
 */
export function install(
  read: () => MailState,
  write: (next: MailState) => void,
): () => void {
  const api: GymAutomation = {
    version: AUTOMATION_VERSION,
    environment: "clickmail-mailbox",
    reset() {
      const fresh = seedState();
      write(fresh);
      return hydrate(JSON.parse(JSON.stringify(fresh)));
    },
    controls() {
      return [...document.querySelectorAll("[data-testid]")]
        .map((node) => node.getAttribute("data-testid") ?? "")
        .filter(Boolean)
        .sort();
    },
    state() {
      // Through hydrate and a clone, so a caller cannot hold a live reference
      // into the running application and watch it change under them.
      return hydrate(JSON.parse(JSON.stringify(read())));
    },
  };

  window.clickmail = api;
  return () => {
    if (window.clickmail === api) delete window.clickmail;
  };
}
