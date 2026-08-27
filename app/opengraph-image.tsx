import { ImageResponse } from "next/og";

/**
 * The social preview card.
 *
 * Same template as agentscore's, in the other accent, because the two get
 * pasted next to each other and two identical cards would read as one link
 * posted twice.
 *
 * Colours are the theme's dark palette written as hex — Satori, the renderer
 * behind ImageResponse, has no oklch(). They correspond to --background,
 * --foreground and --chart-2 in globals.css.
 */
export const alt = "clickmail — a web application built to be driven by an agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * One weight only.
 *
 * ImageResponse ships a single regular face of Noto Sans and nothing else, so
 * `fontWeight: 700` renders identically to no fontWeight at all — it was here,
 * it did nothing, and it read as a bug when the card came out lighter than
 * intended. Hierarchy comes from size and colour instead. Anyone wanting real
 * bold has to pass a font buffer to ImageResponse; do that or leave weights
 * out, but do not declare one and assume it landed.
 */
const INK = "#FAFAF9";
const GROUND = "#1C1917";
const MUTED = "#A8A29E";
const ACCENT = "#E2643A";

/**
 * The last one is the thesis, not a boast. An environment holding its own
 * grader can only ever score itself.
 */
const FACTS = [
  { value: "52", label: "messages across 7 folders" },
  { value: "3", label: "method automation contract" },
  { value: "0", label: "graders inside it" },
];

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: GROUND,
          padding: "72px 76px 64px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: 10,
            background: `linear-gradient(90deg, ${ACCENT}, rgba(226,100,58,0))`,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: ACCENT }} />
          <div style={{ fontSize: 22, color: MUTED, letterSpacing: 1.6 }}>
            CLICKMAIL-SIGMA.VERCEL.APP/GYM
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 104, color: INK, letterSpacing: -3 }}>
            clickmail
          </div>
          <div style={{ marginTop: 18, fontSize: 36, color: MUTED, lineHeight: 1.35, maxWidth: 900 }}>
            A mail client that exists to be operated by something that is not a person, and to
            say what state it is in.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 56 }}>
          {FACTS.map((fact) => (
            <div key={fact.label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 52, color: ACCENT, letterSpacing: -1.5 }}>
                {fact.value}
              </div>
              <div style={{ marginTop: 6, fontSize: 24, color: MUTED }}>{fact.label}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
