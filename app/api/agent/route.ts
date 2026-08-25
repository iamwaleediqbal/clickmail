/**
 * Model proxy.
 *
 * Exists to keep the API key out of the browser, and to make a run on free
 * models actually finish. Free pools are shared and throttle in bursts, so a
 * 429 is the normal case: requests are retried with backoff, then retried
 * against other capable free models.
 */

import { NextResponse } from "next/server";

import { isOwner, runsEnabled } from "../../../lib/owner.ts";

import { isClassifierVerdict } from "../../../lib/agent/classify.ts";
import {
  FREE_ONLY,
  type Mode,
  ROUTER,
  freeModels,
  isAllowed,
  reasoningOption,
  rejectsReasoning,
} from "../../../lib/models.ts";

export const runtime = "edge";

const MAX_MESSAGES = 40;
const MAX_TOKENS = 400;
/**
 * Computer use needs far more room than the reply itself suggests.
 *
 * Reasoning tokens come out of this same allowance. Measured: at 900 with
 * minimal reasoning, three turns in twelve arrived truncated mid-object and
 * were recorded as parse failures — indistinguishable in the run from a model
 * that cannot produce JSON, when it was a model that ran out of room.
 *
 * Raising the ceiling is free. Only tokens actually generated are billed, and
 * the prompt caps the thought at 25 words; this exists to stop a runaway, not
 * to shape the answer.
 */
const MAX_TOKENS_COMPUTER = 2500;

const ATTEMPTS = 3;
const FALLBACKS = 2;
/**
 * 429 is deliberately absent.
 *
 * A rate limit is a statement about the account, not the request. Every free
 * model draws on the same pool, so retrying with backoff and then falling
 * through to the next model spends requests that were never going to succeed —
 * six per turn, in a batch that measured nothing. Stop on the first one and say
 * so instead.
 */
const RETRYABLE = new Set([408, 409, 500, 502, 503, 504]);

/** Per-instance and best effort. The real ceiling is the provider's own quota. */
const WINDOW_MS = 60_000;
const PER_WINDOW = 12;
const hits = new Map<string, number[]>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Attempt {
  ok: boolean;
  status: number;
  content?: string;
  /** The provider's chain of thought, when one was requested and returned. */
  reasoning?: string;
  usage?: unknown;
  /** OpenRouter reports what a call actually cost, in credits. */
  cost?: number;
  /** Plain English. Raw upstream bodies never reach the browser. */
  reason?: string;
  retryable: boolean;
  /** The endpoint answered, but it is not an assistant. Never retry it. */
  wrongClass?: boolean;
  /** The account is out of requests. Stop, do not try another model. */
  quota?: boolean;
  /** The call cost money. Never continue; something upstream is misconfigured. */
  billed?: boolean;
}

async function callModel(
  key: string,
  model: string,
  messages: unknown[],
  referer: string,
  maxTokens: number,
): Promise<Attempt> {
  let last: Attempt = { ok: false, status: 0, retryable: true, reason: "no attempt made" };

  let dropReasoning = false;

  for (let attempt = 0; attempt < ATTEMPTS + 1; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": referer,
          "X-Title": "clickgym",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: maxTokens,
          // Refuses rather than bills. Nothing here may ever cost money.
          provider: FREE_ONLY,
          // Held to the minimum the endpoint allows; dropped entirely if the
          // model says it will not accept the field.
          ...(dropReasoning ? {} : reasoningOption()),
        }),
      });
    } catch {
      last = { ok: false, status: 0, retryable: true, reason: "the request did not complete" };
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 401, retryable: false, reason: "the API key was rejected" };
    }

    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        retryable: false,
        reason: "the free tier is out of requests or throttling",
        quota: true,
      };
    }

    if (RETRYABLE.has(response.status)) {
      last = {
        ok: false,
        status: response.status,
        retryable: true,
        reason: `the provider returned ${response.status}`,
      };
      continue;
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ").trim();
      } catch {
        /* unreadable body */
      }

      // The model named the field it objected to. Drop it and try again rather
      // than failing the turn over one parameter.
      if (response.status === 400 && rejectsReasoning(detail) && !dropReasoning) {
        dropReasoning = true;
        continue;
      }

      return {
        ok: false,
        status: response.status,
        retryable: false,
        reason: `the provider rejected the request (${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }

    let payload: {
      error?: { message?: string; code?: number };
      choices?: { message?: { content?: string; reasoning?: string } }[];
      usage?: unknown;
    };
    try {
      payload = await response.json();
    } catch {
      last = { ok: false, status: 502, retryable: true, reason: "the provider sent a malformed reply" };
      continue;
    }

    // Upstream provider failures arrive inside a 200 body, which is how a
    // throttled model slips past a status-code check.
    if (payload.error) {
      const code = Number(payload.error.code ?? 0);
      if (code === 429) {
        return {
          ok: false,
          status: 429,
          retryable: false,
          reason: "the free tier is out of requests or throttling",
          quota: true,
        };
      }
      const retryable = RETRYABLE.has(code) || code === 0;
      last = {
        ok: false,
        status: code || 502,
        retryable,
        reason: "the provider reported an error",
      };
      if (!retryable) return last;
      continue;
    }

    const content = payload.choices?.[0]?.message?.content ?? "";
    const reasoning = payload.choices?.[0]?.message?.reasoning ?? undefined;

    // A 200 with nothing in it is a failed call wearing a success code. Free
    // pools return these under load, and accepting one spends a turn of the
    // agent's budget on a reply that never existed.
    if (!content.trim()) {
      last = {
        ok: false,
        status: 502,
        retryable: true,
        reason: "the provider returned an empty reply",
      };
      continue;
    }

    if (isClassifierVerdict(content)) {
      // Not retryable against the same model — it will answer the same way
      // every time. The caller moves on to the next one in the chain.
      return {
        ok: false,
        status: 502,
        retryable: true,
        reason: `${model} is a safety classifier, not an assistant`,
        wrongClass: true,
      };
    }

    const usage = payload.usage as { cost?: number } | undefined;
    const cost = typeof usage?.cost === "number" ? usage.cost : 0;

    // The backstop behind the price cap and the catalogue filter. If a request
    // ever bills, the answer is discarded and the caller is told plainly rather
    // than a charge being absorbed quietly turn after turn.
    if (cost > 0) {
      return {
        ok: false,
        status: 402,
        retryable: false,
        reason: `${model} charged ${cost} credits — this deployment runs on free models only`,
        billed: true,
      };
    }

    return {
      ok: true,
      status: 200,
      content,
      reasoning,
      usage: payload.usage ?? null,
      cost,
      retryable: false,
    };
  }

  return last;
}

export async function POST(request: Request) {
  /*
   * The gate, and it is the first thing here on purpose.
   *
   * Before this, the launcher was hidden from guests in the interface and this
   * route was open to anyone — so spending the deployment's free allowance took
   * one `curl` against a URL that is written down in a public repository. The
   * hidden button was never the control; it only looked like one.
   *
   * Checked before the key is read, before the body is parsed and before the
   * throttle records an address, so an anonymous request learns nothing about
   * how this deployment is configured and costs it nothing to receive.
   */
  if (!(await isOwner(request))) {
    /*
     * Two different refusals, because they are two different facts and a
     * visitor deserves the true one.
     *
     * On the deployed site there is no model key, so nothing here can reach a
     * provider no matter who is asking — 503, "this does not run models". Said
     * plainly rather than dressed up as a permission problem, because it is not
     * one: the capability is absent, not withheld.
     *
     * Where a key IS configured — locally, where showing a live run is the
     * point — it is a permission problem, and 403 is the honest answer.
     *
     * Both read the environment only after the caller has been checked, so an
     * anonymous request still costs nothing and cannot probe for a key.
     */
    if (!runsEnabled()) {
      return NextResponse.json(
        {
          error: "unavailable",
          detail:
            "This deployment does not run models. It has no model key, so no request from it " +
            "can reach a provider. The runs on the console were recorded elsewhere and committed " +
            "as a file — that file is the evidence, and it only changes when someone pushes.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        error: "forbidden",
        detail:
          "Starting a run spends this deployment's model quota, so it is limited to the owner. " +
          "The recorded runs on the console are the same measurement, already made.",
      },
      { status: 403 },
    );
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "config", detail: "This deployment has no model key configured." },
      { status: 401 },
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (throttled(ip)) {
    return NextResponse.json(
      { error: "transport", detail: "Too many runs from this address. Try again in a minute." },
      { status: 502 },
    );
  }

  let body: { model?: string; messages?: unknown; mode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const requested = String(body.model ?? "");
  // The mode decides which capability filter the fallback chain draws from.
  // Falling back from a vision model to a text-only one would hand a screenshot
  // to something that cannot see it and record the result as a model failure.
  const mode: Mode = body.mode === "computer" ? "computer" : "tool";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length || messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Bad conversation length." }, { status: 400 });
  }

  let available: { id: string }[];
  try {
    if (!(await isAllowed(requested, mode))) {
      return NextResponse.json(
        {
          error:
            mode === "computer"
              ? `${requested} is not an available free model that accepts images.`
              : `${requested} is not an available free model with the capabilities this needs.`,
        },
        { status: 400 },
      );
    }
    available = await freeModels(mode);
  } catch {
    return NextResponse.json(
      { error: "transport", detail: "Could not reach the model list." },
      { status: 502 },
    );
  }

  const referer = process.env.SITE_URL ?? "http://localhost:3000";
  const maxTokens = mode === "computer" ? MAX_TOKENS_COMPUTER : MAX_TOKENS;

  /**
   * The router is a starting point, never the whole chain.
   *
   * `openrouter/free` selects among free models on its own and is not bound by
   * the capability filter applied to everything else, so it can and does route
   * an agent prompt to a safety classifier. Following it with vetted concrete
   * models means one bad selection costs a retry rather than the whole run —
   * which is what it cost before this list had a tail.
   */
  const vetted = available.map((m) => m.id).filter((id) => id !== ROUTER.id);
  const chain =
    requested === ROUTER.id
      ? [ROUTER.id, ...vetted].slice(0, 1 + FALLBACKS)
      : [requested, ...vetted.filter((id) => id !== requested)].slice(0, 1 + FALLBACKS);

  let reason = "";
  let tried = 0;
  for (const model of chain) {
    tried += 1;
    const attempt = await callModel(key, model, messages, referer, maxTokens);

    if (attempt.ok) {
      return NextResponse.json({
        content: attempt.content,
        reasoning: attempt.reasoning,
        usage: attempt.usage,
        cost: attempt.cost ?? 0,
        model,
        fellBack: model !== requested,
      });
    }

    reason = attempt.reason ?? "the request failed";
    if (attempt.status === 401) {
      return NextResponse.json(
        { error: "config", detail: "The API key was rejected." },
        { status: 401 },
      );
    }
    if (attempt.billed) {
      return NextResponse.json(
        {
          error: "config",
          detail:
            "A model reported a non-zero cost, so the run was stopped. This deployment is configured to use free models only.",
        },
        { status: 402 },
      );
    }
    if (attempt.quota) {
      return NextResponse.json(
        {
          error: "transport",
          detail:
            "The free tier is out of requests right now. Every free model draws on the same pool, so trying another one would not help. It resets on its own.",
        },
        { status: 429 },
      );
    }
    if (!attempt.retryable) break;
  }

  return NextResponse.json(
    {
      error: "transport",
      detail: `Tried ${tried} free model${tried > 1 ? "s" : ""} and ${reason}. Free pools throttle in bursts; this usually clears within a minute.`,
    },
    { status: 502 },
  );
}
