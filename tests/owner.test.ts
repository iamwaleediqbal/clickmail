import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  OWNER_COOKIE,
  isOwner,
  mintOwnerToken,
  ownerModeConfigured,
  readCookie,
  runsEnabled,
} from "../lib/owner.ts";

/**
 * Who may spend the model key.
 *
 * Unlike most of the checks in this repository these run the real thing rather
 * than reading it, because the property is behavioural: a forged cookie has to
 * actually be rejected, not merely look like it would be.
 *
 * The failure this exists for was live. `/api/agent` had no caller check at
 * all — the launcher was hidden from guests in the interface and the route was
 * open, so spending the deployment's free allowance took one `curl` against a
 * URL written down in a public repository. The first fix, a `cg_owner=1`
 * cookie, was not a fix: a constant is forgeable by anyone who can read the
 * constant, and the repository tells them what it is.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PASSCODE = "correct horse battery staple";
const HOUR = 60 * 60 * 1000;

function requestWith(cookie: string | null): Request {
  return new Request("https://example.test/api/agent", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

/**
 * Set the passcode for the duration of one test, then put it back.
 *
 * `await` inside, and that is not a detail. Written synchronously, the
 * `finally` restored the variable the moment the callback returned its promise
 * — before a single `await` inside it had run — so every assertion here saw no
 * passcode configured. The one test expecting an accepted token failed; the
 * four expecting a rejection passed, because "rejected" is also what an
 * unconfigured deployment returns. Four green tests proving nothing.
 */
async function withPasscode(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const before = process.env.OWNER_PASSCODE;
  if (value === undefined) delete process.env.OWNER_PASSCODE;
  else process.env.OWNER_PASSCODE = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.OWNER_PASSCODE;
    else process.env.OWNER_PASSCODE = before;
  }
}

/* ------------------------------------------------------------------ */

test("a minted token is accepted", async () => {
  await withPasscode(PASSCODE, async () => {
    const token = await mintOwnerToken(PASSCODE);
    assert.equal(await isOwner(requestWith(`${OWNER_COOKIE}=${token}`)), true);
  });
});

test("the value a reader of this repository would guess is rejected", async () => {
  await withPasscode(PASSCODE, async () => {
    for (const forged of ["1", "true", "owner", "yes", OWNER_COOKIE, ""]) {
      assert.equal(
        await isOwner(requestWith(`${OWNER_COOKIE}=${forged}`)),
        false,
        `"${forged}" was accepted as an owner token`,
      );
    }
  });
});

test("a token minted from a different passcode is rejected", async () => {
  const other = await mintOwnerToken("something else entirely");
  await withPasscode(PASSCODE, async () => {
    assert.equal(await isOwner(requestWith(`${OWNER_COOKIE}=${other}`)), false);
  });
});

test("no cookie at all is not an owner", async () => {
  await withPasscode(PASSCODE, async () => {
    assert.equal(await isOwner(requestWith(null)), false);
    assert.equal(await isOwner(requestWith("other=1; unrelated=2")), false);
  });
});

test("with no passcode configured, nobody is the owner", async () => {
  /*
   * Closed by default, deliberately. Treating "no passcode set" as "no gate"
   * would make the safe configuration the one nobody remembers to set up — and
   * this is a deployment that anybody can fork and put their own key into.
   */
  const token = await mintOwnerToken("");
  await withPasscode(undefined, async () => {
    assert.equal(ownerModeConfigured(), false);
    assert.equal(await isOwner(requestWith(`${OWNER_COOKIE}=${token}`)), false);
  });
});

test("a token stays valid for at least twelve hours, wherever the sign-in fell", async () => {
  /*
   * Windows are aligned to the epoch, not to when someone signed in, and the
   * previous window is accepted as well as the current one. So a token issued
   * at 11:59 is good for a little over twelve hours and one issued at 12:01 for
   * nearly twenty-four — the guarantee is the floor, not the ceiling.
   *
   * Both ends are checked, because the first version of this test assumed a
   * clean twelve hours from issue and failed on a sign-in an hour before the
   * boundary. Twelve hours is far longer than a run, which is what the property
   * is actually for: a session must not end in the middle of one.
   */
  await withPasscode(PASSCODE, async () => {
    const signIns = [
      Date.UTC(2026, 7, 24, 0, 0, 0), // start of a window
      Date.UTC(2026, 7, 24, 11, 59, 0), // one minute before it rolls over
      Date.UTC(2026, 7, 24, 12, 1, 0), // one minute after
    ];

    for (const issued of signIns) {
      const token = await mintOwnerToken(PASSCODE, issued);
      // The request is the same every time; it is the clock that moves, so the
      // hour belongs to isOwner rather than to the request being built.
      const presenting = () => requestWith(`${OWNER_COOKIE}=${token}`);

      assert.equal(await isOwner(presenting(), issued), true, `rejected immediately (${issued})`);
      assert.equal(
        await isOwner(presenting(), issued + HOUR),
        true,
        `expired within an hour (${issued})`,
      );
      assert.equal(
        await isOwner(presenting(), issued + 11 * HOUR),
        true,
        `expired inside the twelve-hour floor (${issued})`,
      );

      // A bearer token has to stop working on its own rather than because the
      // client was politely asked to drop the cookie.
      assert.equal(
        await isOwner(presenting(), issued + 25 * HOUR),
        false,
        `still accepted a day later (${issued})`,
      );
    }
  });
});

test("cookie parsing does not confuse one name for another", () => {
  const header = `not_${OWNER_COOKIE}=abc; ${OWNER_COOKIE}=def; ${OWNER_COOKIE}_x=ghi`;
  assert.equal(readCookie(header, OWNER_COOKIE), "def");
  assert.equal(readCookie(null, OWNER_COOKIE), null);
  assert.equal(readCookie("malformed", OWNER_COOKIE), null);
});

/* ------------------------------------------------------------------ */
/* The route wiring                                                    */
/* ------------------------------------------------------------------ */

test("the run route refuses a caller that is not the owner", () => {
  const source = read("app/api/agent/route.ts");

  assert.match(source, /if \(!\(await isOwner\(request\)\)\)/, "the route does not check the caller");
  assert.match(source, /status: 403/, "and it must refuse rather than fall through");
});

test("the check runs before anything else the request could cost", () => {
  /*
   * Ordering matters. Behind the check, an anonymous request cannot learn
   * whether a key is configured, cannot get its address recorded in the
   * throttle map, and cannot make the process parse a body it supplied.
   */
  const source = read("app/api/agent/route.ts");
  const post = source.slice(source.indexOf("export async function POST"));

  const gate = post.indexOf("await isOwner(request)");
  assert.notEqual(gate, -1, "there is no gate in POST");

  for (const [what, needle] of [
    ["the model key is read", "process.env.OPENROUTER_API_KEY"],
    ["the address is throttled", "throttled(ip)"],
    ["the body is parsed", "await request.json()"],
  ] as const) {
    const at = post.indexOf(needle);
    assert.ok(at > gate, `${what} before the caller is checked`);
  }
});

test("both routes decide who the owner is the same way", () => {
  // Two files that must agree, only one of which gets edited, is how the
  // reducer and the interface drifted apart earlier in this project.
  for (const file of ["app/api/agent/route.ts", "app/api/session/route.ts"]) {
    assert.match(read(file), /from "\.\.\/\.\.\/\.\.\/lib\/owner\.ts"/, `${file} does not use lib/owner.ts`);
  }
  assert.ok(
    !/cg_owner=1/.test(read("app/api/session/route.ts")),
    "the constant cookie is still being issued",
  );
});

test("the passcode never reaches the browser", () => {
  // Next inlines anything named NEXT_PUBLIC_ into the client bundle.
  for (const file of ["lib/owner.ts", "app/api/session/route.ts", "app/api/agent/route.ts"]) {
    assert.ok(
      !/NEXT_PUBLIC_[A-Z_]*PASS/.test(read(file)),
      `${file} would ship the passcode to every visitor`,
    );
  }
  assert.match(read(".env.example"), /OWNER_PASSCODE=/, "the variable should be documented");
  assert.ok(
    !/OWNER_PASSCODE=\S/.test(read(".env.example")),
    ".env.example must not carry a real passcode",
  );
});

test("a lapsed session is not recorded as a model that failed", () => {
  /*
   * A run that stops because the twelve hours ran out measured nothing about
   * the model. Averaging it in as a failure biases every number computed
   * afterwards, which is the same reason a transport error is unscored.
   */
  for (const file of ["lib/harness/execute.ts", "lib/harness/execute-computer.ts"]) {
    assert.match(
      read(file),
      /response\.status === 401 \|\| response\.status === 403/,
      `${file} treats a lapsed session as a run the model lost`,
    );
  }

  // And config_error must stay outside the scored set, or the above is moot.
  assert.match(
    read("lib/harness/runs.ts"),
    /status !== "infrastructure_error" && run\.status !== "config_error"/,
    "config_error is being counted as evidence about a model",
  );
});

test("every route that can reach the model key checks the caller first", () => {
  /*
   * The generalisation, so this cannot be reintroduced under a different name.
   * `/api/agent` was the only open route the day it was found; the rule is that
   * a route touching the key is a route that has to know who is asking.
   *
   * `/api/models` is deliberately not in scope: it reads OpenRouter's public
   * catalogue with no key and no authorisation, spends nothing, and is cached —
   * so it stays open, because the tools page shows it to everyone.
   */
  const dir = path.join(ROOT, "app/api");
  const routes = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `app/api/${entry.name}/route.ts`)
    .filter((rel) => existsSync(path.join(ROOT, rel)));

  assert.ok(routes.length >= 3, `found ${routes.length} routes — the scan is broken`);

  for (const rel of routes) {
    const source = read(rel);
    // The sign-in route names the passcode, not the model key; it is the thing
    // that decides ownership rather than something that spends against it.
    if (!source.includes("OPENROUTER_API_KEY")) continue;
    assert.match(
      source,
      /await isOwner\(request\)/,
      `${rel} can reach the model key without checking who is calling`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The production posture: no key, so nothing to spend                 */
/* ------------------------------------------------------------------ */

test("a deployment without a model key cannot run anything, for anyone", async () => {
  /*
   * The guarantee the deployed site actually rests on, and it is a stronger
   * one than the owner check: a permission check is code, and this code
   * regressed once and shipped open. An environment with no key is not a check
   * that could fail — there is nothing there to spend.
   *
   * Note this is false even for a *correct* owner token. That is the point.
   */
  const before = { key: process.env.OPENROUTER_API_KEY, pass: process.env.OWNER_PASSCODE };
  try {
    process.env.OWNER_PASSCODE = PASSCODE;
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(runsEnabled(), false, "runs are enabled with no key");

    // The owner is still the owner. There is simply nothing for them to spend.
    const token = await mintOwnerToken(PASSCODE);
    assert.equal(await isOwner(requestWith(`${OWNER_COOKIE}=${token}`)), true);

    process.env.OPENROUTER_API_KEY = "sk-or-v1-whatever";
    delete process.env.OWNER_PASSCODE;
    assert.equal(runsEnabled(), false, "runs are enabled with a key but no owner");

    process.env.OWNER_PASSCODE = PASSCODE;
    assert.equal(runsEnabled(), true, "both present and runs are still refused");
  } finally {
    if (before.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before.key;
    if (before.pass === undefined) delete process.env.OWNER_PASSCODE;
    else process.env.OWNER_PASSCODE = before.pass;
  }
});

test("the run route says which of the two refusals it is", () => {
  // "You are not allowed" and "this cannot do that at all" are different facts.
  // Dressing the second up as the first tells a visitor something untrue about
  // how the site works.
  const source = read("app/api/agent/route.ts");

  assert.match(source, /if \(!runsEnabled\(\)\)/, "the route cannot tell the two apart");
  assert.match(source, /status: 503/, "an unavailable capability is not a permission error");
  assert.match(source, /status: 403/, "and a permission error is still a permission error");

  // Both branches must sit behind the owner check, so neither can be used to
  // probe an anonymous request for how the deployment is configured.
  const post = source.slice(source.indexOf("export async function POST"));
  assert.ok(
    post.indexOf("runsEnabled()") > post.indexOf("await isOwner(request)"),
    "the posture is read before the caller is checked",
  );
});

test("the console can tell a visitor why there is no launcher", () => {
  assert.match(read("app/api/session/route.ts"), /runs: runsEnabled\(\)/);
});

test("nothing reaches a provider without the key being present", () => {
  /*
   * The belt to the braces. Every place that can call OpenRouter's completion
   * endpoint has to read the key from the environment first — so an absent key
   * is not merely a refused request, it is a request that cannot be built.
   */
  for (const file of ["app/api/agent/route.ts", "runner/run.ts"]) {
    const source = read(file);
    if (!/chat\/completions/.test(source)) continue;
    assert.match(
      source,
      /process\.env\.OPENROUTER_API_KEY/,
      `${file} calls a provider without taking the key from the environment`,
    );
    assert.ok(
      !/sk-or-v1-[A-Za-z0-9]{8}/.test(source),
      `${file} appears to contain a literal key`,
    );
  }
});

test("the read-only posture is verifiable from outside, not just asserted here", () => {
  /*
   * Everything above checks code in this repository. The actual guarantee is a
   * Vercel environment variable, which this repository cannot see — so there
   * has to be a way to check the running site, and it has to try the things an
   * attacker would rather than the things we hope are true.
   */
  const script = readFileSync(path.join(ROOT, "verify-deployment.sh"), "utf8");

  assert.match(script, /api\/agent/, "it never tries the route that would cost money");

  /*
   * Anchored to the request, not to the string. Written as `/cg_owner=1/` this
   * passed with the header deleted, because the success message mentions the
   * cookie by name — the same substring-matching mistake this suite keeps
   * catching, made once more in the test written to prevent it.
   */
  const sendsForgedCookie = script
    .split("\n")
    .some((line) => /Cookie:/.test(line) && /cg_owner=1/.test(line) && !line.trim().startsWith("#"));
  assert.ok(sendsForgedCookie, "it never actually sends the forged cookie the old gate accepted");

  // Every 2xx branch, not merely one of them: a run that succeeded is a failure
  // of the deployment, wherever it was observed.
  const successBranches = script
    .split("\n")
    .filter((line) => /^\s*2\*\)/.test(line));
  assert.ok(successBranches.length >= 2, `only ${successBranches.length} 2xx branch(es) found`);
  for (const branch of successBranches) {
    assert.match(branch, /\bbad\b/, `a 2xx answer is not treated as a failure: ${branch.trim()}`);
  }
  assert.ok(!/OWNER_PASSCODE=\S/.test(script), "it must not carry a passcode of its own");
  // Checked against what the script *does*, not what it says. The first version
  // of this matched the phrase "signs in" and failed on the comment explaining
  // that it never does — an assertion reading prose rather than behaviour.
  const requests = script
    .split("\n")
    .filter((line) => /\bcurl\b|status |body /.test(line) && !line.trim().startsWith("#"));

  assert.ok(
    !requests.some((line) => /-X POST/.test(line) && /api\/session/.test(line)),
    "it signs in, which spends the very thing it is checking",
  );
});
