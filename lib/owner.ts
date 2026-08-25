/**
 * Who is allowed to spend the model key.
 *
 * The console hid its launcher from guests and left `/api/agent` open, which is
 * not a gate — it is a gate drawn on the front end. Anyone reading this public
 * repository could see the route, post to it, and spend the deployment's free
 * allowance from a terminal without ever loading the page.
 *
 * The cookie was `cg_owner=1`, which does not fix it either: a constant is
 * forgeable by anyone who knows the constant, and this file tells them. `httpOnly`
 * stops a script on the page from *reading* it and does nothing to stop a client
 * from *sending* one.
 *
 * So the cookie carries a value that cannot be produced without the passcode: a
 * SHA-256 of the passcode and the current time window. The server recomputes it
 * per request and compares. Nothing is stored, which suits a deployment with no
 * database, and the window gives real expiry rather than expiry the client is
 * politely asked to observe.
 *
 * What this is not: it is one shared passcode, and the cookie is a bearer token
 * for as long as its window lasts. It gates spending on a demo. It is not an
 * identity system and should not be described as one.
 */

export const OWNER_COOKIE = "cg_owner";

/** How long one token stays valid. The previous window is accepted too, so a
 *  session does not end mid-run on a boundary — 12 to 24 hours in practice. */
const WINDOW_MS = 12 * 60 * 60 * 1000;

export const OWNER_MAX_AGE = WINDOW_MS / 1000;

function currentWindow(now: number): number {
  return Math.floor(now / WINDOW_MS);
}

async function digest(passcode: string, window: number): Promise<string> {
  const data = new TextEncoder().encode(`clickgym-owner-v1:${passcode}:${window}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The value to put in the cookie once a passcode has been accepted. */
export async function mintOwnerToken(passcode: string, now = Date.now()): Promise<string> {
  return digest(passcode, currentWindow(now));
}

/**
 * Compare without leaking where two strings first differ.
 *
 * Almost certainly unnecessary against a network attacker on a serverless
 * platform, and it costs four lines. Comparing secrets with `===` is the kind
 * of detail that is embarrassing to explain afterwards.
 */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * Whether this request may start a run.
 *
 * Closed by default: with no `OWNER_PASSCODE` configured there is no owner, so
 * a deployment that forgot to set one cannot have runs started through it at
 * all. The alternative — treating "no passcode" as "no gate" — makes the safe
 * configuration the one nobody sets up.
 */
export async function isOwner(request: Request, now = Date.now()): Promise<boolean> {
  const passcode = process.env.OWNER_PASSCODE;
  if (!passcode) return false;

  const presented = readCookie(request.headers.get("cookie"), OWNER_COOKIE);
  if (!presented) return false;

  const window = currentWindow(now);
  for (const candidate of [window, window - 1]) {
    if (equal(presented, await digest(passcode, candidate))) return true;
  }
  return false;
}

export function ownerModeConfigured(): boolean {
  return Boolean(process.env.OWNER_PASSCODE);
}

/**
 * Whether this deployment can start a run at all.
 *
 * The production posture is that it cannot: **the model key is not set on the
 * deployed environment.** Runs are recorded locally or from a workflow started
 * by hand, and reach the site as a committed file.
 *
 * That is a stronger guarantee than the owner check above, and it is the one
 * worth relying on. A permission check is code, and code regresses — this one
 * did, and shipped open. A deployment with no key is not a check that could
 * fail; there is simply nothing there to spend. Whoever gets past the gate
 * finds an empty room.
 *
 * The gate stays anyway, for the case where a key IS present: locally, where
 * showcasing a live run is the point.
 */
export function runsEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY) && ownerModeConfigured();
}
