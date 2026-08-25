/**
 * Owner sign-in.
 *
 * This decides who may spend the deployment's model key, so it is a real check
 * rather than a flag the client sets for itself. See `lib/owner.ts` for what
 * the cookie carries and why a constant was not enough.
 */

import { NextResponse } from "next/server";

import {
  OWNER_COOKIE,
  OWNER_MAX_AGE,
  isOwner,
  mintOwnerToken,
  ownerModeConfigured,
  runsEnabled,
} from "../../../lib/owner.ts";

export const runtime = "edge";

export async function GET(request: Request) {
  return NextResponse.json({
    owner: await isOwner(request),
    // Without a passcode configured there is no owner mode to offer, and the
    // sign-in control hides rather than failing when pressed.
    enabled: ownerModeConfigured(),
    // Whether this deployment could run anything even for an owner. False in
    // production, where the model key is deliberately absent.
    runs: runsEnabled(),
  });
}

export async function POST(request: Request) {
  const expected = process.env.OWNER_PASSCODE;
  if (!expected) {
    return NextResponse.json(
      { owner: false, error: "Owner mode is not configured on this deployment." },
      { status: 501 },
    );
  }

  let passcode = "";
  try {
    passcode = String(((await request.json()) as { passcode?: unknown }).passcode ?? "");
  } catch {
    return NextResponse.json({ owner: false, error: "Malformed request." }, { status: 400 });
  }

  if (passcode !== expected) {
    return NextResponse.json({ owner: false, error: "That passcode is not right." }, { status: 401 });
  }

  const response = NextResponse.json({ owner: true });
  response.cookies.set(OWNER_COOKIE, await mintOwnerToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OWNER_MAX_AGE,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ owner: false });
  response.cookies.set(OWNER_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
