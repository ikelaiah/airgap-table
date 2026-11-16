/* Pure table logic. No DOM, no network, no globals beyond `MdTable`. */
(function (root) {
  "use strict";

  var DELIM_CELL = /^\s*:?-+:?\s*$/;

  // Split a Markdown row on unescaped pipes, dropping outer pipes.
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.length && s.charAt(s.length - 1) === "|" && s.charAt(s.length - 2) !== "\\") s = s.slice(0, -1);
    var cells = [];
    var cur = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "\\" && s.charAt(i + 1) === "|") { cur += "\\|"; i++; continue; }
      if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function alignOf(cell) {
    var c = cell.trim();
    var l = c.charAt(0) === ":";
    var r = c.charAt(c.length - 1) === ":";
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "none";
  }

  // RFC 4180-style parser for CSV (sep ",") or TSV (sep "\t").
  function parseDelimited(text, sep) {
    var rows = [], row = [], cur = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"' && cur === "") q = true;
      else if (ch === sep) { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text.charAt(i + 1) === "\n") i++;
        row.push(cur); cur = "";
        if (row.some(function (c) { return c.trim() !== ""; })) rows.push(row);
        row = [];
      } else cur += ch;
    }
    row.push(cur);
    if (row.some(function (c) { return c.trim() !== ""; })) rows.push(row);
    return rows.map(function (r) {
      return r.map(function (c) {
        return c.trim().replace(/\r?\n/g, "<br>").replace(/(^|[^\\])\|/g, "$1\\|");
      });
    });
  }

  function detectFormat(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    if (!lines.length) return "empty";
    if (lines[0].indexOf("|") !== -1) return "markdown";
    if (lines[0].indexOf("\t") !== -1) return "tsv";
    if (lines[0].indexOf(",") !== -1) return "csv";
    return "markdown";
  }

  // Returns { header: string[], align: string[], rows: string[][] }.
  function parse(text) {
    var fmt = detectFormat(text);
    var grid;
    var align = null;
    if (fmt === "empty") return { header: [], align: [], rows: [] };
    if (fmt === "tsv" || fmt === "csv") {
      grid = parseDelimited(text, fmt === "tsv" ? "\t" : ",");
    } else {
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
      grid = [];
      lines.forEach(function (l, idx) {
        var cells = splitRow(l);
        if (idx === 1 && cells.every(function (c) { return DELIM_CELL.test(c); })) {
          align = cells.map(alignOf);
        } else if (idx > 1 && cells.every(function (c) { return DELIM_CELL.test(c); })) {
          // stray delimiter row: ignore
        } else grid.push(cells);
      });
    }
    var width = grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    grid = grid.map(function (r) { while (r.length < width) r.push(""); return r; });
    align = align || [];
    var a = [];
    for (var i = 0; i < width; i++) a.push(align[i] || "none");
    return { header: grid[0] || [], align: a, rows: grid.slice(1) };
  }

  // Display width: wide East Asian / emoji = 2, combining marks = 0.
  function charWidth(cp) {
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) return 2;
    return 1;
  }

  function displayWidth(s) {
    var w = 0;
    for (var ch of s) w += charWidth(ch.codePointAt(0));
    return w;
  }

  function pad(s, width, align) {
    var gap = width - displayWidth(s);
    if (gap <= 0) return s;
    if (align === "right") return " ".repeat(gap) + s;
    if (align === "center") {
      var l = Math.floor(gap / 2);
      return " ".repeat(l) + s + " ".repeat(gap - l);
    }
    return s + " ".repeat(gap);
  }

  function delimiter(align, width) {
    var w = Math.max(width, 3);
    if (align === "center") return ":" + "-".repeat(w - 2) + ":";
    if (align === "left") return ":" + "-".repeat(w - 1);
    if (align === "right") return "-".repeat(w - 1) + ":";
    return "-".repeat(w);
  }

  // opts.compact: no padding. Returns Markdown string.
  function format(t, opts) {
    opts = opts || {};
    var n = t.header.length;
    if (!n) return "";
    var all = [t.header].concat(t.rows);
    var widths = [];
    for (var c = 0; c < n; c++) {
      widths.push(all.reduce(function (m, r) { return Math.max(m, displayWidth(r[c] || "")); }, 3));
    }
    function line(cells) { return "| " + cells.join(" | ") + " |"; }
    if (opts.compact) {
      return [
        line(t.header),
        line(t.align.map(function (a) { return delimiter(a, 3); })),
      ].concat(t.rows.map(line)).join("\n") + "\n";
    }
    var out = [line(t.header.map(function (h, i) { return pad(h, widths[i], t.align[i]); }))];
    out.push(line(t.align.map(function (a, i) { return delimiter(a, widths[i]); })));
    t.rows.forEach(function (r) {
      out.push(line(r.map(function (cell, i) { return pad(cell, widths[i], t.align[i]); })));
    });
    return out.join("\n") + "\n";
  }

  function transpose(t) {
    var all = [t.header].concat(t.rows);
    var out = [];
    for (var c = 0; c < t.header.length; c++) out.push(all.map(function (r) { return r[c] || ""; }));
    var a = [];
    for (var i = 0; i < all.length; i++) a.push("none");
    return { header: out[0] || [], align: a, rows: out.slice(1) };
  }

  function setAlign(t, align) {
    return { header: t.header, align: t.header.map(function () { return align; }), rows: t.rows };
  }

  function blank(cols, rows) {
    cols = Math.max(1, Math.min(50, cols | 0));
    rows = Math.max(0, Math.min(500, rows | 0));
    var header = [], align = [], body = [];
    for (var c = 0; c < cols; c++) { header.push("Header " + (c + 1)); align.push("none"); }
    for (var r = 0; r < rows; r++) body.push(header.map(function () { return ""; }));
    return { header: header, align: align, rows: body };
  }

  var api = Object.freeze({
    parse: parse, format: format, transpose: transpose, setAlign: setAlign,
    blank: blank, displayWidth: displayWidth, detectFormat: detectFormat,
    parseDelimited: parseDelimited,
  });

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MdTable = api;
})(this);
