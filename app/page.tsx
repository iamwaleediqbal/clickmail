import { ArrowRight, Mail } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { FOLDER_ORDER } from "@/lib/mail/state";

/**
 * What this is, before you are dropped into a mailbox.
 *
 * The gym is a public application. Anyone can open it, click around, and see
 * exactly what an agent is asked to operate — which is most of what makes a
 * score meaningful. A visitor who has used the thing knows what "archive the
 * newsletter" is actually asking for.
 *
 * There is nothing else here on purpose. No tasks, no grading, no runs, no
 * key. Those belong to the harness, which drives this page from outside.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-4">
        <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
          <Mail className="size-3.5" aria-hidden />
          Environment under test
        </span>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">clickmail</h1>
        <p className="text-lg leading-relaxed text-muted-foreground">
          A mail client that exists to be operated by something that is not a person. It holds
          fifty-two messages across {FOLDER_ORDER.length} folders and knows nothing about
          tasks, grading or models — it just is a mailbox, and it will tell an automated
          driver what state it is in.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/gym">
            Open the mailbox
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <a href="https://github.com/iamwaleediqbal/clickmail">Source</a>
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Why it is separate.</span> Grading an
          agent and being the thing it operates are two jobs. Keeping them in one repository
          made the second look like a feature of the first, and made &ldquo;point it at a real
          application&rdquo; sound out of scope.
        </p>
        <p>
          The harness lives at{" "}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href="https://github.com/iamwaleediqbal/agentscore"
          >
            agentscore
          </a>
          . It drives this page with a real browser, reads the world before and after, and
          decides whether what changed was what was asked for.
        </p>
      </div>
    </main>
  );
}
