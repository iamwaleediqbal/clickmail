"use client";

import { KeyRound, LogOut, User } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { useSession } from "@/hooks/use-session";

type SessionApi = ReturnType<typeof useSession>;

export function SignIn({ session }: { session: SessionApi }) {
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.loading) return null;

  if (session.owner) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <User className="size-3.5" />
          Owner
        </span>
        <Button variant="ghost" size="sm" onClick={() => void session.signOut()}>
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </div>
    );
  }

  // No passcode configured means there is no owner mode to offer. Showing a
  // control that always fails would be worse than showing none.
  if (!session.enabled) {
    return <span className="text-xs text-muted-foreground">Read only</span>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const message = await session.signIn(passcode);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setPasscode("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound className="size-3.5" />
          Sign in
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Owner sign in</DialogTitle>
            <DialogDescription>
              Guests can read everything. Starting a run and keeping it needs the owner
              passcode, because each run spends a model call.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="passcode">Passcode</Label>
            <Input
              id="passcode"
              type="password"
              autoComplete="off"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="••••••••"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !passcode}>
              {busy ? "Checking…" : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
