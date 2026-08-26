#!/usr/bin/env python3
"""
Check that the gym's own guards fail when broken.

The gym is small, and its tests are correspondingly few — which makes it more
important, not less, that each one can actually go red. Every case below
reintroduces a bug this application has genuinely had.

    python3 tools/mail-mutation-check.py

Files are restored afterwards, including on a mutation that fails and on a
signal. Nothing can trap SIGKILL, so the pre-push check greps the tree as well.
"""

import atexit
import pathlib
import signal
import subprocess
import sys

TESTS = ["tests/interface.test.ts", "tests/reducer-matrix.test.ts", "tests/state.test.ts"]

CASES = [
    ("the folder rail is written out by hand instead of derived",
     "components/MailApp.tsx",
     "const FOLDERS = FOLDER_ORDER.map((id) => ({ id, ...FOLDER_LOOK[id] }));",
     'const FOLDERS = (["inbox", "sent"] as const).map((id) => ({ id, ...FOLDER_LOOK[id] }));  // MUTATED'),

    ("the reducer performs a forward the interface has no control for",
     "lib/mail/actions.ts", 'return fail(state, "this interface has no forward control");',
     "return { ok: true, state: next };  // MUTATED"),

    ("the reducer marks read without a control, which no person can do",
     "lib/mail/actions.ts", 'return fail(state, "there is no mark-read control; opening a message marks it read");',
     "return { ok: true, state: next };  // MUTATED"),

    ("the contract stops announcing what is rendered",
     "lib/mail/automation.ts", 'return [...document.querySelectorAll("[data-testid]")]',
     "return [] as string[]; // MUTATED\n      return [...document.querySelectorAll<HTMLElement>(\"[data-testid]\")]"),

    ("the search box loses its clear control, so a second search costs seven turns",
     "components/MailApp.tsx", 'data-testid="search-clear"', 'data-testid="search-cleared"  // MUTATED'),

    ("a restored mailbox stops having its missing fields filled in",
     "lib/mail/state.ts", 'query: typeof saved.query === "string" ? saved.query : "",',
     "query: saved.query as string,  // MUTATED"),

    ("Save draft goes back to only rewriting the open composer",
     "components/MailApp.tsx", 'dispatch({ name: "save_draft", args: {} });',
     '// MUTATED'),

    ("a saved draft is filed somewhere other than drafts",
     "lib/mail/actions.ts", '        folder: "drafts",', '        folder: "outbox",  // MUTATED'),

    ("saving a draft leaves the composer open, so the next action refiles it",
     "lib/mail/actions.ts", '      next.composer = null;\n      next.selectedId = null;\n      return { state: next, ok: true };\n    }\n    case "discard"',
     '      next.selectedId = null;\n      return { state: next, ok: true };  // MUTATED\n    }\n    case "discard"'),

    ("an ignore pattern goes back to matching at any depth, swallowing a route",
     ".vercelignore", '\n/tests/\n/tools/\n', '\n/tests/\ntools/  # MUTATED\n'),

    ("pressing Compose wipes a draft that is already open",
     "lib/mail/actions.ts",
     "      if (next.composer && blank) return { state, ok: true };",
     "      if (false) return { state, ok: true };  // MUTATED"),

    ("a restored draft is trusted instead of validated",
     "lib/mail/state.ts",
     "    composer: composer(saved.composer),",
     "    composer: (saved.composer ?? null) as MailState[\"composer\"],  // MUTATED"),

    ("restored messages are trusted instead of filled in",
     "lib/mail/state.ts",
     "        ? saved.emails.map(email)",
     "        ? saved.emails  // MUTATED"),

    ("a corrupt folder in storage is trusted instead of reset",
     "lib/mail/state.ts",
     'composer: composer(saved.composer),\n    folder: FOLDER_ORDER.includes(saved.folder as Folder) ? (saved.folder as Folder) : "inbox",',
     'composer: composer(saved.composer),\n    folder: (saved.folder ?? "inbox") as Folder,  // MUTATED'),
]

_ORIGINALS = {}


def _stash(path):
    text = path.read_text(encoding="utf-8")
    _ORIGINALS[str(path)] = text
    return text


def _restore_all():
    for name, text in list(_ORIGINALS.items()):
        try:
            pathlib.Path(name).write_text(text, encoding="utf-8")
        except OSError:
            print(f"  COULD NOT RESTORE {name} — check `git diff` before committing")
    _ORIGINALS.clear()


atexit.register(_restore_all)
for _sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(_sig, lambda *_: sys.exit(130))


# ---------------------------------------------------------------- baseline
#
# A mutation is "caught" when the suite goes red. That inference only holds if
# the suite was green to begin with. In the harness's copy of this tool it did
# not: the test list named a file that had been deleted, node exited non-zero
# because the path did not resolve, and every case reported CAUGHT without a
# mutation ever changing an outcome. Two guards behind that were guarding
# nothing for as long as the file was missing.
#
# So the list is run once, unmutated, before anything is edited.

_BASELINE = {}


def baseline_ok(tests):
    key = tuple(tests)
    if key not in _BASELINE:
        r = subprocess.run(["node", "--test", "--experimental-strip-types", *tests],
                           capture_output=True, text=True)
        _BASELINE[key] = r.returncode == 0
        if not _BASELINE[key]:
            print(f"  BASELINE RED: {' '.join(tests)}")
    return _BASELINE[key]


def refuse_if_already_mutated(paths):
    """Refuse to start on a tree that still carries a mutation.

    Every marker this tool writes is removed on exit, on SIGINT, SIGTERM and
    SIGHUP. It cannot be removed on SIGKILL, and a hard timeout kills rather
    than signals — which is exactly how a run of this tool once left
    `// MUTATED` in a source file, where it sat until the next test run failed
    for a reason nobody could place.

    So the first thing it does is look. A marker already in the tree means the
    last run died without cleaning up, and mutating on top of that would edit a
    file whose "original" is already wrong — turning a lost cleanup into a
    corrupted source file.
    """
    dirty = [p for p in dict.fromkeys(paths)
             if pathlib.Path(p).exists() and "// MUTATED" in pathlib.Path(p).read_text()]
    if dirty:
        print("\nREFUSING TO START — a previous run left a mutation behind:\n")
        for path in dirty:
            print(f"    {path}")
        print("\nRestore them (`git checkout -- <path>`) and run this again.\n")
        sys.exit(2)


refuse_if_already_mutated([case[1] for case in CASES])

results = []
for name, rel, old, new in CASES:
    path = pathlib.Path(rel)
    if not path.exists():
        results.append((name, f"SKIP - {rel} does not exist"))
        continue
    original = _stash(path)
    if old not in original:
        results.append((name, "SKIP - anchor not found"))
        continue
    if not baseline_ok(TESTS):
        results.append((name, "*** BASELINE RED - proves nothing ***"))
        continue
    path.write_text(original.replace(old, new, 1), encoding="utf-8")
    try:
        r = subprocess.run(["node", "--test", "--experimental-strip-types", *TESTS],
                           capture_output=True, text=True)
    finally:
        path.write_text(original, encoding="utf-8")
        _ORIGINALS.pop(str(path), None)
    results.append((name, "CAUGHT" if r.returncode != 0 else "*** NOT CAUGHT ***"))

print(f"\n{'mutation':<62} {'result'}")
print("-" * 88)
for name, verdict in results:
    print(f"{name:<62} {verdict}")
gaps = [n for n, v in results if v != "CAUGHT"]
print()
print("all mutations caught" if not gaps else f"GAPS: {len(gaps)}")
sys.exit(1 if gaps else 0)
