/**
 * Executing coordinate actions against the real interface.
 *
 * Nothing here knows what the environment is. It hit-tests a point, dispatches
 * the event sequence a browser dispatches, and reports what it hit. The mail
 * app's own handlers do the rest — which is the point: an agent driving this
 * has exactly the leverage a person with a mouse has, and no more.
 *
 * A click that lands on empty space is not an error to be smoothed over. It is
 * the most informative outcome in the whole space, because it separates a model
 * that chose the wrong thing to do from one that chose correctly and missed.
 */

import type { ComputerAction, Resolved } from "./computer.ts";

export interface PointerResult {
  ok: boolean;
  error?: string;
  /** A short description of what was under the cursor, for the run record. */
  hit?: string;
}

/** What the point landed on, in words a human reading the timeline can use. */
function describeTarget(element: Element | null): string {
  if (!element) return "nothing";
  const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
  if (testId) return testId;
  const control = element.closest("button, a, input, textarea, [role='button']");
  if (control) {
    const text = (control.textContent ?? "").trim().slice(0, 40);
    return text ? `${control.tagName.toLowerCase()} "${text}"` : control.tagName.toLowerCase();
  }
  return element.tagName.toLowerCase();
}

/**
 * The clickable thing at this point, if there is one.
 *
 * A click usually lands on a label or an icon inside a control rather than on
 * the control itself, exactly as it does for a person. Walking up to the
 * nearest interactive ancestor is what the browser's own event bubbling would
 * do anyway; doing it explicitly means the result can say what was activated.
 */
function interactiveAt(root: HTMLElement, x: number, y: number): Element | null {
  const element = document.elementFromPoint(x, y);
  if (!element || !root.contains(element)) return null;
  return element;
}

function fireMouse(target: Element, type: string, x: number, y: number, detail = 1): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      detail,
      button: 0,
      buttons: type === "mousedown" ? 1 : 0,
      view: window,
    }),
  );
}

function firePointer(target: Element, type: string, x: number, y: number): void {
  // Not every browser build exposes PointerEvent to constructors; the mouse
  // sequence alone still activates everything this interface uses.
  if (typeof PointerEvent !== "function") return;
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
      view: window,
    }),
  );
}

function clickAt(root: HTMLElement, x: number, y: number, times: number): PointerResult {
  const target = interactiveAt(root, x, y);
  if (!target) {
    return { ok: false, error: "the click landed on nothing", hit: "nothing" };
  }

  const hit = describeTarget(target);

  // Focus first, the way a real press does, so that typing afterwards has
  // somewhere to go.
  const focusable = target.closest<HTMLElement>(
    "input, textarea, select, button, a[href], [tabindex]",
  );
  focusable?.focus();

  for (let i = 1; i <= times; i++) {
    firePointer(target, "pointerdown", x, y);
    fireMouse(target, "mousedown", x, y, i);
    firePointer(target, "pointerup", x, y);
    fireMouse(target, "mouseup", x, y, i);
    fireMouse(target, "click", x, y, i);
  }
  if (times > 1) fireMouse(target, "dblclick", x, y, times);

  return { ok: true, hit };
}

/**
 * Set a field's value so React notices.
 *
 * React installs its own value setter on the input prototype and tracks the
 * last value it wrote. Assigning `element.value` directly updates the DOM but
 * leaves React's tracker convinced nothing changed, so the input event is
 * swallowed and the component never re-renders. Calling the native setter
 * first is the standard way around it.
 */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeInto(text: string): PointerResult {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLInputElement) &&
    !(active instanceof HTMLTextAreaElement) &&
    !(active instanceof HTMLElement && active.isContentEditable)
  ) {
    return { ok: false, error: "nothing is focused, so there is nowhere to type", hit: "nothing" };
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    setValue(active, active.value + text);
    return { ok: true, hit: describeTarget(active) };
  }

  active.textContent = (active.textContent ?? "") + text;
  active.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true, hit: describeTarget(active) };
}

const KEYS: Record<string, { key: string; code: string }> = {
  enter: { key: "Enter", code: "Enter" },
  tab: { key: "Tab", code: "Tab" },
  escape: { key: "Escape", code: "Escape" },
  esc: { key: "Escape", code: "Escape" },
  backspace: { key: "Backspace", code: "Backspace" },
  space: { key: " ", code: "Space" },
};

function pressKey(name: string): PointerResult {
  const mapped = KEYS[name.trim().toLowerCase()];
  if (!mapped) return { ok: false, error: `unknown key "${name}"` };

  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init = { key: mapped.key, code: mapped.code, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));

  // Backspace has to change the value itself; a synthetic keydown does not.
  if (
    mapped.key === "Backspace" &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  ) {
    setValue(target, target.value.slice(0, -1));
  }

  return { ok: true, hit: describeTarget(target) };
}

/** The nearest ancestor that can actually scroll, which is rarely the element hit. */
function scrollableAt(root: HTMLElement, x: number, y: number): HTMLElement | null {
  let node = document.elementFromPoint(x, y);
  while (node instanceof HTMLElement && root.contains(node)) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function performComputer(
  root: HTMLElement,
  action: ComputerAction,
  point: Resolved | null,
): PointerResult {
  switch (action.name) {
    case "click":
    case "double_click": {
      if (!point) return { ok: false, error: "click needs x and y" };
      if (point.outOfBounds) {
        return { ok: false, error: "the point is outside the screen", hit: "off-screen" };
      }
      return clickAt(root, point.x, point.y, action.name === "double_click" ? 2 : 1);
    }

    case "type": {
      const text = action.args.text;
      if (typeof text !== "string" || !text) return { ok: false, error: "type needs text" };
      return typeInto(text);
    }

    case "key": {
      const name = action.args.name ?? action.args.key;
      if (typeof name !== "string") return { ok: false, error: "key needs a name" };
      return pressKey(name);
    }

    case "scroll": {
      if (!point) return { ok: false, error: "scroll needs x and y" };
      const dy = Number(action.args.dy ?? action.args.delta ?? 0);
      if (!Number.isFinite(dy) || dy === 0) return { ok: false, error: "scroll needs a dy" };
      const pane = scrollableAt(root, point.x, point.y);
      if (!pane) return { ok: false, error: "nothing under that point scrolls", hit: "nothing" };
      pane.scrollBy({ top: dy, behavior: "auto" });
      return { ok: true, hit: describeTarget(pane) };
    }

    case "wait":
      return { ok: true, hit: "—" };

    default:
      return { ok: false, error: `no such action "${action.name}"` };
  }
}
