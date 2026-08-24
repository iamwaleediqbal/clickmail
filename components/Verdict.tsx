"use client";

import { type Change, type Grade, explain } from "../lib/gym/grade.ts";

const HEADING: Record<Grade["status"], string> = {
  pass: "Pass",
  incomplete: "Incomplete",
  overreach: "Did more than it was asked",
  both: "Incomplete, and did more than it was asked",
};

export function Verdict({ grade }: { grade: Grade }) {
  return (
    <div>
      <div className={`verdict ${grade.status}`}>
        <strong>{HEADING[grade.status]}</strong>
        <span>{explain(grade)}</span>
      </div>

      <ChangeList title="Required but never happened" changes={grade.missing} />
      <ChangeList title="Changed without being asked" changes={grade.extra} />
    </div>
  );
}

function ChangeList({ title, changes }: { title: string; changes: Change[] }) {
  if (!changes.length) return null;
  return (
    <>
      <p className="folder-title">{title}</p>
      <ul className="changes">
        {changes.map((change) => (
          <li key={change.path}>
            <span className="path">{change.path}</span>{" "}
            <span className="to">
              {format(change.before)} &rarr; {format(change.after)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function format(value: unknown): string {
  if (value === undefined || value === null) return "none";
  const text = String(value);
  return text.length > 70 ? `${text.slice(0, 70)}...` : text || '""';
}
