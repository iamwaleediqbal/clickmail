import { NextResponse } from "next/server";

import { type Mode, freeModels } from "../../../lib/models.ts";

export const runtime = "edge";
export const revalidate = 600;

export async function GET(request: Request) {
  // ?mode=computer narrows the list to models that accept an image. The picker
  // asks for the mode it is about to run, so a blind model can never be chosen
  // for a run that will hand it a screenshot.
  const requested = new URL(request.url).searchParams.get("mode");
  const mode: Mode = requested === "computer" ? "computer" : "tool";

  try {
    const models = await freeModels(mode);
    return NextResponse.json({
      mode,
      models,
      // Said plainly, because "no models" and "no free vision models today" are
      // different problems and only one of them is worth waiting out.
      note:
        mode === "computer" && models.length <= 1
          ? "No free vision models are listed right now, so only the router is available."
          : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { models: [], error: String(error instanceof Error ? error.message : error) },
      { status: 502 },
    );
  }
}
