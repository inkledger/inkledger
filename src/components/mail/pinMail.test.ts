import { describe, expect, it } from "vitest";
import { ISSUE_DRAG_TYPE } from "@/lib/issues";
import { mayBeMail } from "./pinMail";

describe("what a drop on the app may pin as a mail", () => {
  it("a file, a link or words from outside", () => {
    expect(mayBeMail(["Files"])).toBe(true);
    expect(mayBeMail(["text/uri-list", "text/plain"])).toBe(true);
    expect(mayBeMail(["text/plain"])).toBe(true);
  });

  // A board card dropped beside its target opened "Pin a mail" searching the mailbox for its key.
  it("never an issue dragged within the app, though it carries its key as text", () => {
    expect(mayBeMail(["text/plain", "application/x-from-status", "application/x-connection", ISSUE_DRAG_TYPE])).toBe(false);
    expect(mayBeMail(["text/plain", ISSUE_DRAG_TYPE])).toBe(false);
  });
});
