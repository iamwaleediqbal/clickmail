"use client";

import type { Step } from "../lib/agent/loop.ts";

export function Timeline({ steps }: { steps: Step[] }) {
  if (!steps.length) {
    return <p className="task-note">No run yet.</p>;
  }
  return (
    <ul className="timeline">
      {steps.map((step) => (
        <li key={step.turn}>
          <div className="act">
            {step.turn}. {step.action ? render(step.action) : "(no action)"}
            {step.action && !step.applied && " — rejected"}
          </div>
          {step.thought && <div className="thought">{step.thought}</div>}
          {step.error && <div className="err">{step.error}</div>}
        </li>
      ))}
    </ul>
  );
}

function render(action: { name: string; args?: Record<string, unknown> }): string {
  const args = Object.entries(action.args ?? {})
    .map(([key, value]) => `${key}=${truncate(String(value))}`)
    .join(" ");
  return args ? `${action.name} ${args}` : action.name;
}

function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}...` : value;
}
