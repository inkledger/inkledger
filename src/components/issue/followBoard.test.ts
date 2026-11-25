import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { showNewBoard, withBoard } from "./followBoard";

type Board = { id: number; name: string };

describe("a board just made, in the list", () => {
  it("added, or put in its place; an unread list stays unread", () => {
    const a = { id: 1, name: "A" };
    expect(withBoard([a], { id: 2, name: "B" })).toEqual([a, { id: 2, name: "B" }]);
    expect(withBoard([a], { id: 1, name: "A2" })).toEqual([{ id: 1, name: "A2" }]);
    expect(withBoard<Board>(undefined, a)).toBeUndefined();
  });

  it("a first load still under way, answered from before the board: the list ends up with the board", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["pinboard", "boards"];
    const made = { id: 7, name: "Backend" };
    let server: Board[] = [];
    const answers: (() => void)[] = [];
    const observer = new QueryObserver<Board[]>(client, {
      queryKey,
      // Each load reads the server when asked, answers when let.
      queryFn: () => {
        const read = server;
        return new Promise<Board[]>(resolve => answers.push(() => resolve(read)));
      },
    });
    const off = observer.subscribe(() => {});
    expect(answers).toHaveLength(1);
    server = [made];
    const done = showNewBoard<Board>(
      {
        cancel: () => client.cancelQueries({ queryKey }),
        setData: update => client.setQueryData<Board[]>(queryKey, update),
        invalidate: () => client.invalidateQueries({ queryKey }),
      },
      made,
    );
    await Promise.resolve();
    await Promise.resolve();
    // The stale first answer lands late; then the fresh one.
    answers[0]();
    await new Promise(r => setTimeout(r));
    expect(answers.length).toBe(2);
    answers[1]();
    await done;
    expect(client.getQueryData<Board[]>(queryKey)).toEqual([made]);
    off();
  });
});
