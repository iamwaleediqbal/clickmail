/**
 * The only server-side code in this project.
 *
 * It exists for one reason: the OpenRouter key must never reach the browser.
 * Everything else, the mailbox, the action execution, the grading, runs on the
 * client, which is why this deploys to a free Vercel plan and stays there.
 */

import { NextResponse } from "next/server";

export const runtime = "edge";

/**
 * Allowlist, not a passthrough.
 *
 * The model id arrives from the browser. Without this list, a public endpoint
 * with a key behind it lets anyone bill an expensive model to my account, and
 * they would be right to. Free variants only.
 */
const ALLOWED = new Set([
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "microsoft/phi-3-medium-128k-instruct:free",
]);

const MAX_MESSAGES = 40;
const MAX_TOKENS = 400;

/**
 * Best-effort throttle.
 *
 * Module scope on a serverless runtime is per-instance and gets recycled, so
 * this catches a single impatient visitor and not a determined one. The real
 * ceiling is OpenRouter's own daily quota, which is a spend limit rather than
 * a hope. Saying that plainly is better than implying this is a security
 * control.
 */
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

export async function POST(request: Request) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "This deployment has no model key configured." },
      { status: 503 },
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  if (throttled(ip)) {
    return NextResponse.json(
      { error: "Too many runs from this address. Try again in a minute." },
      { status: 429 },
    );
  }

  let body: { model?: string; messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const model = String(body.model ?? "");
  if (!ALLOWED.has(model)) {
    return NextResponse.json({ error: `Model ${model} is not available here.` }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length || messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Bad conversation length." }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter attributes free-tier usage to this. Set SITE_URL in
        // Vercel once the deployment has a URL; the fallback is only for local dev.
        "HTTP-Referer": process.env.SITE_URL ?? "http://localhost:3000",
        "X-Title": "clickgym",
      },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: MAX_TOKENS }),
    });
  } catch {
    // Distinguished from a model failure all the way to the UI, because a run
    // that never reached a model says nothing about the model.
    return NextResponse.json({ error: "transport", detail: "upstream unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 300);
    return NextResponse.json({ error: "transport", detail }, { status: 502 });
  }

  const payload = await upstream.json();
  // OpenRouter reports upstream provider failures inside a 200 body.
  if (payload?.error) {
    return NextResponse.json(
      { error: "transport", detail: String(payload.error?.message ?? "upstream error") },
      { status: 502 },
    );
  }

  return NextResponse.json({
    content: payload?.choices?.[0]?.message?.content ?? "",
    usage: payload?.usage ?? null,
  });
}
