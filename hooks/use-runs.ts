"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useSession } from "@/hooks/use-session";
import { loadPublished } from "@/lib/harness/published";
import { SEEDED_RUNS } from "@/lib/harness/seeded";
import {
  type RunRecord,
  deleteRun,
  loadRuns,
  mergeWithSeeded,
  saveRun,
} from "@/lib/harness/runs";

/**
 * What a viewer sees, and why it is not what the owner sees.
 *
 * The deployment is read-only to everyone but the owner: starting a run spends
 * a model call, so guests cannot. It follows that a guest's local storage can
 * only ever hold runs from a session where they were signed in — or nothing at
 * all — and treating it as a source would make the page show different evidence
 * to different people while claiming to be a record of the same thing.
 *
 * So the committed file is the source of truth. `public/runs/index.json` is
 * what was measured, reviewed and pushed; everyone opening the site sees that
 * and only that. Local runs are additive, and only for the owner, who produced
 * them and knows they are not published.
 *
 * The seeded samples exist so the platform is never an empty shell before
 * anything has been recorded. Once real runs are published they are redundant
 * and worse than redundant — a fabricated row sitting beside measured ones,
 * distinguished only by a badge, invites exactly the confusion the badge is
 * there to prevent. So they retire the moment real data exists.
 */
export function useRuns() {
  const session = useSession();
  const [stored, setStored] = useState<RunRecord[]>([]);
  const [published, setPublished] = useState<RunRecord[]>([]);
  // Storage is only readable on the client; rendering before that would not
  // match the server output and would trip hydration.
  const [storageRead, setStorageRead] = useState(false);
  // Published runs arrive over the network. A detail page that renders "not
  // found" before that fetch settles would flash the wrong answer at anyone
  // opening a link to one, so readiness waits for both sources.
  const [publishedRead, setPublishedRead] = useState(false);

  useEffect(() => {
    setStored(loadRuns());
    setStorageRead(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadPublished(controller.signal).then((found) => {
      setPublished(found);
      setPublishedRead(true);
    });
    return () => controller.abort();
  }, []);

  const runs = useMemo(() => {
    const measured = published.length ? published : SEEDED_RUNS;
    // Until the session resolves, show the published set. Guessing "owner" and
    // being wrong would flash someone else's local runs onto a public page.
    if (session.loading || !session.owner) return [...measured].sort((a, b) => b.startedAt - a.startedAt);
    return mergeWithSeeded(stored, measured);
  }, [published, stored, session.loading, session.owner]);

  const record = useCallback((run: RunRecord) => setStored(saveRun(run)), []);
  const remove = useCallback((id: string) => setStored(deleteRun(id)), []);

  return {
    runs,
    stored,
    published,
    /** True when the visible set is the committed file rather than samples. */
    measured: published.length > 0,
    ready: storageRead && publishedRead && !session.loading,
    record,
    remove,
  };
}
