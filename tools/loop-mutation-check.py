#!/usr/bin/env python3
"""
Check that the end-to-end agent loop test actually fails when the loop breaks.

tests/agent-loop.test.ts is the only test that closes the loop: a policy that
sees *nothing but the serialised observation* has to find its target, act
through the real parser and the real reducer, and be graded. It exists to catch
the three failures that reached a paid run before it did — a model handed blank
rows, an action missing from its prompt, and a folder it could not reach.

A test like that is worth exactly as much as the mutations it catches. So each
of those failures is reintroduced here and the suite must go red.

    python3 tools/loop-mutation-check.py

Every file is restored afterwards, including when a mutation fails.
"""

import atexit
import pathlib
import signal
import subprocess
import sys

LOOP = ["tests/agent-loop.test.ts"]
GRADING = ["tests/misgrading.test.ts", "tests/grade.test.ts", "tests/solvable.test.ts"]
MATRIX = ["tests/reducer-matrix.test.ts"]
PERSIST = ["tests/persistence.test.ts"]
QUOTA = ["tests/quota.test.ts"]
FLOW = ["tests/workflows.test.ts"]
OWNER = ["tests/owner.test.ts"]
BUDGET = ["tests/solvable.test.ts", "tests/computer.test.ts"]
BUDGET = ["tests/solvable.test.ts", "tests/computer.test.ts"]
CLI = ["tests/workflows.test.ts", "tests/runner-cli.test.ts"]
ALL = ["tests/agent-loop.test.ts", "tests/solvable.test.ts", "tests/grade.test.ts",
       "tests/reachable.test.ts", "tests/search.test.ts"]

CASES = [
  # (name, file, old, new, which tests must go red)
  ("the model is handed rows with no subject",
   "lib/gym/serialize.ts", 'lines.push(`  subject: ${email.subject || "(no subject)"}`);',
                           'lines.push("  subject: (no subject)");  // MUTATED', LOOP),

  ("the model is handed rows with no body at all",
   "lib/gym/serialize.ts", 'lines.push(`  body: ${body.replace(/\\n+/g, " ") || "(empty)"}`);',
                           'lines.push("  body: (empty)");  // MUTATED', LOOP),

  ("body previews truncated to nothing, hiding what the task names",
   "lib/gym/serialize.ts", 'const BODY_PREVIEW = 140;', 'const BODY_PREVIEW = 0;  // MUTATED', LOOP),

  ("serialize ignores the open folder and always shows the inbox",
   "lib/gym/serialize.ts", '(e) => e.folder === state.folder && matchesQuery(e, state.query),',
                           '(e) => e.folder === "inbox" && matchesQuery(e, state.query),  // MUTATED', LOOP),

  ("the spam folder becomes unreachable",
   "lib/gym/actions.ts", 'if (!FOLDER_ORDER.includes(folder)) {',
                         'if (!FOLDER_ORDER.includes(folder) || folder === "spam") {  // MUTATED', LOOP),

  ("rescuing from spam silently does nothing",
   "lib/gym/actions.ts", '''      email.read = true;
      email.folder = "inbox";
      next.selectedId = null;
      return { ok: true, state: next };
    }

    /** Put something back where it came from. Trash only. */''',
                         '''      return { ok: true, state: next };  // MUTATED
    }

    /** Put something back where it came from. Trash only. */''', LOOP),

  ("the reducer performs a forward the interface has no control for",
   "lib/gym/actions.ts", 'return fail(state, "this interface has no forward control");',
                         'return { ok: true, state: next };  // MUTATED', LOOP),

  ("permanent delete stops deleting",
   "lib/gym/actions.ts", 'next.emails = next.emails.filter((e) => e.id !== email.id);',
                         '// MUTATED', LOOP),

  ("the prompt stops listing the actions, so the agent is told nothing",
   "lib/gym/serialize.ts", '${actionReference()}', '(see docs)  // MUTATED', LOOP),

  ("grading stops counting unrequested changes",
   "lib/gym/grade.ts", 'const extra = actual.filter((a) => !required.some((r) => r.path === a.path));',
                       'const extra: Change[] = [];  // MUTATED', ALL),

  ("grading stops noticing changes that never happened",
   "lib/gym/grade.ts", '''  const missing = required.filter(
    (r) => !actual.some((a) => a.path === r.path && same(a.after, r.after)),
  );''', '  const missing: Change[] = [];  // MUTATED', ALL),

  ("opening a message no longer marks it read",
   "lib/gym/actions.ts", '''      email.read = true;
      next.selectedId = email.id;
      return { state: next, ok: true };
    }
    case "star":''', '''      next.selectedId = email.id;
      return { state: next, ok: true };  // MUTATED
    }
    case "star":''', ALL),

  ("send stops filing a copy in sent",
   "lib/gym/actions.ts", 'next.emails.push({', 'if (false) next.emails.push({  // MUTATED', ALL),

  # --- the grader judging wrong answers, not just right ones ---

  ('the label list collapses back into one value, hiding an extra label',
   'lib/gym/grade.ts', '    for (const label of email.labels) {\n      out.set(`${prefix}.labels.${label}`, true);\n    }',
                        '    out.set(`${prefix}.labels`, email.labels.join("|"));  // MUTATED', GRADING),

  ("labels stop being case-folded, so 'Finance' fails the triage task",
   'lib/gym/actions.ts', 'String(args.name ?? "").trim().toLowerCase()',
                        'String(args.name ?? "").trim()  /* MUTATED */', GRADING),

  ('ids go back to being counted from the array length',
   'lib/gym/actions.ts', '      let n = next.emails.length + 1;\n      while (next.emails.some((e) => e.id === `sent-${n}`)) n++;',
                        '      const n = next.emails.length + 1;  // MUTATED', MATRIX),

  ('reading a message the task is about counts against the agent again',
   'lib/gym/grade.ts', 'const required = requiredRaw.filter((c) => !isIncidentalRead(c.path, touched));',
                        'const required = requiredRaw;  // MUTATED', GRADING),

  ('the email prefix is taken by stripping the last segment again',
   'lib/gym/grade.ts', '  const end = path.lastIndexOf(")");\n  return end === -1 ? path : path.slice(0, end + 1);',
                        '  return path.replace(/\\.[a-zA-Z]+$/, "");  // MUTATED', GRADING),

  ('a message can be starred without the grader noticing',
   'lib/gym/grade.ts', 'out.set(`${prefix}.starred`, email.starred);',
                        '// MUTATED', GRADING),


  # --- what survives leaving the process ---

  ('the environment accepts postMessage from any origin',
   'app/gym/page.tsx', 'if (event.origin !== window.location.origin) return;\n      if (!isToGym(event.data)) return;',
                        'if (!isToGym(event.data)) return;  // MUTATED: any origin', PERSIST),

  ('the marker check goes away, so any message can answer a request',
   'lib/bridge.ts', '(data as { marker?: unknown }).marker === GYM_ORIGIN_MARKER',
                        'true  /* MUTATED */', PERSIST),

  ('ready is accepted as a request to the environment',
   'lib/bridge.ts', 'return isFromGym(data) && (data as { type: string }).type !== "ready";',
                        'return isFromGym(data);  // MUTATED', PERSIST),

  ('a restored mailbox no longer gets its missing fields filled in',
   'lib/gym/state.ts', 'query: typeof saved.query === "string" ? saved.query : "",',
                        'query: saved.query as string,  // MUTATED', PERSIST),

  ('a corrupt folder in storage is trusted instead of reset',
   'lib/gym/state.ts', 'folder: FOLDER_ORDER.includes(saved.folder as Folder) ? (saved.folder as Folder) : "inbox",',
                        'folder: (saved.folder ?? "inbox") as Folder,  // MUTATED', PERSIST),


  # --- the paths that spend the user's quota ---

  ('a spent quota exits like any other empty batch',
   'runner/run.ts', 'process.exit(stopKind === "quota" ? 3 : 1);',
                        'process.exit(1);  // MUTATED', QUOTA),

  ('the recording script stops reading the stop code',
   'record-runs.sh', 'elif [ "$RUN_STATUS" -eq 3 ]; then',
                        'elif [ "$RUN_STATUS" -eq 99 ]; then  # MUTATED', QUOTA),

  ('orphaned screenshots are left behind again when nothing is recorded',
   'runner/run.ts', '  await pruneShots(published);',
                        '  // MUTATED', QUOTA),


  # --- what CI does with nobody watching ---

  ('a scheduled job starts spending the quota again',
   '.github/workflows/agent-runs.yml', 'on:\n  workflow_dispatch:',
                        'on:\n  schedule:\n    - cron: "0 4 * * 0"  # MUTATED\n  workflow_dispatch:', FLOW),

  ('a recording batch drops --append and replaces every other run',
   '.github/workflows/agent-runs.yml', '--all --append --mode',
                        '--all --mode  # MUTATED', FLOW),

  ('CI is allowed to authorise spending',
   '.github/workflows/agent-runs.yml', 'BUDGET: "0"',
                        'BUDGET: "5"  # MUTATED', FLOW),

  ('the browser is installed through npx again',
   '.github/workflows/agent-runs.yml', './runner/node_modules/.bin/playwright install --with-deps chromium',
                        'npx --prefix runner playwright install --with-deps chromium  # MUTATED', FLOW),

  ('the wait loop goes back to succeeding when nothing came up',
   '.github/workflows/agent-runs.yml', '          echo "::error::the app never started serving on port 3000"\n          exit 1',
                        '          # MUTATED', FLOW),

  ('CI stops running the mutation checks',
   '.github/workflows/ci.yml', 'python3 tools/loop-mutation-check.py',
                        '# MUTATED', FLOW),

  ('the runner goes back to being unchecked',
   '.github/workflows/ci.yml', '- run: npm run typecheck:runner',
                        '# MUTATED', FLOW),

  ('a push races whatever landed on main during the run',
   '.github/workflows/agent-runs.yml', '          git pull --rebase --autostash\n',
                        '  # MUTATED\n', FLOW),

  ('--mode silently accepts a typo and records the wrong action space',
   'runner/run.ts', 'if (requestedMode !== "tool" && requestedMode !== "computer") {',
                        'if (false) {  // MUTATED', CLI),


  # --- who may spend the key ---

  ('the run route is open to anyone again',
   'app/api/agent/route.ts', '  if (!(await isOwner(request))) {',
                        '  if (false) {  // MUTATED: the route is open again', OWNER),

  ('the owner cookie goes back to being a guessable constant',
   'lib/owner.ts', 'const data = new TextEncoder().encode(`clickgym-owner-v1:${passcode}:${window}`);',
                        'const data = new TextEncoder().encode("1");  // MUTATED', OWNER),

  ('an unconfigured deployment treats everyone as the owner',
   'lib/owner.ts', '  if (!passcode) return false;',
                        '  if (!passcode) return true;  // MUTATED', OWNER),

  ('tokens never expire',
   'lib/owner.ts', '  for (const candidate of [window, window - 1]) {',
                        '  for (const candidate of [window, window - 1, window - 2, window - 3, window - 4]) {  // MUTATED', OWNER),

  ('work happens before the caller is checked',
   'app/api/agent/route.ts', '  /*\n   * The gate, and it is the first thing here on purpose.',
                        '  const key = process.env.OPENROUTER_API_KEY;  // MUTATED: read before the check\n  /*\n   * The gate, and it is the first thing here on purpose.', OWNER),


  # --- production holds no key, so there is nothing to spend ---

  ('production can spend once a key is added, with no second thought',
   'lib/owner.ts', '  return Boolean(process.env.OPENROUTER_API_KEY) && ownerModeConfigured();',
                        '  return true;  // MUTATED', OWNER),

  ('an unavailable capability is reported as a permission problem',
   'app/api/agent/route.ts', '    if (!runsEnabled()) {',
                        '    if (false) {  // MUTATED', OWNER),

  ('the console stops reporting whether it can run anything',
   'app/api/session/route.ts', '    runs: runsEnabled(),',
                        '    // MUTATED', OWNER),

  ('the deployment verifier stops trying the forged cookie',
   'verify-deployment.sh', "-H 'Cookie: cg_owner=1'",
                        "-H 'Accept: */*'  # MUTATED", OWNER),

  ('the verifier treats a successful run as acceptable',
   'verify-deployment.sh', '  2*)  bad "IT RAN (${CODE}). Remove OPENROUTER_API_KEY from the deployment now." ;;',
                        '  2*)  ok "ran"  # MUTATED', OWNER),


  # --- the budget the model is measured against ---

  ('the turn budget stops depending on the action space',
   'lib/gym/tasks.ts', '  return task.maxTurns[mode];',
                        '  return task.maxTurns.tool;  // MUTATED', BUDGET),

  ('computer use is put back on the tool-calling budget',
   'lib/gym/tasks.ts', '    maxTurns: { tool: 12, computer: 26 },',
                        '    maxTurns: { tool: 12, computer: 12 },  // MUTATED', BUDGET),

  ('typing into a field is costed as a single interaction',
   'lib/gym/catalog.ts', '    effect: "Adds a label, lower-cased. Implies opening.",\n    clicks: 3,',
                        '    effect: "Adds a label, lower-cased. Implies opening.",\n    clicks: 1,  // MUTATED', BUDGET),

  ('the runner reads the budget without saying which space it is running',
   'runner/run.ts', 'const maxTurns = TURN_OVERRIDE ?? turnsFor(task, mode);',
                        'const maxTurns = TURN_OVERRIDE ?? task.maxTurns.tool;  // MUTATED', BUDGET),

  ('the computer driver is given the tool-calling budget',
   'lib/harness/execute-computer.ts', 'const maxTurns = turnsFor(task, "computer");',
                        'const maxTurns = turnsFor(task, "tool");  // MUTATED', BUDGET),


  # --- affordances the budget assumes exist ---

  ('the search box loses its clear control, so a second search costs seven turns',
   'components/MailApp.tsx', '                data-testid="search-clear"',
                        '                data-testid="search-cleared"  // MUTATED', BUDGET),

  ('the clear button stops clearing anything',
   'components/MailApp.tsx', 'onClick={() => dispatch({ name: "search", args: { query: "" } })}',
                        'onClick={() => undefined}  /* MUTATED */', BUDGET),

]

# ---------------------------------------------------------------- safety net
#
# Restore on the way out, whatever the way out is.
#
# The per-case `finally` covers a mutation that fails. It does not cover the
# process being killed between writing the mutant and writing the original back
# — a Ctrl-C, or a `timeout` wrapping the pre-push checks. That happened, and it
# left `# MUTATED` sitting in a workflow file where the next commit would have
# taken it. A tool that edits source in place has to survive its own death.

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
    # sys.exit from a handler raises SystemExit, so atexit still runs.
    signal.signal(_sig, lambda *_: sys.exit(130))

results = []
for name, rel, old, new, tests in CASES:
    path = pathlib.Path(rel)
    original = _stash(path)
    if old not in original:
        results.append((name, "SKIP - anchor not found"))
        continue
    path.write_text(original.replace(old, new, 1), encoding="utf-8")
    try:
        r = subprocess.run(["node", "--test", "--experimental-strip-types", *tests],
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
