import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/**
 * Guards on the two layout defects that made a run unreadable.
 *
 * Both are the kind that come back: the first is undone by regenerating a
 * shadcn component from the registry, the second by anyone deciding the verdict
 * deserves a panel of its own again.
 */

test("the scroll viewport is forced to a block, so long lines wrap", () => {
  // Radix renders the viewport's inner wrapper as `display: table`, which
  // shrink-wraps to its content. Prose then never wraps — it runs past the edge
  // and is clipped, which is exactly how the timeline was truncating.
  const source = read("components/ui/scroll-area.tsx");

  assert.match(source, /\[&>div\]:!block/, "the table display has to be overridden");
  assert.match(source, /\[&>div\]:!w-full/, "and clamped to the viewport width");
});

test("timeline text is allowed to break rather than overflow", () => {
  const source = read("components/harness/timeline.tsx");

  assert.match(source, /leading-relaxed break-words/, "the thought must wrap");
  assert.match(source, /whitespace-pre-wrap break-all/, "the raw reply must wrap too");
});

test("the trajectory gets the full width, not half of it", () => {
  // The verdict is a two-line answer; the trajectory is the thing being read.
  // Giving them equal width squeezed the one that mattered.
  const detail = read("app/runs/[id]/page.tsx");

  assert.ok(
    !/lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1\.2fr\)\]/.test(detail),
    "the side-by-side grading pane must not come back",
  );
  assert.match(detail, /<GradingDialog/, "the verdict opens on demand instead");
});

test("the verdict is reachable as a control from both places a run is shown", () => {
  for (const file of ["app/runs/[id]/page.tsx", "components/harness/run-launcher.tsx"]) {
    assert.match(read(file), /<GradingDialog/, `${file} should expose the grading detail`);
  }
});

test("every verdict has one name, one icon and one explanation", () => {
  // Three components used to hold their own copies and had drifted: the same
  // outcome read as "Both", "Incomplete and overreached" and "Incomplete, and
  // did more than it was asked" depending on where you saw it.
  const meta = read("lib/harness/verdict-meta.ts");

  for (const status of ["pass", "incomplete", "overreach", "both", "unscored"]) {
    assert.ok(meta.includes(`${status}: {`), `${status} needs a presentation`);
  }

  // A run that never reached a model is not a failure and must not wear a cross.
  assert.match(meta, /unscored: \{[\s\S]*?CircleSlash/);

  // "Both" names a relationship to two things the reader cannot see. Every
  // label here has to survive being read on its own.
  assert.ok(!/short: "Both"/.test(meta), '"Both" is not a label');
  assert.match(meta, /Missed some, and did more than asked/);

  for (const file of [
    "components/harness/verdict-badge.tsx",
    "components/harness/grading-dialog.tsx",
    "components/harness/space-comparison.tsx",
  ]) {
    assert.match(read(file), /verdict-meta/, `${file} must use the shared table`);
  }
});

/* -------------------------------------------------------------------- */
/* Overflow: the same defect in four places                              */
/* -------------------------------------------------------------------- */

test("the dialog lets its children shrink below their content", () => {
  // DialogContent is a grid, and a grid item defaults to min-width:auto — it
  // refuses to shrink below its content. One long unbreakable string then
  // widens the whole dialog past max-w-*, and everything is clipped at the real
  // edge, where no ellipsis appears to explain it.
  const source = read("components/ui/dialog.tsx");

  assert.match(source, /\[&>\*\]:min-w-0/, "grid children must be allowed to shrink");
  assert.match(
    source,
    /overflow-x-hidden/,
    "and the x axis is pinned explicitly, not left to stylesheet order",
  );
});

test("grading paths wrap instead of pretending to truncate", () => {
  const source = read("components/harness/change-list.tsx");

  // `truncate` sets white-space:nowrap, so the element demands its full content
  // width. In an unconstrained parent it widens the container rather than
  // ellipsising — the truncation never happens and the clipping moves outward.
  assert.ok(
    !/block truncate font-mono/.test(source),
    "truncate on an unconstrained parent does not truncate",
  );
  assert.match(source, /block break-all font-mono/);
});

test("stat cards can shrink, which is what makes their truncation work", () => {
  for (const file of ["app/runs/[id]/page.tsx", "components/harness/run-launcher.tsx"]) {
    const source = read(file);
    assert.match(source, /min-w-0 rounded/, `${file} stat cards must be shrinkable`);
  }
});

test("model-written strings are allowed to break", () => {
  // Everything here comes from a provider or a model: coordinates, hit targets,
  // error bodies. None of it is guaranteed to contain a space.
  const browser = read("components/harness/browser-view.tsx");
  assert.match(browser, /break-all font-mono text-\[11px\]/, "the coordinate label");
  assert.match(browser, /min-w-0 break-all text-\[11px\]/, "the hit target");

  for (const file of ["app/runs/[id]/page.tsx", "components/harness/run-launcher.tsx"]) {
    assert.match(read(file), /break-words/, `${file} must let provider detail wrap`);
  }
});

/* -------------------------------------------------------------------- */
/* What a viewer sees                                                    */
/* -------------------------------------------------------------------- */

test("the committed file is the source of truth for viewers", () => {
  const source = read("hooks/use-runs.ts");

  // A guest cannot start a run, so their local storage can only hold runs from
  // a session where they were signed in — or nothing. Treating it as a source
  // would show different evidence to different people while claiming to be a
  // record of the same thing.
  assert.match(source, /session\.loading \|\| !session\.owner/);
  assert.match(source, /return \[\.\.\.measured\]/, "guests get the published set alone");
});

test("local runs are additive and owner-only", () => {
  const source = read("hooks/use-runs.ts");

  assert.match(
    source,
    /mergeWithSeeded\(stored, measured\)/,
    "only the owner's view includes local storage",
  );
});

test("seeded samples retire once real runs are published", () => {
  const source = read("hooks/use-runs.ts");

  // A fabricated row beside measured ones, separated only by a badge, invites
  // exactly the confusion the badge exists to prevent.
  assert.match(source, /published\.length \? published : SEEDED_RUNS/);
});
