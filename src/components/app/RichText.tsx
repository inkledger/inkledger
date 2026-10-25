import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CheckSquare, Image as ImageIcon, Paperclip, Square } from "lucide-react";
import { plainText, type Block, type Inline, type RichDoc } from "@contracts/richtext";
import { safeExternalUrl } from "@contracts/links";
import { attachmentUrl } from "@/lib/attachments";
import { ExternalLink } from "@/components/app/ExternalLink";
import { Chip } from "@/components/app/Chip";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type Ctx = {
  /** The issue's attachments by file name → their id (images are loaded only through the proxy) */
  images: Map<string, string>;
  connectionId?: number | null;
};

const PANEL_TONE: Record<string, string> = {
  info: "border-info/40 bg-info-soft",
  note: "border-border bg-muted/40",
  warning: "border-warning/40 bg-warning-soft",
  success: "border-success/40 bg-success-soft",
  error: "border-danger/40 bg-danger-soft",
};

function inlines(xs: Inline[], ctx: Ctx): ReactNode[] {
  return xs.map((x, i) => {
    switch (x.t) {
      case "text":
        return x.v;
      case "strong":
        return <strong key={i}>{inlines(x.c, ctx)}</strong>;
      case "em":
        return <em key={i}>{inlines(x.c, ctx)}</em>;
      case "strike":
        return <s key={i}>{inlines(x.c, ctx)}</s>;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 text-caption">
            {x.v}
          </code>
        );
      case "link": {
        // Only http(s) and mailto open; anything else stays its text.
        const url = safeExternalUrl(x.url);
        const label = x.c.length ? inlines(x.c, ctx) : x.url;
        return url ? (
          <ExternalLink key={i} url={url.href}>
            {label}
          </ExternalLink>
        ) : (
          <span key={i}>{label}</span>
        );
      }
      case "mention":
        return (
          <span key={i} className="rounded bg-primary-soft px-1 font-medium text-primary-strong">
            @{x.name}
          </span>
        );
      case "emoji":
        return x.v;
      case "attachment":
        return (
          <span key={i} className="inline-flex items-center gap-1 font-medium">
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            {x.name}
          </span>
        );
      case "br":
        return <br key={i} />;
    }
  });
}

function block(b: Block, key: number, ctx: Ctx): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={key} className="[overflow-wrap:anywhere]">
          {inlines(b.c, ctx)}
        </p>
      );
    case "h": {
      // Headings inside a text stay text-sized: the page has its own.
      const cls = b.level <= 2 ? "text-body font-semibold" : "text-body-sm font-semibold";
      return (
        <p key={key} role="heading" aria-level={Math.min(6, b.level + 2)} className={cls}>
          {inlines(b.c, ctx)}
        </p>
      );
    }
    case "code":
      return (
        <pre key={key} className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-caption leading-relaxed">
          <code>{b.v}</code>
        </pre>
      );
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i} className={cn(it.checked !== null && "flex list-none items-start gap-1.5")}>
          {it.checked !== null &&
            (it.checked ? (
              <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label={t("views.issue.text.done")} />
            ) : (
              <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={t("views.issue.text.todo")} />
            ))}
          <div className="grid min-w-0 gap-1">{it.c.map((c, k) => block(c, k, ctx))}</div>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} className="grid list-decimal gap-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="grid list-disc gap-1 pl-5">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="grid gap-2 border-l-2 pl-3 text-muted-foreground">
          {b.c.map((c, k) => block(c, k, ctx))}
        </blockquote>
      );
    case "panel":
      return (
        <div key={key} className={cn("grid gap-2 rounded-lg border px-3 py-2", PANEL_TONE[b.kind])}>
          {b.c.map((c, k) => block(c, k, ctx))}
        </div>
      );
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-caption">
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className="border-b">
                  {row.map((cell, c) => {
                    const Cell = b.header && r === 0 ? "th" : "td";
                    return (
                      <Cell key={c} className={cn("px-2 py-1 text-left align-top", Cell === "th" && "font-semibold")}>
                        {inlines(cell, ctx)}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} className="border-border" />;
    case "image": {
      const id = b.name ? ctx.images.get(b.name) : undefined;
      if (id) {
        const src = attachmentUrl(id, "content", ctx.connectionId);
        return (
          <a key={key} href={src} target="_blank" rel="noreferrer" className="block w-fit">
            <img src={src} alt={b.alt ?? b.name} loading="lazy" className="max-h-80 w-auto max-w-full rounded-lg border" />
          </a>
        );
      }
      // An image elsewhere is never loaded (it would tell that site who reads): a link to it.
      const url = b.url ? safeExternalUrl(b.url) : null;
      if (url) {
        return (
          <p key={key}>
            <ExternalLink url={url.href}>
              <ImageIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden />
              {t("views.issue.text.openImage", { label: b.alt || url.pathname.split("/").pop() || url.hostname })}
            </ExternalLink>
          </p>
        );
      }
      return (
        <Chip key={key}>
          <ImageIcon className="h-3 w-3" aria-hidden /> {b.name ?? b.alt ?? "—"}
        </Chip>
      );
    }
  }
}

/**
 * A tracker's text (description, comment), whatever it was written in: one
 * renderer, collapsible when long.
 */
export function RichText({
  doc,
  images,
  connectionId,
  collapseAfter = 700,
}: {
  doc: RichDoc;
  images: Map<string, string>;
  connectionId?: number | null;
  /** Characters after which the text is collapsed behind "Show all" */
  collapseAfter?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const words = plainText(doc);
  const long = words.length > collapseAfter || words.split("\n").length > 14;
  const collapsed = long && !expanded;
  const ctx = { images, connectionId };
  const box = useRef<HTMLDivElement>(null);
  // Collapsed, what is cut off can't be focused (Tab would land on something unseen): out of
  // the tab order until "Show all"; back in once shown.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const limit = el.clientHeight;
    for (const f of el.querySelectorAll<HTMLElement>("a[href], button, [tabindex]")) {
      if (collapsed && f.offsetTop + f.offsetHeight > limit) {
        if (!f.hasAttribute("data-clipped")) f.setAttribute("data-clipped", f.getAttribute("tabindex") ?? "");
        f.setAttribute("tabindex", "-1");
      } else if (f.hasAttribute("data-clipped")) {
        const before = f.getAttribute("data-clipped");
        if (before) f.setAttribute("tabindex", before);
        else f.removeAttribute("tabindex");
        f.removeAttribute("data-clipped");
      }
    }
  }, [collapsed, doc]);
  return (
    <div className="mt-1">
      <div ref={box} className={cn("relative grid gap-2 text-body-sm", collapsed && "max-h-56 overflow-hidden")}>
        {doc.blocks.length === 0 ? <p className="text-muted-foreground">—</p> : doc.blocks.map((b, i) => block(b, i, ctx))}
        {collapsed && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background" />}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-body-sm font-medium text-primary-strong underline-offset-4 hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? t("views.issue.text.showLess") : t("views.issue.text.showAll")}
        </button>
      )}
    </div>
  );
}
