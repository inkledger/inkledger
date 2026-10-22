import { describe, expect, it } from "vitest";
import { parseQuery } from "@contracts/query";
import { toJql } from "../jira/translate";
import { toGitHubQuery } from "../github/translate";

const now = new Date(2026, 9, 21, 10);
const jql = (q: string) => toJql(parseQuery(q).expr, now);
const gh = (q: string) => toGitHubQuery(parseQuery(q).expr, now);

describe("the search language in a tracker's own words", () => {
  it("Jira: JQL for what it can say, the rest named, never dropped", () => {
    expect(jql("login project:APP @me")).toEqual({ query: '(text ~ "login") AND (project = "APP") AND (assignee = currentUser())', unsupported: [] });
    expect(jql("cat:doing OR is:watched")).toEqual({ query: "(statusCategory = 4) OR (watcher = currentUser())", unsupported: [] });
    expect(jql('-label:bug updated:7d')).toEqual({ query: '(NOT (labels = "bug")) AND (updated >= "2026-10-15" AND updated < "2026-10-22")', unsupported: [] });
    expect(jql("APP-12")).toEqual({ query: "key = APP-12", unsupported: [] });
    expect(jql("componente:Backend")).toEqual({ query: 'component = "Backend"', unsupported: [] });
    // A tracker without components names it, never drops it.
    expect(gh("login component:Backend")).toEqual({ query: "login involves:@me", unsupported: ["component:Backend"] });
    // client: and logged: are inkledger's: named, the rest still sent.
    expect(jql("login client:Acme")).toEqual({ query: '(text ~ "login")', unsupported: ["client:Acme"] });
    // One unsayable term makes its OR unsayable.
    expect(jql("project:APP (client:Acme OR label:x)")).toEqual({ query: '(project = "APP")', unsupported: ["client:Acme", "client:Acme OR label:x"] });
  });

  it("GitHub: qualifiers, no OR, negation of one qualifier only", () => {
    expect(gh("login project:acme/web @me label:bug")).toEqual({ query: "login repo:acme/web assignee:@me label:bug", unsupported: [] });
    expect(gh("project:acme is:closed -label:wontfix")).toEqual({ query: "user:acme is:closed -label:wontfix", unsupported: [] });
    expect(gh("created:2026-10-01..2026-10-07")).toEqual({ query: "created:2026-10-01..2026-10-08 involves:@me", unsupported: [] });
    expect(gh("label:a OR label:b")).toEqual({ query: "", unsupported: ["label:a OR label:b"] });
    expect(gh("priority>=high due:today")).toEqual({ query: "", unsupported: ["priority:>=high", "due:today"] });
  });

  it("GitHub: without a repository or a person, only the issues the user is involved in", () => {
    expect(gh("login bug").query).toBe("login bug involves:@me");
    expect(gh("label:bug -assignee:@me").query).toBe("label:bug -assignee:@me involves:@me");
    expect(gh('"repo:x y"').query).toBe('"repo:x y" involves:@me');
    // A repository, an owner or a person already narrows it.
    expect(gh("login project:acme/web").query).toBe("login repo:acme/web");
    expect(gh("login project:acme").query).toBe("login user:acme");
    expect(gh("login author:me").query).toBe("login author:@me");
    expect(gh("login assignee:bob").query).toBe("login assignee:bob");
  });
});
