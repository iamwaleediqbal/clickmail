import type { Metadata } from "next";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

/**
 * The deployed origin. `metadataBase` is what turns the generated
 * opengraph-image into an absolute URL — LinkedIn and Slack will not fetch a
 * relative one, so without this the card silently has no picture.
 */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://clickmail-sigma.vercel.app";

const DESCRIPTION =
  "A mail client that exists to be operated by an agent, and to say what state it is in.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "clickmail", template: "%s — clickmail" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "clickmail",
    title: "clickmail — a web application built to be driven by an agent",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "clickmail — a web application built to be driven by an agent",
    description: DESCRIPTION,
  },
};

/**
 * No application chrome.
 *
 * There was a navigation bar here — Overview, Tasks, Runs, Tools — because this
 * repository used to be the harness as well as the environment. It is only the
 * environment now, and an environment under test should not wear a frame around
 * it: the harness screenshots this page, and a header nobody is being asked to
 * click is one more thing for a model to mistake for the task.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
