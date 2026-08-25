"use client";

import { useCallback, useEffect, useState } from "react";

export interface Session {
  owner: boolean;
  /** False when no passcode is configured, so the control can hide itself. */
  enabled: boolean;
  loading: boolean;
}

export function useSession() {
  const [session, setSession] = useState<Session>({ owner: false, enabled: false, loading: true });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const data = (await response.json()) as { owner?: boolean; enabled?: boolean };
      setSession({ owner: Boolean(data.owner), enabled: Boolean(data.enabled), loading: false });
    } catch {
      setSession({ owner: false, enabled: false, loading: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (passcode: string): Promise<string | null> => {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const data = (await response.json()) as { owner?: boolean; error?: string };
      if (!response.ok || !data.owner) return data.error ?? "Sign in failed.";
      await refresh();
      return null;
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await fetch("/api/session", { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { ...session, signIn, signOut, refresh };
}
