import type { Metadata } from "next";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "clickmail", template: "%s — clickmail" },
  description:
    "A mail client that exists to be operated by an agent, and to say what state it is in.",
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
