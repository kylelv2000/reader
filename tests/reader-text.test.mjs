import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReaderText } from "../app/reader-text.mjs";

test("reader text removes literal HTML and keeps paragraphs", () => {
  assert.equal(
    normalizeReaderText("<p>第一段<br>下一行</p><p class=\"chapter\">第二段</p>"),
    "第一段\n下一行\n\n第二段",
  );
});

test("reader text removes repeatedly encoded tags and decodes entities", () => {
  assert.equal(
    normalizeReaderText("&amp;lt;p&amp;gt;黎明&amp;nbsp;之剑&amp;lt;/p&amp;gt;"),
    "黎明 之剑",
  );
});

test("reader text removes executable markup contents", () => {
  assert.equal(normalizeReaderText("正文<script>alert(1)</script><style>p{color:red}</style>结尾"), "正文结尾");
});
