import type { ReactNode } from "react";

/** Numbered steps (install guides). */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="grid gap-4">{children}</ol>;
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-body-sm font-semibold text-primary-strong"
      >
        {n}
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="font-medium">{title}</p>
        <div className="text-body-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}
