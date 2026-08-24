import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "clickgym",
  description:
    "A browser gym for agents. Grades the final state of the app, not the route the agent took.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
