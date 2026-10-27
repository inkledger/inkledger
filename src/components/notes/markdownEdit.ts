export type MarkdownSelection = { start: number; end: number };
export type MarkdownEdit = { value: string; start: number; end: number };
export type MarkdownCommand =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "heading"
  | "quote"
  | "bullets"
  | "numbers"
  | "tasks"
  | "codeBlock"
  | "link";

const INLINE: Partial<Record<MarkdownCommand, [string, string]>> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
};

function lines(
  value: string,
  selection: MarkdownSelection
): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const next = value.indexOf("\n", selection.end);
  const end = next < 0 ? value.length : next;
  return { start, end, text: value.slice(start, end) };
}

export function applyMarkdown(
  value: string,
  selection: MarkdownSelection,
  command: MarkdownCommand
): MarkdownEdit {
  const selected = value.slice(selection.start, selection.end);
  const inline = INLINE[command];
  if (inline) {
    const [before, after] = inline;
    const outer =
      selection.start >= before.length &&
      value.slice(selection.start - before.length, selection.start) ===
        before &&
      value.slice(selection.end, selection.end + after.length) === after;
    if (outer) {
      return {
        value:
          value.slice(0, selection.start - before.length) +
          selected +
          value.slice(selection.end + after.length),
        start: selection.start - before.length,
        end: selection.end - before.length,
      };
    }
    if (
      selected.startsWith(before) &&
      selected.endsWith(after) &&
      selected.length >= before.length + after.length
    ) {
      const unwrapped = selected.slice(before.length, -after.length);
      return {
        value:
          value.slice(0, selection.start) +
          unwrapped +
          value.slice(selection.end),
        start: selection.start,
        end: selection.end - before.length - after.length,
      };
    }
    return {
      value:
        value.slice(0, selection.start) +
        before +
        selected +
        after +
        value.slice(selection.end),
      start: selection.start + before.length,
      end: selection.end + before.length,
    };
  }
  if (command === "link") {
    const text = selected || "link";
    const insert = `[${text}](https://)`;
    return {
      value:
        value.slice(0, selection.start) + insert + value.slice(selection.end),
      start: selection.start + text.length + 3,
      end: selection.start + text.length + 11,
    };
  }
  const block = lines(value, selection);
  if (command === "codeBlock") {
    const raw = block.text;
    const wrapped = raw.startsWith("```") && raw.endsWith("```");
    const replacement = wrapped
      ? raw
          .slice(3)
          .replace(/^\w*\n/, "")
          .replace(/\n?```$/, "")
      : `\`\`\`\n${raw}\n\`\`\``;
    const actual = wrapped ? replacement.replace(/```$/, "") : replacement;
    return {
      value: value.slice(0, block.start) + actual + value.slice(block.end),
      start: block.start + (wrapped ? 0 : 4),
      end: block.start + (wrapped ? actual.length : actual.length - 4),
    };
  }
  const rows = block.text.split("\n");
  const replacement = rows
    .map((row, index) => {
      const clean = row.replace(
        /^(?:#{1,6} | > ?|> ?|[-*+] \[[ xX]\] |[-*+] |(?:\d+)\. )/,
        ""
      );
      switch (command) {
        case "heading":
          return row.startsWith("### ") ? clean : `### ${clean}`;
        case "quote":
          return row.startsWith("> ") ? clean : `> ${clean}`;
        case "bullets":
          return /^[-*+] /.test(row) ? clean : `- ${clean}`;
        case "numbers":
          return /^\d+\. /.test(row) ? clean : `${index + 1}. ${clean}`;
        case "tasks":
          return /^[-*+] \[[ xX]\] /.test(row) ? clean : `- [ ] ${clean}`;
        default:
          return row;
      }
    })
    .join("\n");
  return {
    value: value.slice(0, block.start) + replacement + value.slice(block.end),
    start: block.start,
    end: block.start + replacement.length,
  };
}
