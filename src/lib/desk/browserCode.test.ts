// The code tools in a browser (docs/work/desk.md, batch 4d): a folder the user connected
// (File System Access), read through its handle only, every path confined to it.
import { describe, expect, it } from "vitest";
import { browserTool, type DirHandle, type FileHandle } from "./browserCode";

type Tree = { [name: string]: string | Uint8Array<ArrayBuffer> | Tree };

/** An in-memory folder shaped like FileSystemDirectoryHandle (what the e2e stub does too). */
function folder(name: string, tree: Tree): DirHandle {
  const handles = (): [string, DirHandle | FileHandle][] =>
    Object.entries(tree).map(([n, v]) =>
      typeof v === "string" || v instanceof Uint8Array ? [n, { kind: "file", name: n, getFile: async () => new File([v], n) }] : [n, folder(n, v)],
    );
  return {
    kind: "directory",
    name,
    async *entries() {
      yield* handles();
    },
    async getDirectoryHandle(n: string) {
      const v = tree[n];
      if (!v || typeof v === "string" || v instanceof Uint8Array) throw new DOMException("not found", "NotFoundError");
      return folder(n, v);
    },
    async getFileHandle(n: string) {
      const v = tree[n];
      if (v === undefined || !(typeof v === "string" || v instanceof Uint8Array)) throw new DOMException("not found", "NotFoundError");
      return { kind: "file", name: n, getFile: async () => new File([v], n) };
    },
  };
}

const root = folder("shop", {
  ".git": { HEAD: "ref: refs/heads/main MAGA-400", config: "url = https://token@example.com/shop.git" },
  ".env": "TOKEN=MAGA-400-secret",
  ".env.example": "TOKEN=",
  // Not a key's real marker: the repository refuses anything shaped like one (modules.test.ts).
  deploy: { "server.pem": "fake key material MAGA-400" },
  node_modules: { lib: { "x.js": "MAGA-400 inside a dependency" } },
  dist: { "app.js": "MAGA-400 built" },
  "README.md": "# Shop\r\nMAGA-400 notes\r\n",
  src: {
    "InventoryService.kt": Array.from({ length: 900 }, (_, i) => (i === 41 ? "// MAGA-400: stock below zero" : `line ${i + 1}`)).join("\n"),
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x4d, 0x41, 0x47, 0x41]),
  },
});

describe("browserTool", () => {
  it("ls: a folder's entries, folders first, marked with a slash", async () => {
    const out = await browserTool(root, "ls", { repo: "shop", path: "" });
    expect(out).toEqual({ ok: true, result: { path: "", entries: [{ name: "deploy", dir: true }, { name: "dist", dir: true }, { name: "node_modules", dir: true }, { name: "src", dir: true }, { name: ".env.example", dir: false }, { name: "README.md", dir: false }], truncated: false } });
  });

  it("grep: hits with line numbers, never in .git, node_modules, build output or binaries; CRLF read as lines", async () => {
    const out = await browserTool(root, "grep", { repo: "shop", query: "maga-400" });
    expect(out.ok && out.result).toEqual({
      hits: [
        { path: "README.md", line: 2, text: "MAGA-400 notes" },
        { path: "src/InventoryService.kt", line: 42, text: "// MAGA-400: stock below zero" },
      ],
      truncated: false,
      // README, the Kotlin file and .env.example: the binary and the private files aren't read.
      files: 3,
    });
    const regex = await browserTool(root, "grep", { repo: "shop", query: "stock\\s+below", regex: true, glob: "*.kt" });
    expect(regex.ok && "hits" in regex.result && regex.result.hits.map(h => h.line)).toEqual([42]);
    expect((await browserTool(root, "grep", { repo: "shop", query: "(", regex: true })).ok).toBe(false);
  });

  it("find: paths matching a glob", async () => {
    const out = await browserTool(root, "find", { repo: "shop", pattern: "*Inventory*", path: "" });
    expect(out.ok && out.result).toEqual({ paths: ["src/InventoryService.kt"], truncated: false });
  });

  it("read: a line range, at most 400 lines a call", async () => {
    const out = await browserTool(root, "read", { repo: "shop", path: "src/InventoryService.kt", from: 41, to: 42 });
    expect(out.ok && out.result).toEqual({ path: "src/InventoryService.kt", from: 41, to: 42, total: 900, lines: ["line 41", "// MAGA-400: stock below zero"] });
    const whole = await browserTool(root, "read", { repo: "shop", path: "src/InventoryService.kt" });
    expect(whole.ok && "lines" in whole.result && whole.result.lines.length).toBe(400);
    const crlf = await browserTool(root, "read", { repo: "shop", path: "README.md" });
    expect(crlf.ok && crlf.result).toEqual({ path: "README.md", from: 1, to: 2, total: 2, lines: ["# Shop", "MAGA-400 notes"] });
    expect((await browserTool(root, "read", { repo: "shop", path: "src/logo.png" })).ok).toBe(false);
  });

  it("refuses any path out of the folder, and the git tools", async () => {
    for (const path of ["../secret", "/etc/passwd", "C:\\Windows\\win.ini", "src/../../x", "~/x"]) {
      expect((await browserTool(root, "read", { repo: "shop", path })).ok, path).toBe(false);
      expect((await browserTool(root, "ls", { repo: "shop", path })).ok, path).toBe(false);
    }
    expect((await browserTool(root, "read", { repo: "shop", path: "src/missing.kt" })).ok).toBe(false);
    expect((await browserTool(root, "git_log", { repo: "shop", limit: 5 })).ok).toBe(false);
  });

  it("never shows the repository's secrets: .git, .env files, keys", async () => {
    for (const path of [".git/config", ".git", ".env", "deploy/server.pem"]) {
      const out = await browserTool(root, "read", { repo: "shop", path });
      expect(out.ok, path).toBe(false);
      expect(!out.ok && out.error, path).toMatch(/private/);
    }
    expect((await browserTool(root, "ls", { repo: "shop", path: ".git" })).ok).toBe(false);
    const grep = await browserTool(root, "grep", { repo: "shop", query: "secret|fake key|token@", regex: true });
    expect(grep.ok && "hits" in grep.result && grep.result.hits).toEqual([]);
    const find = await browserTool(root, "find", { repo: "shop", pattern: "*", path: "" });
    expect(find.ok && "paths" in find.result && find.result.paths.filter(p => /\.env$|\.pem$/.test(p))).toEqual([]);
    expect((await browserTool(root, "read", { repo: "shop", path: ".env.example" })).ok).toBe(true);
  });

  it("stops when asked", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(browserTool(root, "grep", { repo: "shop", query: "x" }, stop.signal)).rejects.toThrow();
  });
});
