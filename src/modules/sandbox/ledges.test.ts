import { describe, expect, it } from "vitest";
import { LEDGES_MAX, ledgesAround, type LedgeEl, type LedgePage } from "./ledges";

type Fake = LedgeEl & { id: string; rect: { left: number; top: number; right: number; bottom: number } };
const node = (id: string) => ({ id }) as unknown as Node;
const el = (id: string, left: number, top: number, right: number, bottom: number, inner: string[] = []): Fake => ({
  id,
  rect: { left, top, right, bottom },
  getBoundingClientRect() {
    return this.rect;
  },
  contains: other => !!other && [id, ...inner].includes((other as unknown as { id: string }).id),
});
/** `top`: the page's top element at a point (by default the last candidate whose box holds it). */
function page(els: Fake[], top?: (x: number, y: number) => string | null): LedgePage<Fake> {
  return {
    candidates: () => els,
    elementFromPoint(x, y) {
      const id = top ? top(x, y) : [...els].reverse().find(e => x >= e.rect.left && x < e.rect.right && y >= e.rect.top && y < e.rect.bottom)?.id;
      return id ? node(id) : null;
    },
    width: 1200,
    height: 800,
  };
}
const box = { left: 200, top: 50, width: 1000, height: 2000 };

describe("page.ledges", () => {
  it("the top edges of cards in sight, in the box's px, top to bottom", () => {
    const got = ledgesAround(page([el("b", 600, 400, 1000, 600), el("a", 240, 120, 560, 300)]), box);
    expect(got).toEqual([
      { x: 40, y: 70, w: 320 },
      { x: 400, y: 350, w: 400 },
    ]);
  });

  it("leaves out edges above or below the window and narrow ones; clips to the window's width", () => {
    const got = ledgesAround(page([el("above", 300, -20, 700, 200), el("below", 300, 820, 700, 900), el("thin", 300, 100, 360, 200), el("wide", 900, 300, 1500, 400)]), box);
    expect(got).toEqual([{ x: 700, y: 250, w: 300 }]);
  });

  it("an edge something covers (a sticky header) is not in sight", () => {
    const got = ledgesAround(page([el("a", 300, 100, 700, 200)], () => "header"), box);
    expect(got).toEqual([]);
  });

  it("the card's own content at its edge still counts as the card", () => {
    const got = ledgesAround(page([el("a", 300, 100, 700, 200, ["title"])], () => "title"), box);
    expect(got).toEqual([{ x: 100, y: 50, w: 400 }]);
  });

  it("a card in a card on the same line is one ledge, the wider", () => {
    const got = ledgesAround(page([el("outer", 300, 100, 900, 400, ["inner"]), el("inner", 320, 100, 600, 200)], () => "inner"), box);
    expect(got).toEqual([{ x: 100, y: 50, w: 600 }]);
  });

  it("only what lies in the box", () => {
    const got = ledgesAround(page([el("a", 0, 100, 150, 200), el("b", 300, 30, 700, 200)]), box);
    expect(got).toEqual([]);
  });

  it("capped, however busy the page", () => {
    const many = Array.from({ length: 200 }, (_, i) => el(`c${i}`, 300, 60 + i * 3, 700, 62 + i * 3));
    const got = ledgesAround(page(many), box);
    expect(got.length).toBe(LEDGES_MAX);
  });
});
