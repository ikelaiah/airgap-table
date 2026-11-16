"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../js/core.js");

test("formats messy markdown with alignment", () => {
  const input = "|a|bb|c|\n|:-|:-:|-:|\n|1|2|333|\n";
  assert.equal(
    T.format(T.parse(input)),
    "| a   | bb  |   c |\n| :-- | :-: | --: |\n| 1   |  2  | 333 |\n"
  );
});

test("pads short rows and keeps escaped pipes", () => {
  const t = T.parse("a | b | c\n--|--|--\nx \\| y\n");
  assert.deepEqual(t.rows[0], ["x \\| y", "", ""]);
});

test("first row becomes header when delimiter row missing", () => {
  const t = T.parse("| a | b |\n| 1 | 2 |");
  assert.deepEqual(t.header, ["a", "b"]);
  assert.deepEqual(t.rows, [["1", "2"]]);
});

test("converts CSV with quotes, commas and pipes", () => {
  const t = T.parse('name,note\n"Doe, J","say ""hi"" | bye"\n');
  assert.deepEqual(t.rows[0], ["Doe, J", 'say "hi" \\| bye']);
});

test("converts TSV", () => {
  assert.equal(T.detectFormat("a\tb\n1\t2"), "tsv");
  assert.deepEqual(T.parse("a\tb\n1\t2").rows, [["1", "2"]]);
});

test("compact output", () => {
  assert.equal(T.format(T.parse("|a|b|\n|1|2|"), { compact: true }), "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
});

test("wide characters count as 2 columns", () => {
  assert.equal(T.displayWidth("日本"), 4);
  assert.equal(T.displayWidth("é"), 1);
});

test("transpose and blank", () => {
  const t = T.transpose(T.parse("|a|b|\n|-|-|\n|1|2|"));
  assert.deepEqual(t.header, ["a", "1"]);
  const b = T.blank(2, 3);
  assert.equal(b.header.length, 2);
  assert.equal(b.rows.length, 3);
  assert.equal(T.blank(9999, 9999).header.length, 50);
});

test("empty input", () => {
  assert.equal(T.format(T.parse("  \n")), "");
});

test("HTML is passed through as text, never interpreted", () => {
  const out = T.format(T.parse("|<img src=x onerror=alert(1)>|\n|-|"));
  assert.ok(out.includes("<img src=x onerror=alert(1)>"));
});

test("chunked Parser matches one-shot parse (markdown and CSV)", () => {
  const rows = Array.from({ length: 2500 }, (_, i) => `| r${i} | "q, ${i}" | ${i * 3} |`);
  const mdText = "| a | b | c |\n|:-|:-:|-:|\n" + rows.join("\n");
  const csvText = "a,b,c\n" + Array.from({ length: 2500 }, (_, i) => `r${i},"q, ""${i}""\nx",${i}`).join("\n");
  for (const text of [mdText, csvText]) {
    const p = new T.Parser(text);
    let guard = 0;
    while (!p.step(7)) { assert.ok(p.progress() < 1); guard++; }
    assert.ok(guard > 10);
    assert.deepEqual(p.result(), T.parse(text));
  }
});

test("chunked Formatter matches one-shot format", () => {
  const t = T.parse("| a | bb | 日本 |\n|:-|:-:|-:|\n" + Array.from({ length: 300 }, (_, i) => `| ${i} | x${i % 7} | y |`).join("\n"));
  for (const compact of [false, true]) {
    const f = new T.Formatter(t, { compact });
    while (!f.step(5)) assert.ok(f.progress() < 1);
    assert.equal(f.result(), T.format(t, { compact }));
  }
  const empty = new T.Formatter(T.parse("|a|b|\n|-|-|"));
  assert.ok(empty.step(5));
  assert.equal(empty.result(), "| a   | b   |\n| --- | --- |\n");
});
