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

  function cleanDelimitedRow(r) {
    return r.map(function (c) {
      return c.trim().replace(/\r?\n/g, "<br>").replace(/(^|[^\\])\|/g, "$1\\|");
    });
  }
  function nonEmpty(row) { return row.some(function (c) { return c.trim() !== ""; }); }

  // Resumable RFC 4180-style tokenizer for CSV (sep ",") or TSV (sep "\t").
  // step(limit) consumes up to `limit` characters, so large input can be split across frames.
  function DelimitedTokenizer(text, sep) {
    this.text = text; this.sep = sep; this.pos = 0;
    this.rows = []; this.row = []; this.cur = ""; this.q = false; this.done = false;
  }
  DelimitedTokenizer.prototype.step = function (limit) {
    var text = this.text, sep = this.sep, end = Math.min(text.length, this.pos + limit);
    var row = this.row, cur = this.cur, q = this.q, i = this.pos;
    for (; i < end; i++) {
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
        if (nonEmpty(row)) this.rows.push(cleanDelimitedRow(row));
        row = [];
      } else cur += ch;
    }
    this.pos = i; this.row = row; this.cur = cur; this.q = q;
    if (i >= text.length && !this.done) {
      row.push(cur);
      if (nonEmpty(row)) this.rows.push(cleanDelimitedRow(row));
      this.row = []; this.cur = ""; this.done = true;
    }
    return this.done;
  };

  function parseDelimited(text, sep) {
    var t = new DelimitedTokenizer(text, sep);
    t.step(Infinity);
    return t.rows;
  }

  function detectFormat(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    if (!lines.length) return "empty";
    if (lines[0].indexOf("|") !== -1) return "markdown";
    if (lines[0].indexOf("\t") !== -1) return "tsv";
    if (lines[0].indexOf(",") !== -1) return "csv";
    return "markdown";
  }

  // Resumable parser. step(limit) does a bounded slice of work and returns true when done;
  // progress() is 0..1; result() returns { header, align, rows }.
  function Parser(text) {
    this.fmt = detectFormat(text);
    this.align = null;
    this.grid = [];
    this.done = this.fmt === "empty";
    if (this.fmt === "tsv" || this.fmt === "csv") {
      this.tok = new DelimitedTokenizer(text, this.fmt === "tsv" ? "\t" : ",");
    } else if (!this.done) {
      this.lines = text.split(/\r?\n/);
      this.li = 0;
      this.seen = 0; // non-empty lines so far
    }
  }
  Parser.prototype.step = function (limit) {
    if (this.done) return true;
    if (this.tok) {
      // ~40 chars per row is a fair unit, so `limit` means roughly "rows".
      this.done = this.tok.step(limit === Infinity ? Infinity : limit * 40);
      return this.done;
    }
    var end = Math.min(this.lines.length, this.li + limit);
    for (; this.li < end; this.li++) {
      var l = this.lines[this.li];
      if (l.trim() === "") continue;
      var cells = splitRow(l);
      var isDelim = cells.every(function (c) { return DELIM_CELL.test(c); });
      if (this.seen === 1 && isDelim) this.align = cells.map(alignOf);
      else if (!(this.seen > 1 && isDelim)) this.grid.push(cells); // stray delimiter rows are dropped
      this.seen++;
    }
    this.done = this.li >= this.lines.length;
    return this.done;
  };
  Parser.prototype.progress = function () {
    if (this.done) return 1;
    if (this.tok) return this.tok.pos / Math.max(1, this.tok.text.length);
    return this.li / Math.max(1, this.lines.length);
  };
  Parser.prototype.rowsSoFar = function () {
    return this.tok ? this.tok.rows.length : this.grid.length;
  };
  Parser.prototype.result = function () {
    if (this.fmt === "empty") return { header: [], align: [], rows: [] };
    var grid = this.tok ? this.tok.rows : this.grid;
    var width = 0, i;
    for (i = 0; i < grid.length; i++) if (grid[i].length > width) width = grid[i].length;
    for (i = 0; i < grid.length; i++) while (grid[i].length < width) grid[i].push("");
    var align = this.align || [], a = [];
    for (i = 0; i < width; i++) a.push(align[i] || "none");
    return { header: grid[0] || [], align: a, rows: grid.slice(1) };
  };

  function parse(text) {
    var p = new Parser(text);
    p.step(Infinity);
    return p.result();
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

  var ASCII = /^[\x20-\x7e]*$/;
  function displayWidth(s) {
    if (ASCII.test(s)) return s.length;
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

  function line(cells) { return "| " + cells.join(" | ") + " |"; }

  // Resumable formatter: pass 1 measures column widths, pass 2 builds lines.
  // step(limit) handles up to `limit` rows; opts.compact skips padding.
  function Formatter(t, opts) {
    this.t = t;
    this.compact = !!(opts && opts.compact);
    this.n = t.header.length;
    this.widths = [];
    for (var c = 0; c < this.n; c++) this.widths.push(Math.max(3, displayWidth(t.header[c] || "")));
    this.phase = 0;
    this.i = 0;
    this.out = [];
    this.done = !this.n;
    if (this.n && this.compact) this.startLines();
  }
  Formatter.prototype.startLines = function () {
    var t = this.t, w = this.widths;
    this.phase = 1; this.i = 0;
    if (this.compact) {
      this.out.push(line(t.header), line(t.align.map(function (a) { return delimiter(a, 3); })));
    } else {
      this.out.push(line(t.header.map(function (h, k) { return pad(h, w[k], t.align[k]); })));
      this.out.push(line(t.align.map(function (a, k) { return delimiter(a, w[k]); })));
    }
  };
  Formatter.prototype.step = function (limit) {
    var t = this.t, rows = t.rows, n = this.n, w = this.widths, c, r, end;
    while (!this.done) {
      end = Math.min(rows.length, this.i + limit);
      limit -= end - this.i;
      if (this.phase === 0) {
        for (; this.i < end; this.i++) {
          r = rows[this.i];
          for (c = 0; c < n; c++) { var d = displayWidth(r[c] || ""); if (d > w[c]) w[c] = d; }
        }
        if (this.i >= rows.length) this.startLines();
      } else {
        for (; this.i < end; this.i++) {
          r = rows[this.i];
          if (this.compact) { this.out.push(line(r)); continue; }
          var cells = new Array(n);
          for (c = 0; c < n; c++) cells[c] = pad(r[c] || "", w[c], t.align[c]);
          this.out.push(line(cells));
        }
        if (this.i >= rows.length) this.done = true;
      }
      if (limit <= 0 && !this.done) return false;
    }
    return true;
  };
  Formatter.prototype.progress = function () {
    if (this.done) return 1;
    var total = Math.max(1, this.t.rows.length) * (this.compact ? 1 : 2);
    return ((this.phase === 1 && !this.compact ? this.t.rows.length : 0) + this.i) / total;
  };
  Formatter.prototype.result = function () {
    return this.n ? this.out.join("\n") + "\n" : "";
  };

  function format(t, opts) {
    var f = new Formatter(t, opts);
    f.step(Infinity);
    return f.result();
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
    parseDelimited: parseDelimited, Parser: Parser, Formatter: Formatter,
  });

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MdTable = api;
})(this);
