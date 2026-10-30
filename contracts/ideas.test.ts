import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askMailUrl, canMove, handoffPrompt, IDEA_STATES, issueDescription, splitIdeas, type IdeaState, type IdeaView } from "./ideas";

const NOTEPAD = readFileSync(new URL("./__fixtures__/notepad.txt", import.meta.url), "utf8");

const view = (over: Partial<IdeaView> = {}): IdeaView => ({
  id: 7,
  title: "Estimate issues from history",
  body: "Use my closed issues.",
  state: "refining",
  acceptance: [{ id: "a1", text: "A range on the issue page" }],
  questions: [
    { id: "q1", text: "Which statuses count?", answer: "Doing ones", blocking: true },
    { id: "q2", text: "Team estimates too?", answer: "", blocking: false },
  ],
  container: { id: 3, key: "APP", name: "App" },
  ...over,
});

describe("ideas", () => {
  it("a pasted numbered list becomes one idea per point", () => {
    const ideas = splitIdeas(NOTEPAD);
    expect(ideas).toHaveLength(7);
    expect(ideas.map((i) => i.title)).toEqual([
      "In the mail add-in, choose a bucket of its own instead of the server's",
      "Keep a record of module purchases that anyone can check",
      "Deleted mails lose what their pins showed: find a way to keep it",
      "Notes in folders, like a file manager",
      "Find out why the build is red",
      "A waiting room for raw ideas until they are clear enough to be issues",
      "Estimate how long an issue will take from my own history",
    ]);
    expect(ideas.every((i) => i.body === "")).toBe(true);
  });

  it("a long line keeps its rest in the body", () => {
    const line = "x".repeat(200) + "y".repeat(50);
    expect(splitIdeas(`  ${line}  `)).toEqual([{ title: "x".repeat(200), body: "y".repeat(50) }]);
  });

  it("moves follow the table", () => {
    const ready = { title: "Good idea", acceptance: [{ id: "a", text: "done when" }], questions: [] };
    // ✓ allowed, ✗ refused; "R" needs readiness (given here, so allowed).
    const table: Record<IdeaState, Record<IdeaState, "✓" | "✗" | "R" | "—">> = {
      raw: { raw: "—", refining: "✓", ready: "R", promoted: "✗", discarded: "✓" },
      refining: { raw: "✓", refining: "—", ready: "R", promoted: "✗", discarded: "✓" },
      ready: { raw: "✓", refining: "✓", ready: "—", promoted: "✗", discarded: "✓" },
      promoted: { raw: "✗", refining: "✓", ready: "✗", promoted: "—", discarded: "✗" },
      discarded: { raw: "✗", refining: "✓", ready: "✗", promoted: "✗", discarded: "—" },
    };
    for (const from of IDEA_STATES)
      for (const to of IDEA_STATES) {
        const cell = table[from][to];
        if (cell === "—") continue;
        const r = canMove({ ...ready, state: from }, to);
        expect(r.ok, `${from} → ${to}`).toBe(cell !== "✗");
        if (!r.ok) expect(r.reason, `${from} → ${to}`).toBe(to === "promoted" ? "promoteThroughIssue" : "terminal");
      }
  });

  it("the agent prompt has the agreed shape", () => {
    expect(handoffPrompt(view(), null)).toMatchInlineSnapshot(`
      {
        "filename": "idea-7-estimate-issues-from-history.md",
        "markdown": "# Estimate issues from history
      Project: App

      ## Problem
      Use my closed issues.

      ## Acceptance criteria
      - [ ] A range on the issue page

      ## Decisions already taken
      - Which statuses count? → Doing ones

      ## Open questions (ask before deciding)
      - Team estimates too?

      ## Constraints
      Follow the repository's CLAUDE.md and its checks. Do not push.
      ",
      }
    `);
    expect(handoffPrompt(view({ container: null, state: "promoted" }), { key: "APP-12", url: "https://tracker.example/APP-12" }).markdown.split("\n").slice(0, 3)).toEqual([
      "# Estimate issues from history",
      "Issue: APP-12 https://tracker.example/APP-12",
      "",
    ]);
  });

  it("the mail link stays under 2000 characters", () => {
    const questions = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, text: `${i} ${"w".repeat(196)}`, answer: "", blocking: false }));
    const url = askMailUrl(view({ questions }), "anna@example.com");
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(url.startsWith("mailto:anna@example.com?")).toBe(true);
    expect(decodeURIComponent(url).endsWith("…")).toBe(true);
  });

  it("an issue made from an idea carries its criteria and its answers", () => {
    expect(issueDescription(view(), { acceptance: "Done when…", decisions: "Decisions taken" })).toBe(
      ["Use my closed issues.", "Done when…\n- A range on the issue page", "Decisions taken\n- Which statuses count? → Doing ones"].join("\n\n"),
    );
    expect(issueDescription(view({ body: "", acceptance: [], questions: [] }), { acceptance: "A", decisions: "D" })).toBe("");
  });
});
