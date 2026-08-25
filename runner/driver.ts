/**
 * A real browser driver.
 *
 * Everything the agent does here is a genuine click or keystroke in Chromium.
 * There is no message bridge and no reducer call — the page is driven the way a
 * person drives it, and the resulting state is read back out of the page's own
 * local storage afterwards.
 *
 * That distinction matters for what the evaluation is worth. Dispatching a
 * reducer proves a model can pick an action name. Clicking proves the action
 * was reachable, visible, and did what the interface says it does.
 */

import type { Page } from "playwright";

import type { Action } from "../lib/gym/actions.ts";
import { serialize } from "../lib/gym/serialize.ts";
import { type MailState, storageKeyFor } from "../lib/gym/state.ts";

export class DriverError extends Error {}

/** Seed the page by writing the store and reloading, exactly as a fixture would. */
function keyFor(page: Page): string {
  // The page namespaces its storage by ?run=, so the driver must use the same key.
  return storageKeyFor(new URL(page.url()).searchParams.get("run"));
}

export async function seed(page: Page, state: MailState): Promise<void> {
  await page.evaluate(
    ([key, value]: readonly [string, string]) => window.localStorage.setItem(key, value),
    [keyFor(page), JSON.stringify(state)] as const,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid^='mail-']", { timeout: 10_000 });
}

export async function readState(page: Page): Promise<MailState> {
  const raw = await page.evaluate((key: string) => window.localStorage.getItem(key), keyFor(page));
  if (!raw) throw new DriverError("the page holds no state");
  return JSON.parse(raw) as MailState;
}

async function click(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId);
  // A short timeout on purpose: if the control is not there, that is a finding
  // about the run, not something to wait out.
  await target.click({ timeout: 4000 });
}

/**
 * Perform one action with real input. Throws DriverError when the control the
 * action needs is not reachable — which is itself a result worth recording.
 */
export async function perform(page: Page, action: Action): Promise<void> {
  const id = typeof action.args?.id === "string" ? action.args.id : undefined;

  switch (action.name) {
    case "open_folder": {
      const folder = String(action.args?.folder ?? "");
      if (!folder) throw new DriverError("open_folder needs a folder");
      return click(page, `folder-${folder}`);
    }

    case "search": {
      const query = String(action.args?.query ?? "");
      const box = page.getByTestId("search");
      await box.fill(query);
      // The list re-filters on input; give React a frame to commit before the
      // next observation is taken, or the agent reads the pre-filter screen.
      await page.waitForTimeout(120);
      return;
    }

    case "open":
      if (!id) throw new DriverError("open needs an id");
      return click(page, `open-${id}`);

    case "star":
    case "unstar":
      if (!id) throw new DriverError(`${action.name} needs an id`);
      return click(page, `star-${id}`);

    case "spam":
    case "not_spam":
    case "restore":
    case "delete_forever": {
      if (!id) throw new DriverError(`${action.name} needs an id`);
      // All reading-pane controls, so the message has to be open first.
      await click(page, `open-${id}`);
      const control = {
        spam: "reader-spam",
        not_spam: "reader-not-spam",
        restore: "reader-restore",
        delete_forever: "reader-delete-forever",
      }[action.name];
      return click(page, control);
    }

    case "archive":
    case "trash":
    case "mark_unread": {
      if (!id) throw new DriverError(`${action.name} needs an id`);
      // These live in the reading pane, so the message has to be open first —
      // the same constraint a person works under.
      await click(page, `open-${id}`);
      const control =
        action.name === "archive"
          ? "reader-archive"
          : action.name === "trash"
            ? "reader-trash"
            : "reader-unread";
      return click(page, control);
    }

    case "reply": {
      if (!id) throw new DriverError("reply needs an id");
      await click(page, `open-${id}`);
      await click(page, "reader-reply");
      const body = String(action.args?.body ?? "");
      if (body) await page.getByTestId("composer-body").fill(body);
      return;
    }

    case "compose": {
      await click(page, "compose");
      const to = String(action.args?.to ?? "");
      const subject = String(action.args?.subject ?? "");
      const body = String(action.args?.body ?? "");
      if (to) await page.getByTestId("composer-to").fill(to);
      if (subject) await page.getByTestId("composer-subject").fill(subject);
      if (body) await page.getByTestId("composer-body").fill(body);
      return;
    }

    case "forward":
      // Not reachable from the interface. Recording that honestly is better
      // than quietly emulating it behind the model's back.
      throw new DriverError("this interface has no forward control");

    case "mark_read":
      throw new DriverError(
        "there is no mark-read control; opening a message marks it read",
      );

    case "send":
      return click(page, "composer-send");

    case "discard":
      return click(page, "composer-discard");

    case "label": {
      if (!id) throw new DriverError("label needs an id");
      const name = String(action.args?.name ?? "").trim();
      if (!name) throw new DriverError("label needs a name");
      // Reading-pane control, so the message has to be open first.
      await click(page, `open-${id}`);
      await page.getByTestId("reader-label").fill(name);
      await click(page, "reader-label-add");
      return;
    }

    case "finish":
      return;

    default:
      throw new DriverError(`unknown action ${action.name}`);
  }
}

/**
 * What the model sees in tool mode: the mailbox, serialised.
 *
 * This used to scrape presentational class names — `.mrow-from`, `.mrow-subject`,
 * `.reader`. The component was rebuilt, those classes went away, and the scrape
 * kept succeeding while returning empty strings for every sender, subject and
 * preview. The model was handed a mailbox of four blank rows, opened each one
 * trying to find the message it had been asked about, learned nothing, and
 * replied to the first. Every tool-mode run recorded that way measured the
 * harness, not the model.
 *
 * It now reads the environment's own state and runs it through the same
 * serialiser the in-page harness uses. Two reasons, and the second matters more:
 *
 *   1. There is nothing to drift. A renamed class cannot silently empty it.
 *   2. Both drivers now show the model the identical observation, so a tool-mode
 *      run in Chromium and one in the console are the same measurement. They
 *      were not before, and the comparison this project is built on assumes
 *      they are.
 *
 * Coupling to the state rather than the DOM is right *here* and wrong for
 * computer use, which must photograph what is actually on screen — see
 * `photograph`.
 */
export async function observe(page: Page): Promise<string> {
  const state = await readState(page);
  const text = serialize(state);

  // A blank observation is an environment failure, not a hard task. Recording a
  // run against one produces a verdict about nothing, which is worse than no
  // run at all — so it stops here rather than being scored.
  if (!text.trim() || !state.emails.length) {
    throw new DriverError("the environment reported an empty mailbox");
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Computer use                                                        */
/* ------------------------------------------------------------------ */

/**
 * The same coordinate actions the in-page harness runs, driven by Chromium's
 * real input rather than dispatched events.
 *
 * `page.mouse.click` moves the OS-level cursor and presses a button, so it is
 * subject to everything a person is subject to: overlays, pointer-events,
 * elements that have not painted yet. That is the point of running it here as
 * well as in-page — if a click behaves differently under the two drivers, the
 * in-page one is lying about something.
 */
export interface ComputerOutcome {
  ok: boolean;
  error?: string;
  hit?: string;
}

/** What sits under a point, described the same way the in-page driver describes it. */
async function targetAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([px, py]: readonly [number, number]) => {
      const element = document.elementFromPoint(px, py);
      if (!element) return "nothing";
      const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
      if (testId) return testId;
      const control = element.closest("button, a, input, textarea, [role='button']");
      if (control) {
        const text = (control.textContent ?? "").trim().slice(0, 40);
        return text ? `${control.tagName.toLowerCase()} "${text}"` : control.tagName.toLowerCase();
      }
      return element.tagName.toLowerCase();
    },
    [x, y] as const,
  );
}

const KEYS: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  space: "Space",
};

export async function performComputer(
  page: Page,
  action: Action,
  point: { x: number; y: number; outOfBounds: boolean } | null,
): Promise<ComputerOutcome> {
  const viewport = page.viewportSize();

  switch (action.name) {
    case "click":
    case "double_click": {
      if (!point) return { ok: false, error: "click needs x and y" };
      if (
        point.outOfBounds ||
        !viewport ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > viewport.width ||
        point.y > viewport.height
      ) {
        return { ok: false, error: "the point is outside the screen", hit: "off-screen" };
      }

      // Read the target before clicking: the click may replace what was there.
      const hit = await targetAt(page, point.x, point.y);
      if (hit === "nothing") {
        // Still perform it. A click on empty space is a real thing a person can
        // do, and recording it as attempted-and-missed is more useful than
        // refusing to carry it out.
        await page.mouse.click(point.x, point.y, {
          clickCount: action.name === "double_click" ? 2 : 1,
        });
        return { ok: false, error: "the click landed on nothing", hit };
      }

      await page.mouse.click(point.x, point.y, {
        clickCount: action.name === "double_click" ? 2 : 1,
      });
      return { ok: true, hit };
    }

    case "type": {
      const text = String(action.args?.text ?? "");
      if (!text) return { ok: false, error: "type needs text" };
      const focused = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return null;
        return active.getAttribute("data-testid") ?? active.tagName.toLowerCase();
      });
      if (!focused) {
        return { ok: false, error: "nothing is focused, so there is nowhere to type", hit: "nothing" };
      }
      await page.keyboard.type(text, { delay: 8 });
      return { ok: true, hit: focused };
    }

    case "key": {
      const raw = String(action.args?.name ?? action.args?.key ?? "");
      const mapped = KEYS[raw.trim().toLowerCase()];
      if (!mapped) return { ok: false, error: `unknown key "${raw}"` };
      await page.keyboard.press(mapped);
      return { ok: true };
    }

    case "scroll": {
      if (!point) return { ok: false, error: "scroll needs x and y" };
      const dy = Number(action.args?.dy ?? action.args?.delta ?? 0);
      if (!Number.isFinite(dy) || dy === 0) return { ok: false, error: "scroll needs a dy" };
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, dy);
      return { ok: true, hit: await targetAt(page, point.x, point.y) };
    }

    case "wait":
      await page.waitForTimeout(400);
      return { ok: true, hit: "—" };

    default:
      return { ok: false, error: `no such action "${action.name}"` };
  }
}

/** The computer-use observation: a screenshot, and nothing else. */
export async function photograph(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: "jpeg", quality: 72 });
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}
