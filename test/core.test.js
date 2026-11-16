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
