"use client";

import { Lock, Play, Square } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { GradingDialog } from "@/components/harness/grading-dialog";
import { RunMonitor } from "@/components/harness/run-monitor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRuns } from "@/hooks/use-runs";
import { useSession } from "@/hooks/use-session";
import { GymClient } from "@/lib/bridge";
import { clearRunStorage } from "@/lib/gym/state";
import { TASKS, turnsFor } from "@/lib/gym/tasks";
import type { TimelineEntry } from "@/lib/harness/entries";
import { attachScreenshots, execute } from "@/lib/harness/execute";
import { executeComputer } from "@/lib/harness/execute-computer";
import type { RunRecord } from "@/lib/harness/runs";
import { formatCost, formatDuration, statusLabel } from "@/lib/harness/runs";

interface ModelOption {
  id: string;
  name: string;
}

type Mode = "computer" | "tool";

const MODES: { id: Mode; label: string; blurb: string }[] = [
  {
    id: "computer",
    label: "Computer use",
    blurb:
      "The model is shown a screenshot and nothing else, and answers with coordinates. Finding the control is part of the task.",
  },
  {
    id: "tool",
    label: "Tool calling",
    blurb:
      "The model is given the mailbox as text and a set of named actions. It has to decide what to do, but not where anything is — which is why this is the control condition, not the headline.",
  },
];

export function RunLauncher() {
  const requested = useSearchParams().get("task");
  const session = useSession();
  const { record } = useRuns();

  const [taskId, setTaskId] = useState(
    requested && TASKS.some((t) => t.id === requested) ? requested : TASKS[0].id,
  );
  const [mode, setMode] = useState<Mode>("computer");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [result, setResult] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<GymClient | null>(null);
  const readyRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Screenshots arrive on their own message, after the reply they belong to,
  // keyed by the bridge request id. Holding them here and re-applying the whole
  // map on every update means a picture that lands before its entry is
  // rendered is picked up on the next pass rather than dropped.
  const shotsRef = useRef(new Map<number, string>());

  const task = TASKS.find((t) => t.id === taskId)!;

  useEffect(() => {
    const client = new GymClient(() => frameRef.current?.contentWindow);
    client.ready(() => readyRef.current?.());
    client.shots((id, shot) => {
      shotsRef.current.set(id, shot);
      setEntries((previous) => attachScreenshots(previous, shotsRef.current));
    });
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
      clearRunStorage(null);
    };
  }, []);

  // Re-fetched per mode: computer use needs a model that accepts images, and
  // that is a strictly smaller list. Keeping one list for both would offer a
  // blind model for a run that is about to hand it a screenshot.
  useEffect(() => {
    let live = true;
    setModelsError(null);
    fetch(`/api/models?mode=${mode}`)
      .then((r) => r.json())
      .then((data: { models?: ModelOption[]; error?: string; note?: string }) => {
        if (!live) return;
        if (data.error || !data.models?.length) {
          setModelsError(data.error ?? "No capable free models are available right now.");
          setModels([]);
          return;
        }
        setModels(data.models);
        if (data.note) setModelsError(data.note);
        setModel((current) =>
          current && data.models!.some((m) => m.id === current) ? current : data.models![0].id,
        );
      })
      .catch((error) => live && setModelsError(String(error)));
    return () => {
      live = false;
    };
  }, [mode]);

  const environmentReady = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          readyRef.current = null;
          reject(new Error("the environment did not start"));
        }, 10_000);
        readyRef.current = () => {
          clearTimeout(timer);
          readyRef.current = null;
          resolve();
        };
      }),
    [],
  );

  async function start() {
    const client = clientRef.current;
    if (!client) return;

    setEntries([]);
    setResult(null);
    setRunning(true);
    shotsRef.current.clear();

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : String(Date.now());
    const ready = environmentReady();
    setRunId(id);

    try {
      await ready;
    } catch (error) {
      setRunning(false);
      setResult({
        id,
        taskId: task.id,
        taskTitle: task.title,
        model,
        runner: "browser",
        mode,
        status: "infrastructure_error",
        detail: String(error instanceof Error ? error.message : error),
        startedAt: Date.now(),
        durationMs: 0,
        turns: 0,
        maxTurns: turnsFor(task, mode),
        tokens: { input: 0, output: 0, total: 0 },
        cost: 0,
        entries: [],
        verdict: null,
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const options = {
      task,
      model,
      runId: id,
      client,
      signal: controller.signal,
      onEntry: (next: TimelineEntry[]) => setEntries(attachScreenshots(next, shotsRef.current)),
    };

    // Two loops, not one with a flag. They observe different things and take
    // different actions; the only thing they share is the task and the grader.
    const run = mode === "computer" ? await executeComputer(options) : await execute(options);

    // The last action's picture is still being rasterised when the loop ends.
    // Wait briefly for it before freezing the record, so the stored run keeps
    // every screenshot rather than all but the final one.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const settled: RunRecord = {
      ...run,
      entries: attachScreenshots(run.entries, shotsRef.current),
    };

    setResult(settled);
    setEntries(settled.entries);
    setRunning(false);
    abortRef.current = null;
    record(settled);
    clearRunStorage(id);
  }

  const locked = !session.loading && !session.owner;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">New evaluation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Action space">
              <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
                <TabsList className="w-full">
                  {MODES.map((option) => (
                    <TabsTrigger key={option.id} value={option.id} disabled={running}>
                      {option.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                {MODES.find((option) => option.id === mode)?.blurb}
              </p>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Task">
                <Select value={taskId} onValueChange={setTaskId} disabled={running}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASKS.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <Select
                  value={model}
                  onValueChange={setModel}
                  disabled={running || !models.length}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={modelsError ? "Unavailable" : "Loading…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <dl className="grid gap-2 text-sm">
              <Detail term="Instruction">{task.prompt}</Detail>
              <Detail term="Tests for" muted>
                {task.probes}
              </Detail>
              {/* The budget for the space about to be run, not both: the
                  number shown has to be the number the run is cut off at. */}
              <Detail term="Turn budget" muted>
                {turnsFor(task, mode)} turns in {mode === "computer" ? "computer use" : "tool calling"}
              </Detail>
            </dl>

            <Separator />

            {locked ? (
              <Alert>
                <Lock className="size-4" />
                <AlertDescription>
                  Reading is open to everyone. Starting a run spends a model call, so it
                  needs the owner passcode — sign in from the header.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={start} disabled={running || !model}>
                  <Play className="size-3.5" />
                  {running ? "Running…" : "Run evaluation"}
                </Button>
                {running && (
                  <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                    <Square className="size-3.5" />
                    Stop
                  </Button>
                )}
              </div>
            )}

            {modelsError && <p className="text-sm text-muted-foreground">{modelsError}</p>}
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 pb-3">
              <CardTitle className="text-sm font-semibold">Result</CardTitle>
              {/* The verdict is a control now: a tick or a cross, with the
                  detail behind it. It used to occupy a whole card beside the
                  trajectory, which is the thing worth reading. */}
              <GradingDialog verdict={result.verdict} task={task} size="sm" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-2">
                <Stat label="Outcome" value={statusLabel(result.status)} />
                <Stat label="Turns" value={`${result.turns}/${result.maxTurns}`} />
                <Stat label="Tokens" value={result.tokens.total.toLocaleString()} />
                <Stat label="Cost" value={formatCost(result.cost)} />
                <Stat label="Duration" value={formatDuration(result.durationMs)} />
              </div>
              {result.detail && (
                <p className="text-sm leading-relaxed break-words text-muted-foreground">
                  {result.detail}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Full width below the controls, so the trajectory is never the pane
          that gets squeezed. */}
      <div className="space-y-2">
        <h2 className="px-1 text-sm font-semibold">Action timeline</h2>
        <RunMonitor entries={entries} live={running} />
      </div>

      {runId && (
        <iframe
          key={runId}
          ref={frameRef}
          src={`/gym?run=${runId}`}
          title="Evaluation environment"
          className="fixed left-[-12000px] top-0 h-[720px] w-[1180px] border-0 opacity-0"
          tabIndex={-1}
          aria-hidden
          sandbox="allow-scripts allow-same-origin"
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Detail({
  term,
  children,
  muted,
}: {
  term: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {term}
      </dt>
      <dd className={muted ? "text-muted-foreground" : undefined}>{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-medium tabular" title={value}>
        {value}
      </div>
    </div>
  );
}
