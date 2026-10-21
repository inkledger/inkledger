import { cn } from "@/lib/utils";

export type IllustrationKind =
  "inbox" | "calendar" | "search" | "chart" | "chat" | "doc";

/** A grainy tonal tile: the building block of every illustration. */
function Tile({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn("grain absolute ring-1 ring-cover-ink/10", className)}
    />
  );
}

/** Hairline "content" stroke drawn on top of a tile. */
function Line({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn("absolute h-1 rounded-full bg-cover-ink/20", className)}
    />
  );
}

/**
 * Small tone-on-tone compositions for empty states: overlapping grainy
 * tiles from the derived cover palette, so they follow the chosen colour.
 */
export function Illustration({
  kind,
  className,
}: {
  kind: IllustrationKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative block h-20 w-24 shrink-0", className)}
    >
      {kind === "inbox" && (
        <>
          <Tile className="left-3 top-1 h-14 w-16 -rotate-6 rounded-lg cover-1" />
          <Tile className="bottom-1 left-6 h-14 w-16 rotate-3 rounded-lg cover-3" />
          <Line className="bottom-9 left-10 w-8 rotate-3" />
          <Line className="bottom-6 left-10 w-5 rotate-3" />
        </>
      )}
      {kind === "calendar" && (
        <>
          <Tile className="left-4 top-2 h-16 w-16 rounded-lg cover-2" />
          <span className="absolute left-4 top-2 h-4 w-16 rounded-t-lg bg-cover-ink/10" />
          <span className="absolute left-7 top-9 grid grid-cols-3 gap-1.5">
            {Array.from({ length: 6 }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-2 w-2 rounded-sm",
                  i === 4 ? "bg-primary-strong/60" : "bg-cover-ink/20"
                )}
              />
            ))}
          </span>
        </>
      )}
      {kind === "search" && (
        <>
          <Tile className="left-2 top-1 h-14 w-14 rounded-full cover-4" />
          <span className="absolute left-5 top-4 h-8 w-8 rounded-full bg-card/70 ring-1 ring-cover-ink/10" />
          <Tile className="bottom-2 right-4 h-3 w-10 rotate-45 rounded-full cover-0" />
        </>
      )}
      {kind === "chart" && (
        <>
          <Tile className="bottom-2 left-3 h-8 w-5 rounded-md cover-2" />
          <Tile className="bottom-2 left-10 h-14 w-5 rounded-md cover-0" />
          <Tile className="bottom-2 left-[4.25rem] h-11 w-5 rounded-md cover-4" />
          <span className="absolute bottom-1 left-1 h-px w-[5.5rem] bg-cover-ink/20" />
        </>
      )}
      {kind === "chat" && (
        <>
          <Tile className="left-2 top-2 h-10 w-14 rounded-xl rounded-bl-sm cover-1" />
          <Tile className="bottom-2 right-2 h-10 w-14 rounded-xl rounded-br-sm cover-5" />
          <Line className="left-5 top-5 w-7" />
          <Line className="bottom-5 right-5 w-6" />
        </>
      )}
      {kind === "doc" && (
        <>
          <Tile className="left-5 top-1 h-[4.5rem] w-14 rotate-3 rounded-lg cover-3" />
          <span className="absolute left-5 top-1 h-[4.5rem] w-14 -rotate-3 rounded-lg bg-card/80 ring-1 ring-cover-ink/10" />
          <Line className="left-8 top-5 w-8 -rotate-3" />
          <Line className="left-8 top-8 w-6 -rotate-3" />
          <Line className="left-8 top-11 w-7 -rotate-3" />
        </>
      )}
    </span>
  );
}
