import { useContext, useId, useState, type ReactNode } from "react";
import { matches, SettingsSearch } from "@/lib/settingsSearch";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";


const OPEN_KEY = "ikl-settings-open";

function readOpen(): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
    // Saved under the old Italian group id.
    if ("permessi" in saved && !("permissions-system" in saved)) {
      saved["permissions-system"] = saved["permessi"];
    }
    return saved;
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: open }));
  } catch {
    // storage unavailable: open/closed just isn't remembered
  }
}


/**
 * A group of settings inside a category: small title, optional description,
 * rows divided by hairlines (no boxes, like the dashboard panel). Collapsible
 * groups hold what is rarely needed (history, test tools, guides); their
 * open/closed state is remembered, and a search match opens them.
 */
export function SettingsGroup({
  id,
  title,
  description,
  keywords,
  collapsible = false,
  defaultOpen = true,
  actions,
  children,
}: {
  /** Stable id: remembers open/closed, anchors links. */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Extra words the search should find this group by. */
  keywords?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const query = useContext(SettingsSearch);
  const hit = matches(query, typeof title === "string" ? title : undefined, keywords);
  const [open, setOpen] = useState(() => readOpen()[id] ?? defaultOpen);
  const shown = !collapsible || open || hit;
  const bodyId = useId();
  const toggle = () => {
    setOpen(!shown);
    writeOpen(id, !shown);
  };

  return (
    <section
      id={id}
      aria-label={typeof title === "string" ? title : undefined}
      data-search-hit={hit ? "" : undefined}
      className={cn(
        "scroll-mt-20 border-b px-5 py-5 last:border-b-0 md:px-6",
        hit && "bg-primary-soft/40"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={shown}
              aria-controls={bodyId}
              onClick={toggle}
              className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-left font-semibold outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronRight
                aria-hidden
                className={cn("h-4 w-4 text-muted-foreground transition-transform", shown && "rotate-90")}
              />
              {title}
            </button>
          ) : (
            <h3 className="font-semibold">{title}</h3>
          )}
          {description && (
            <p className={cn("mt-0.5 text-body-sm text-muted-foreground", collapsible && "pl-5")}>
              {description}
            </p>
          )}
        </div>
        {actions && shown && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {shown && (
        <div id={bodyId} className={cn("mt-4", collapsible && "pl-5")}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * One setting: label and help on the left, its control on the right;
 * stacked on narrow screens. Rows inside a group are divided by hairlines.
 */
export function SettingsRow({
  label,
  htmlFor,
  hint,
  children,
  inline = false,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children?: ReactNode;
  /** A small control (a switch): stays on the right on phones too. */
  inline?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 border-b py-3 first:pt-0 last:border-b-0 last:pb-0",
        inline
          ? "items-center justify-between gap-4"
          : "flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className
      )}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * Something to open inside a group (a history, a guide): a quiet row with a
 * chevron; open/closed is remembered like a collapsible group.
 */
export function SettingsDisclosure({
  id,
  title,
  keywords,
  children,
}: {
  id: string;
  title: ReactNode;
  keywords?: string;
  children: ReactNode;
}) {
  const query = useContext(SettingsSearch);
  const hit = matches(query, typeof title === "string" ? title : undefined, keywords);
  const [open, setOpen] = useState(() => readOpen()[id] ?? false);
  const shown = open || hit;
  const bodyId = useId();
  return (
    <div className="mt-4 border-t pt-3">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={bodyId}
        onClick={() => {
          setOpen(!shown);
          writeOpen(id, !shown);
        }}
        className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-body-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRight aria-hidden className={cn("h-4 w-4 transition-transform", shown && "rotate-90")} />
        {title}
      </button>
      {shown && (
        <div id={bodyId} className="mt-2 pl-5">
          {children}
        </div>
      )}
    </div>
  );
}
