"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Mailbox } from "../components/Mailbox.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Verdict } from "../components/Verdict.tsx";
import { type Step, type Stop, runAgent } from "../lib/agent/loop.ts";
import { type Grade, grade } from "../lib/gym/grade.ts";
import { STORAGE_KEY, type MailState } from "../lib/gym/state.ts";
import { TASKS, freshSeed } from "../lib/gym/tasks.ts";

const MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "microsoft/phi-3-medium-128k-instruct:free",
];

const STOP_TEXT: Record<Stop, string> = {
  finished: "The model said it was done.",
  max_turns: "Ran out of turns.",
  no_action: "Stopped emitting actions and started narrating.",
  transport_error: "Never reached a model. This attempt is not a score.",
  cancelled: "Cancelled.",
};

export default function Page() {
  const [taskId, setTaskId] = useState(TASKS[0].id);
  const [model, setModel] = useState(MODELS[0]);
  const [state, setState] = useState<MailState | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stop, setStop] = useState<Stop | null>(null);
  const [detail, setDetail] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const task = useMemo(() => TASKS.find((t) => t.id === taskId)!, [taskId]);

  const reset = useCallback(() => {
    const fresh = freshSeed(task);
    setState(fresh);
    setSteps([]);
    setStop(null);
    setDetail(undefined);
    // The gym's whole world is one JSON value, so persisting it is one line.
    // A refresh mid-run leaves the mailbox exactly as the agent left it.
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // Private browsing and blocked site data both throw here. The gym works
      // fine without persistence, so this is not worth interrupting anyone for.
    }
  }, [task]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!state) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* see above */
    }
  }, [state]);

  const verdict: Grade | null = useMemo(() => {
    if (!state || !stop || stop === "transport_error" || stop === "cancelled") return null;
    return grade(task.seed, task.golden, state);
  }, [state, stop, task]);

  async function start() {
    if (!state) return;
    const fresh = freshSeed(task);
    setState(fresh);
    setSteps([]);
    setStop(null);
    setDetail(undefined);
    setRunning(true);

    const controller = new AbortController();
    abort.current = controller;

    const outcome = await runAgent({
      model,
      prompt: task.prompt,
      initial: fresh,
      signal: controller.signal,
      onStep: (step, next) => {
        setSteps((previous) => [...previous, step]);
        setState(next);
      },
    });

    setState(outcome.state);
    setStop(outcome.stop);
    setDetail(outcome.detail);
    setRunning(false);
  }

  return (
    <main className="wrap">
      <header>
        <h1>clickgym</h1>
        <p>
          A browser gym for agents. The whole mailbox lives in local storage, so
          grading is a comparison between two JSON values rather than an
          argument about what the screen looked like.
        </p>
        <p>
          Runs are graded on the <strong>final state</strong>, never the route
          taken. There are many correct ways to star an email.
        </p>
      </header>

      <div className="grid">
        <section className="panel">
          <h2>Task</h2>
          <div className="controls">
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={running}>
              {TASKS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m.replace(":free", "").split("/")[1]}
                </option>
              ))}
            </select>
            <button className="primary" onClick={start} disabled={running}>
              {running ? "Running..." : "Run"}
            </button>
            <button
              onClick={() => (running ? abort.current?.abort() : reset())}
              disabled={!state}
            >
              {running ? "Stop" : "Reset"}
            </button>
          </div>

          <p className="task-note">
            <strong>Instruction given to the model:</strong> {task.prompt}
          </p>
          <p className="task-note">
            <strong>What this catches:</strong> {task.probes}
          </p>

          <h2>Mailbox</h2>
          {state && <Mailbox state={state} />}
        </section>

        <section className="panel">
          <h2>Result</h2>
          {stop && (
            <div className={`verdict ${stop === "transport_error" ? "incomplete" : ""}`}>
              <strong>{STOP_TEXT[stop]}</strong>
              {detail && <span>{detail}</span>}
            </div>
          )}
          {verdict && <Verdict grade={verdict} />}

          <h2>Action timeline</h2>
          <Timeline steps={steps} />
        </section>
      </div>

      <footer>
        <p>
          The action timeline above is for reading a failure. It is not what the
          grade is computed from. Those are two different things and keeping
          them separate is the point of the project.
        </p>
        <p>
          Free models only, through OpenRouter. If a run stops with{" "}
          <code>never reached a model</code>, the free pool is throttling rather
          than the model failing, and that attempt is not counted as a score.
        </p>
      </footer>
    </main>
  );
}
