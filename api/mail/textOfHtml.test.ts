import { describe, expect, it } from "vitest";
import { textOfHtml } from "./copies";

/** The regexes textOfHtml replaced: same text out, on any input they finish on. */
const before = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .slice(0, 200 * 1024);

const corpus = [
  "<p>Hello <b>there</b></p><p>Second&nbsp;line &amp; more</p>",
  "<html><head><style>p{color:red}</style><SCRIPT>alert(1)</SCRIPT></head><body>Hi<br>you<br/>there<BR />end</body></html>",
  "a < b and c > d, <> stays, <<double>>",
  "<style>a<script>b</style>c</script>tail",
  "<script>never closed <b>bold</b> rest",
  "<scripts>x</script> and <stylesheet>y</style> z",
  "text &lt;tag&gt; &amp;amp; entities",
  "<div\nclass='x'\n>multi\nline</div>",
  "no tags at all",
  "",
  "<",
  "trailing <",
  "<a <b>c</b>",
  "İİİab<script>evil()</script>visible",
  "<x<script>s</script>>",
  "<br<script></script>>",
  "<b<br>>",
  '<img alt="<script>">visible</script>',
  "<SCRIPT>a</sCrIpT>b<STYLE>c</STYLE>d",
  "<br   \n/>x</P>y",
  "&amp;nbsp;".repeat(50) + "<p>end</p>",
];

describe("text from a mail with only HTML", () => {
  it("reads as the regexes did", () => {
    for (const html of corpus) expect(textOfHtml(html), JSON.stringify(html)).toBe(before(html));
  });

  it("a hostile mail (unclosed <script, no >) takes linear time, not minutes", () => {
    for (const unit of ["<script", "<style", "<", "<script></style>"]) {
      const html = unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length));
      const t0 = performance.now();
      textOfHtml(html);
      expect(performance.now() - t0, unit).toBeLessThan(1500);
    }
  });
});
