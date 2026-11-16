/* UI. textContent/value only: never innerHTML, eval, storage or network. */
(function () {
  "use strict";
  const T = window.MdTable;
  const $ = (id) => document.getElementById(id);
  const md = $("md"), scroller = $("grid-scroll"), statusEl = $("status"), dims = $("dims");
  const MAX_CHARS = 25000000, MAX_ROWS = 200000, MAX_COLS = 50;
  const ASYNC_ROWS = 3000;        // above this, formatting runs in time slices
  const SYNC_PARSE_CHARS = 200000; // above this, parsing runs in time slices
  const OVERSCAN = 12;            // extra rows rendered above/below the viewport
  const HISTORY_BUDGET = 60000000; // max chars held by undo snapshots
  const fmtNum = (n) => n.toLocaleString();
  const GUTTER = 56; // px, matches --gutter in CSS
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const SVGNS = "http://www.w3.org/2000/svg";

  let model = { header: [], align: [], rows: [] };
  let rowIds = [], colIds = [], nextId = 1;
  let style = "padded";
  let undoStack = [], redoStack = [];
  let editSession = false, mdSession = false;
  let active = null; // { r, c }

  /* ---------- safety indicators (measured, not claimed) ---------- */
  let blocked = 0;
  document.addEventListener("securitypolicyviolation", () => {
    blocked++;
    $("proof-net").classList.replace("ok", "bad");
    $("net-sub").textContent = blocked + " attempt" + (blocked > 1 ? "s" : "") + " blocked by policy";
  });

  function checkFiles() {
    const entries = performance.getEntriesByType("resource");
    const foreign = entries.filter((e) => new URL(e.name, location.href).origin !== location.origin);
    const sub = $("files-sub");
    if (foreign.length) {
      $("proof-files").classList.replace("ok", "bad");
      sub.textContent = foreign.length + " external file" + (foreign.length > 1 ? "s" : "") + " detected";
    } else {
      sub.textContent = (entries.length + 1) + " files, all from this page";
    }
    sub.title = [location.pathname].concat(entries.map((e) => new URL(e.name).pathname)).join("\n");
  }

  $("verify-toggle").addEventListener("click", (e) => {
    const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
    e.currentTarget.setAttribute("aria-expanded", String(open));
    $("verify").hidden = !open;
  });

  /* Paste reassurance: at the moment people worry most, the network proof answers. */
  const netText = () => (blocked ? blocked + " attempt" + (blocked > 1 ? "s" : "") + " blocked by policy" : "0 outbound connections");
  const fmtChars = (n) => (n < 10000 ? fmtNum(n) : n < 1e6 ? (n / 1e3).toFixed(1) + "K" : (n / 1e6).toFixed(1) + "M") + (n === 1 ? " character" : " characters");
  let reassureTimer = 0;
  function reassure(chars) {
    if (blocked) return; // never paper over a real warning
    const proof = $("proof-net"), sub = $("net-sub");
    sub.textContent = "Pasted " + fmtChars(chars) + " · 0 sent";
    proof.classList.remove("pulse");
    void proof.offsetWidth; // restart the animation on repeat pastes
    proof.classList.add("pulse");
    clearTimeout(reassureTimer);
    reassureTimer = setTimeout(() => { sub.textContent = netText(); proof.classList.remove("pulse"); }, 2600);
  }
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (text) reassure(text.length);
  }, true);

  /* Wipe: an inline second click instead of a modal, then the data visibly leaves. */
  const wipeBtn = $("wipe"), wipeLabel = wipeBtn.lastChild;
  let wipeArmed = 0;
  function disarmWipe() {
    clearTimeout(wipeArmed);
    wipeArmed = 0;
    wipeBtn.classList.remove("armed");
    wipeLabel.textContent = " Wipe data";
  }
  wipeBtn.addEventListener("blur", disarmWipe);
  wipeBtn.addEventListener("click", () => {
    if (!wipeArmed) {
      wipeBtn.classList.add("armed");
      wipeLabel.textContent = " Click again to wipe";
      say("Click Wipe again to clear the table, Markdown and undo history. This cannot be undone.");
      wipeArmed = setTimeout(disarmWipe, 3500);
      return;
    }
    disarmWipe();
    // Clear the data first; the dissolve below only plays on the leftover pixels.
    model = { header: [], align: [], rows: [] };
    rowIds = []; colIds = []; undoStack = []; redoStack = []; active = null;
    parseJob++; fmtJob++; // cancel any background work holding the old data
    mdFull = null; md.readOnly = false; $("md-large").hidden = true;
    syncHistoryButtons();
    const finish = () => {
      md.value = "";
      md.classList.remove("dissolving");
      wipedNotice = true;
      render();
      say("Wiped. Table, Markdown and undo history are cleared from this tab's memory.");
    };
    if (reduceMotion.matches || !Element.prototype.animate) { finish(); return; }
    const ease = "cubic-bezier(0.4, 0, 1, 1)";
    const rows = Array.from(scroller.querySelectorAll("thead tr, tbody tr[data-id], .add"));
    rows.forEach((n, i) => n.animate(
      [{ opacity: 1, transform: "translateY(0)", filter: "blur(0)" }, { opacity: 0, transform: "translateY(-6px)", filter: "blur(3px)" }],
      { duration: 220, delay: Math.min(i, 14) * 16, easing: ease, fill: "forwards" }
    ));
    md.classList.add("dissolving");
    setTimeout(finish, 220 + Math.min(rows.length, 14) * 16);
  });
  let wipedNotice = false;

  /* ---------- icons ---------- */
  const ICONS = {
    grip: null,
    none: "M5 8h14M5 12h14M5 16h14",
    left: "M4 6h16M4 10h10M4 14h16M4 18h10",
    center: "M4 6h16M7 10h10M4 14h16M7 18h10",
    right: "M4 6h16M10 10h10M4 14h16M10 18h10",
    x: "M7 7l10 10M17 7L7 17",
    plus: "M12 5v14M5 12h14",
  };
  function icon(name) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    if (name === "grip") {
      s.classList.add("fill");
      [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]].forEach(([cx, cy]) => {
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", "1.5");
        s.appendChild(c);
      });
    } else {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", ICONS[name]);
      s.appendChild(p);
    }
    return s;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function iconButton(name, label, cls) {
    const b = el("button", "icon " + (cls || ""));
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.appendChild(icon(name));
    return b;
  }

  /* ---------- model helpers ---------- */
  const show = (s) => s.replace(/\\\|/g, "|");
  const store = (s) => s.replace(/\r?\n/g, " ").replace(/\\\|/g, "|").replace(/\|/g, "\\|");
  const colName = (c) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
  const ALIGN_NEXT = { none: "left", left: "center", center: "right", right: "none" };
  const ALIGN_LABEL = { none: "Default", left: "Left", center: "Center", right: "Right" };

  function freshIds() {
    rowIds = model.rows.map(() => nextId++);
    colIds = model.header.map(() => nextId++);
  }
  function snapshot() {
    return JSON.stringify({ m: model, r: rowIds, c: colIds });
  }
  function restore(s) {
    const o = JSON.parse(s);
    model = o.m; rowIds = o.r; colIds = o.c;
  }
  /* History entries are full snapshots (strings) or cheap cell patches ({ cell, r, c, v }). */
  const entrySize = (e) => (typeof e === "string" ? e.length : 64);
  function pushHistory(entry) {
    undoStack.push(entry || snapshot());
    redoStack = [];
    let total = 0;
    undoStack.forEach((e) => { total += entrySize(e); });
    while ((total > HISTORY_BUDGET && undoStack.length > 1) || undoStack.length > 200) total -= entrySize(undoStack.shift());
    syncHistoryButtons();
  }
  const getCell = (r, c) => (r < 0 ? model.header[c] : model.rows[r][c]);
  function setCell(r, c, v) { if (r < 0) model.header[c] = v; else model.rows[r][c] = v; }
  function syncHistoryButtons() {
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
  }
  function step(from, to, msg) {
    if (!from.length) return;
    const e = from.pop();
    if (e && e.cell) {
      to.push({ cell: true, r: e.r, c: e.c, v: getCell(e.r, e.c) });
      setCell(e.r, e.c, e.v);
      syncHistoryButtons();
      render();
      writeMarkdown(true);
      focusCell(e.r, e.c, false);
      say(msg);
      return;
    }
    to.push(snapshot());
    const before = measure();
    restore(e);
    syncHistoryButtons();
    render();
    flip(before);
    writeMarkdown(true);
    say(msg);
  }
  const undo = () => step(undoStack, redoStack, "Undone.");
  const redo = () => step(redoStack, undoStack, "Redone.");

  function say(msg) { statusEl.textContent = msg; }
  function updateDims() {
    dims.textContent = model.header.length
      ? fmtNum(model.header.length) + " columns × " + fmtNum(model.rows.length) + " rows"
      : "";
  }

  /* Time-sliced work: ~10ms per slice, yielding to the browser between slices,
     so input, scrolling and painting never wait on a big table. */
  const progressEl = $("progress"), progressBar = $("progress-bar"), progressLabel = $("progress-label");
  let progressOwner = 0;
  function showProgress(owner, frac, label) {
    progressOwner = owner;
    progressEl.hidden = false;
    progressBar.style.transform = "scaleX(" + Math.max(0.02, frac).toFixed(3) + ")";
    progressLabel.textContent = label + " · " + Math.round(frac * 100) + "%";
  }
  function hideProgress(owner) {
    if (owner !== progressOwner) return;
    progressEl.hidden = true;
  }
  let sliceSeq = 0;
  function runSliced(worker, isCurrent, label, onDone) {
    const owner = ++sliceSeq, t0 = performance.now();
    (function slice() {
      if (!isCurrent()) { hideProgress(owner); return; }
      const until = performance.now() + 10;
      let done = false;
      while (!done && performance.now() < until) done = worker.step(500);
      if (done) { hideProgress(owner); onDone(performance.now() - t0); return; }
      if (performance.now() - t0 > 120) showProgress(owner, worker.progress(), typeof label === "function" ? label() : label);
      setTimeout(slice, 0);
    })();
  }

  /* Large Markdown lives in memory, not in the textarea: browsers re-lay out a
     multi-megabyte textarea on every page layout. The textarea shows a read-only preview. */
  const LARGE_CHARS = 1000000, PREVIEW_LINES = 400;
  let mdFull = null;
  function setMarkdown(text) {
    if (text.length <= LARGE_CHARS) {
      mdFull = null;
      md.readOnly = false;
      $("md-large").hidden = true;
      md.value = text;
      return;
    }
    mdFull = text;
    let cut = -1, lines = 0;
    while (lines < PREVIEW_LINES && (cut = text.indexOf("\n", cut + 1)) !== -1) lines++;
    let total = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) total++;
    md.readOnly = true;
    md.value = text.slice(0, cut === -1 ? text.length : cut) + "\n";
    $("md-large-text").textContent = "Large table: showing the first " + fmtNum(PREVIEW_LINES) + " of " +
      fmtNum(total) + " lines (" + (text.length / 1048576).toFixed(1) + " MB). Copy includes everything.";
    $("md-large").hidden = false;
  }
  const getMarkdown = () => (mdFull != null ? mdFull : md.value);
  $("md-edit-all").addEventListener("click", () => {
    if (mdFull == null) return;
    say("Loading the full text into the editor. Scrolling may be slow at this size.");
    const text = mdFull;
    mdFull = null;
    $("md-large").hidden = true;
    md.readOnly = false;
    setTimeout(() => { md.value = text; md.focus(); md.setSelectionRange(0, 0); }, 30);
  });

  let fmtJob = 0;
  function writeMarkdown(force) {
    updateDims();
    if (!force && document.activeElement === md && !md.readOnly) return;
    const job = ++fmtJob, opts = { compact: style === "compact" };
    if (model.rows.length < ASYNC_ROWS) { setMarkdown(T.format(model, opts)); return; }
    const f = new T.Formatter(model, opts);
    runSliced(f, () => job === fmtJob, "Writing Markdown", () => {
      if (force || document.activeElement !== md || md.readOnly) setMarkdown(f.result());
    });
  }

  /* ---------- springs ---------- */
  const K = 420, C = 30; // slightly underdamped: settles with a hint of overshoot
  const springs = new Map();
  let raf = 0, last = 0;
  function spring(node, axis, x, target, held) {
    let s = springs.get(node);
    if (!s) { s = { x: 0, v: 0, target: 0, axis: axis }; springs.set(node, s); }
    if (x != null) s.x = x;
    s.target = target; s.held = !!held; s.axis = axis;
    if (reduceMotion.matches && !held) { s.x = s.target; s.v = 0; }
    apply(node, s);
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function apply(node, s) {
    node.style.transform = s.x === 0 && s.target === 0 && !s.held ? "" :
      (s.axis === "y" ? "translate3d(0," + s.x + "px,0)" : "translate3d(" + s.x + "px,0,0)");
  }
  function tick(now) {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    let moving = false;
    springs.forEach((s, node) => {
      if (!s.held) {
        const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
        for (let i = 0; i < n; i++) { s.v += (K * (s.target - s.x) - C * s.v) * h; s.x += s.v * h; }
        if (Math.abs(s.target - s.x) < 0.2 && Math.abs(s.v) < 0.2) { s.x = s.target; s.v = 0; }
        else moving = true;
      } else moving = true;
      apply(node, s);
      if (!s.held && s.x === 0 && s.target === 0) springs.delete(node);
    });
    raf = moving ? requestAnimationFrame(tick) : 0;
  }

  /* FLIP: measure before a change, then spring each row/column from its old spot. */
  function measure() {
    const m = new Map();
    scroller.querySelectorAll("tr[data-id]").forEach((tr) => m.set("r" + tr.dataset.id, tr.getBoundingClientRect().top));
    scroller.querySelectorAll("tr.head th[data-cid]").forEach((th) => m.set("c" + th.dataset.cid, th.getBoundingClientRect().left));
    return m;
  }
  function flip(before) {
    if (!before) return;
    scroller.querySelectorAll("tr[data-id]").forEach((tr) => {
      const old = before.get("r" + tr.dataset.id);
      if (old == null) { enter(tr); return; }
      const d = old - tr.getBoundingClientRect().top;
      if (Math.abs(d) > 0.5) spring(tr, "y", d, 0);
    });
    scroller.querySelectorAll("tr.head th[data-cid]").forEach((th) => {
      const cid = th.dataset.cid;
      const old = before.get("c" + cid);
      const cells = scroller.querySelectorAll('[data-cid="' + cid + '"]');
      if (old == null) { cells.forEach(enter); return; }
      const d = old - th.getBoundingClientRect().left;
      if (Math.abs(d) > 0.5) cells.forEach((c) => spring(c, "x", d, 0));
    });
  }
  function enter(node) {
    if (reduceMotion.matches || !node.animate) return;
    node.animate(
      [{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "blur(0)" }],
      { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
  }

  /* ---------- render ---------- */
  /* Virtual window state for the current render. */
  let vt = null;
  const vrows = new Map(); // row index -> <tr>
  let colWidths = [];

  const clampW = (w) => Math.max(6, Math.min(40, w));
  const colCss = (w) => "calc(" + w + "ch + 26px)";
  function computeColWidths() {
    const n = model.header.length, rows = model.rows;
    const w = model.header.map((h) => clampW(T.displayWidth(show(h)) + 1));
    const stepBy = Math.max(1, Math.floor(rows.length / 20000)); // sample huge tables
    for (let i = 0; i < rows.length; i += stepBy) {
      const r = rows[i];
      for (let c = 0; c < n; c++) {
        const d = T.displayWidth(show(r[c] || ""));
        if (d > w[c]) w[c] = clampW(d);
      }
    }
    return w;
  }
  function tableWidth() {
    let ch = 0;
    colWidths.forEach((w) => { ch += w; });
    return "calc(" + GUTTER + "px + " + ch + "ch + " + colWidths.length * 26 + "px)";
  }
  function growCol(c, v) {
    const w = clampW(T.displayWidth(show(v)));
    if (!vt || w <= colWidths[c]) return;
    colWidths[c] = w;
    vt.cols[c].style.width = colCss(w);
    vt.table.style.width = tableWidth();
  }

  function buildRow(r) {
    const n = model.header.length, row = model.rows[r];
    const tr = el("tr");
    tr.dataset.id = rowIds[r];
    tr.dataset.r = r;
    const g = el("th", "gutter");
    g.scope = "row";
    if (active && active.r === r) g.classList.add("is-active");
    const num = el("span", "num", fmtNum(r + 1));
    const tools = el("span", "tools");
    const grip = iconButton("grip", "Move row " + (r + 1) + " (drag, or arrow keys)", "grip");
    grip.dataset.drag = "row"; grip.dataset.r = r;
    const del = iconButton("x", "Delete row " + (r + 1), "del");
    del.dataset.act = "delrow"; del.dataset.r = r;
    tools.append(grip, del);
    g.append(num, tools);
    tr.appendChild(g);
    for (let c = 0; c < n; c++) {
      const td = el("td", "a-" + model.align[c]);
      td.dataset.cid = colIds[c];
      td.appendChild(cell(r, c, row[c]));
      tr.appendChild(td);
    }
    return tr;
  }

  function render() {
    springs.clear();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const keepTop = scroller.scrollTop, keepLeft = scroller.scrollLeft;
    scroller.textContent = "";
    vt = null;
    vrows.clear();
    updateDims();
    const n = model.header.length;

    if (!n) {
      const empty = el("div", "empty" + (wipedNotice ? " wiped" : ""));
      if (wipedNotice) {
        const seal = document.createElementNS(SVGNS, "svg");
        seal.setAttribute("viewBox", "0 0 24 24");
        seal.setAttribute("aria-hidden", "true");
        seal.classList.add("seal");
        ["M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z", "M9 12l2 2 4-4"].forEach((d) => {
          const p = document.createElementNS(SVGNS, "path");
          p.setAttribute("d", d);
          seal.appendChild(p);
        });
        empty.appendChild(seal);
        empty.appendChild(el("p", "empty-title", "Wiped"));
        empty.appendChild(el("p", "empty-body", "The table, Markdown and undo history are cleared from this tab's memory. Nothing was saved or sent."));
        wipedNotice = false;
      } else {
        empty.appendChild(el("p", "empty-title", "No table yet"));
        empty.appendChild(el("p", "empty-body", "Paste Markdown, CSV or spreadsheet cells into the Markdown box, or start a blank table."));
      }
      const b = el("button", "primary", "Start a 3 × 3 table");
      b.type = "button";
      b.addEventListener("click", () => newTable(3, 3));
      empty.appendChild(b);
      scroller.appendChild(empty);
      return;
    }
    if (n > MAX_COLS || model.rows.length > MAX_ROWS) {
      const big = el("div", "empty");
      big.appendChild(el("p", "empty-title", "Too large for the grid"));
      big.appendChild(el("p", "empty-body", "The grid edits up to " + MAX_COLS + " columns and " + fmtNum(MAX_ROWS) + " rows. Edit this table in the Markdown box; Format still works."));
      scroller.appendChild(big);
      return;
    }

    const wrap = el("div", "sheet");
    const table = el("table", "grid");
    table.setAttribute("aria-label", "Table editor");
    table.setAttribute("aria-rowcount", String(model.rows.length + 1));
    const thead = el("thead"), tbody = el("tbody");

    colWidths = computeColWidths();
    const colgroup = el("colgroup");
    const gcol = el("col");
    gcol.style.width = GUTTER + "px";
    colgroup.appendChild(gcol);
    const cols = colWidths.map((w) => {
      const col = el("col");
      col.style.width = colCss(w);
      colgroup.appendChild(col);
      return col;
    });
    table.style.width = tableWidth();

    const bar = el("tr", "colbar");
    bar.appendChild(el("th", "corner"));
    const head = el("tr", "head");
    head.appendChild(el("th", "gutter corner"));

    for (let c = 0; c < n; c++) {
      const cid = colIds[c];
      const a = model.align[c];
      const th = el("th", "colctl");
      th.dataset.cid = cid; th.dataset.c = c;
      const letter = el("span", "letter", colName(c));
      const tools = el("span", "tools");
      const grip = iconButton("grip", "Move column " + colName(c) + " (drag, or arrow keys)", "grip");
      grip.dataset.drag = "col"; grip.dataset.c = c;
      const al = iconButton(a, "Column " + colName(c) + " alignment: " + ALIGN_LABEL[a] + ". Click to change", "align");
      al.dataset.act = "align"; al.dataset.c = c;
      const del = iconButton("x", "Delete column " + colName(c), "del");
      del.dataset.act = "delcol"; del.dataset.c = c;
      if (n === 1) del.disabled = true;
      tools.append(grip, al, del);
      th.append(letter, tools);
      bar.appendChild(th);

      const h = el("th", "a-" + a);
      h.dataset.cid = cid;
      h.scope = "col";
      h.appendChild(cell(-1, c, model.header[c]));
      head.appendChild(h);
    }
    thead.append(bar, head);

    // Rows are virtual: two spacer rows stand in for everything outside the viewport.
    const spacer = () => {
      const tr = el("tr", "spacer");
      tr.setAttribute("aria-hidden", "true");
      const td = el("td");
      td.colSpan = n + 1;
      tr.appendChild(td);
      return tr;
    };
    const topSp = spacer(), botSp = spacer();
    tbody.append(topSp, botSp);
    table.append(colgroup, thead, tbody);

    const addCol = el("button", "add add-col");
    addCol.type = "button";
    addCol.dataset.act = "addcol";
    addCol.setAttribute("aria-label", "Add column");
    addCol.title = "Add column";
    addCol.append(icon("plus"));
    const addRow = el("button", "add add-row");
    addRow.type = "button";
    addRow.dataset.act = "addrow";
    addRow.append(icon("plus"), el("span", "", "Add row"));

    wrap.append(table, addCol, addRow);
    scroller.appendChild(wrap);

    vt = { table, thead, tbody, topSp, botSp, cols, rowH: 37, tbodyTop: 0, headH: 0 };
    if (model.rows.length) {
      const probe = buildRow(0);
      tbody.insertBefore(probe, botSp);
      vt.rowH = probe.getBoundingClientRect().height || 37;
      probe.remove();
    }
    const sr = scroller.getBoundingClientRect();
    vt.tbodyTop = topSp.getBoundingClientRect().top - sr.top + scroller.scrollTop;
    vt.headH = thead.getBoundingClientRect().height;
    botSp.firstChild.style.height = Math.round(model.rows.length * vt.rowH) + "px";
    scroller.scrollTop = keepTop;
    scroller.scrollLeft = keepLeft;
    updateWindow();
    if (active) markActive(active.r, active.c);
  }

  /* Render only rows inside the viewport (plus overscan). Kept rows are never moved,
     so a focused cell stays focused while you scroll near it. */
  function updateWindow() {
    if (!vt || drag) return;
    const N = model.rows.length, H = vt.rowH;
    const top = scroller.scrollTop - vt.tbodyTop;
    const first = Math.max(0, Math.min(N, Math.floor(top / H) - OVERSCAN));
    const last = Math.max(first, Math.min(N, Math.ceil((top + scroller.clientHeight) / H) + OVERSCAN));
    vrows.forEach((tr, i) => {
      if (i < first || i >= last) { tr.remove(); vrows.delete(i); }
    });
    let ks = Infinity, ke = -Infinity;
    vrows.forEach((_, i) => { if (i < ks) ks = i; if (i + 1 > ke) ke = i + 1; });
    const add = (from, to, before) => {
      if (from >= to) return;
      const frag = document.createDocumentFragment();
      for (let i = from; i < to; i++) { const tr = buildRow(i); vrows.set(i, tr); frag.appendChild(tr); }
      vt.tbody.insertBefore(frag, before);
    };
    if (!vrows.size) add(first, last, vt.botSp);
    else {
      add(first, Math.min(ks, last), vrows.get(ks));
      add(Math.max(ke, first), last, vt.botSp);
    }
    vt.topSp.firstChild.style.height = Math.round(first * H) + "px";
    vt.botSp.firstChild.style.height = Math.round((N - last) * H) + "px";
    // Calibrate once per render from real rows, so spacers match the rendered row height.
    if (!vt.calibrated && vrows.size > 1) {
      vt.calibrated = true;
      const a = vrows.get(first), b = vrows.get(last - 1);
      const real = (b.getBoundingClientRect().bottom - a.getBoundingClientRect().top) / (last - first);
      if (real > 0 && Math.abs(real - H) > 0.25) { vt.rowH = real; updateWindow(); }
    }
  }
  let winRaf = 0;
  const scheduleWindow = () => { if (!winRaf) winRaf = requestAnimationFrame(() => { winRaf = 0; updateWindow(); }); };
  scroller.addEventListener("scroll", scheduleWindow, { passive: true });
  window.addEventListener("resize", scheduleWindow);

  let plaintextOnly = null;
  function cell(r, c, value) {
    const d = el("div", "cell", show(value || ""));
    if (plaintextOnly === null) {
      d.contentEditable = "plaintext-only";
      plaintextOnly = d.contentEditable === "plaintext-only";
    }
    d.contentEditable = plaintextOnly ? "plaintext-only" : "true";
    d.spellcheck = false;
    d.dataset.r = r; d.dataset.c = c;
    d.setAttribute("role", "textbox");
    d.setAttribute("aria-label", (r < 0 ? "Header " : "Row " + (r + 1) + " ") + "column " + colName(c));
    return d;
  }
  const cellAt = (r, c) => scroller.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"]');

  /* Scroll a row into view (below the sticky header), materialize it, then focus. */
  function focusCell(r, c, select) {
    if (r >= 0 && vt) {
      const H = vt.rowH, rowTop = vt.tbodyTop + r * H;
      const viewTop = scroller.scrollTop + vt.headH, viewBot = scroller.scrollTop + scroller.clientHeight;
      if (rowTop < viewTop) scroller.scrollTop = rowTop - vt.headH;
      else if (rowTop + H > viewBot) scroller.scrollTop = rowTop + H - scroller.clientHeight;
      updateWindow();
    }
    const d = cellAt(r, c);
    if (!d) return;
    d.focus({ preventScroll: true });
    const cr = d.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    if (cr.left < sr.left + GUTTER) scroller.scrollLeft -= sr.left + GUTTER - cr.left;
    else if (cr.right > sr.right) scroller.scrollLeft += cr.right - sr.right;
    const range = document.createRange();
    range.selectNodeContents(d);
    if (!select) range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function markActive(r, c) {
    scroller.querySelectorAll(".is-active").forEach((n) => n.classList.remove("is-active"));
    const cid = colIds[c];
    if (cid != null) scroller.querySelectorAll('.colctl[data-cid="' + cid + '"]').forEach((n) => n.classList.add("is-active"));
    if (r >= 0) {
      const tr = scroller.querySelector('tr[data-id="' + rowIds[r] + '"]');
      if (tr) tr.firstChild.classList.add("is-active");
    }
  }

  /* ---------- structural ops ---------- */
  function mutate(fn, msg, focus) {
    pushHistory();
    const before = measure();
    fn();
    render();
    flip(before);
    writeMarkdown(true);
    if (msg) say(msg);
    if (focus) focus();
  }
  function newTable(cols, rows) {
    mutate(() => { model = T.blank(cols, rows); freshIds(); }, "New table created.", () => focusCell(-1, 0, true));
  }
  function addRow(at) {
    if (model.rows.length >= MAX_ROWS) { say("Row limit reached (" + MAX_ROWS + ")."); return false; }
    model.rows.splice(at, 0, model.header.map(() => ""));
    rowIds.splice(at, 0, nextId++);
    return true;
  }
  function addCol(at) {
    if (model.header.length >= MAX_COLS) { say("Column limit reached (" + MAX_COLS + ")."); return false; }
    model.header.splice(at, 0, "Header " + (at + 1));
    model.align.splice(at, 0, "none");
    model.rows.forEach((r) => r.splice(at, 0, ""));
    colIds.splice(at, 0, nextId++);
    return true;
  }
  function moveRow(from, to) {
    if (to < 0 || to >= model.rows.length || from === to) return;
    model.rows.splice(to, 0, model.rows.splice(from, 1)[0]);
    rowIds.splice(to, 0, rowIds.splice(from, 1)[0]);
  }
  function moveCol(from, to) {
    if (to < 0 || to >= model.header.length || from === to) return;
    const mv = (a) => a.splice(to, 0, a.splice(from, 1)[0]);
    mv(model.header); mv(model.align); mv(colIds);
    model.rows.forEach(mv);
  }

  scroller.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const r = +b.dataset.r, c = +b.dataset.c;
    switch (b.dataset.act) {
      case "align": {
        mutate(() => { model.align[c] = ALIGN_NEXT[model.align[c]]; }, "Column " + colName(c) + " aligned " + ALIGN_LABEL[ALIGN_NEXT[model.align[c]]].toLowerCase() + ".",
          () => scroller.querySelector('.align[data-c="' + c + '"]').focus());
        break;
      }
      case "delcol":
        mutate(() => {
          model.header.splice(c, 1); model.align.splice(c, 1); colIds.splice(c, 1);
          model.rows.forEach((row) => row.splice(c, 1));
        }, "Column deleted. Ctrl+Z to undo.");
        break;
      case "delrow":
        mutate(() => { model.rows.splice(r, 1); rowIds.splice(r, 1); }, "Row deleted. Ctrl+Z to undo.");
        break;
      case "addrow":
        if (model.rows.length < MAX_ROWS) mutate(() => addRow(model.rows.length), "Row added.", () => focusCell(model.rows.length - 1, 0, true));
        else say("Row limit reached (" + MAX_ROWS + ").");
        break;
      case "addcol":
        if (model.header.length < MAX_COLS) mutate(() => addCol(model.header.length), "Column added.", () => focusCell(-1, model.header.length - 1, true));
        else say("Column limit reached (" + MAX_COLS + ").");
        break;
    }
  });

  /* Keyboard reorder on grips. */
  scroller.addEventListener("keydown", (e) => {
    const g = e.target.closest("button.grip");
    if (!g) return;
    const isRow = g.dataset.drag === "row";
    const i = isRow ? +g.dataset.r : +g.dataset.c;
    const d = isRow ? { ArrowUp: -1, ArrowDown: 1 }[e.key] : { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const to = i + d;
    const max = isRow ? model.rows.length : model.header.length;
    if (to < 0 || to >= max) return;
    mutate(() => (isRow ? moveRow(i, to) : moveCol(i, to)),
      (isRow ? "Row moved to " + fmtNum(to + 1) : "Column moved to " + colName(to)) + ".",
      () => scroller.querySelector('button.grip[data-drag="' + (isRow ? "row" : "col") + '"][data-' + (isRow ? "r" : "c") + '="' + to + '"]').focus());
  });

  /* ---------- drag with springs ---------- */
  let drag = null;
  scroller.addEventListener("pointerdown", (e) => {
    const g = e.target.closest("button.grip");
    if (!g || e.button !== 0) return;
    const isRow = g.dataset.drag === "row";
    let from = isRow ? +g.dataset.r : +g.dataset.c;
    let groups, rects, idx;
    if (isRow) {
      // Only rendered rows take part; `idx` maps local positions back to real row numbers.
      const trs = Array.from(scroller.querySelectorAll("tbody tr[data-id]"));
      idx = trs.map((tr) => +tr.dataset.r);
      from = idx.indexOf(from);
      groups = trs.map((tr) => [tr]);
      rects = trs.map((tr) => tr.getBoundingClientRect()).map((r) => ({ pos: r.top, size: r.height }));
    } else {
      idx = colIds.map((_, i) => i);
      groups = colIds.map((cid) => Array.from(scroller.querySelectorAll('[data-cid="' + cid + '"]')));
      rects = Array.from(scroller.querySelectorAll("tr.head th[data-cid]"))
        .map((th) => th.getBoundingClientRect()).map((r) => ({ pos: r.left, size: r.width }));
    }
    if (groups.length < 2 || from < 0) return;
    e.preventDefault();
    try { g.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    drag = { isRow, from, to: from, idx, start: isRow ? e.clientY : e.clientX, groups, rects, grip: g, moved: false };
    const lift = isRow ? groups[from][0].children : groups[from];
    Array.from(lift).forEach((n) => n.classList.add("lifted"));
    scroller.classList.add("dragging");
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { isRow, from, rects, groups } = drag;
    const min = rects[0].pos - rects[from].pos;
    const max = rects[rects.length - 1].pos + rects[rects.length - 1].size - rects[from].pos - rects[from].size;
    const delta = Math.max(min, Math.min(max, (isRow ? e.clientY : e.clientX) - drag.start));
    if (Math.abs(delta) > 2) drag.moved = true;
    const center = rects[from].pos + rects[from].size / 2 + delta;
    let to;
    if (center < rects[from].pos) { to = 0; rects.forEach((r, i) => { if (i < from && center > r.pos + r.size / 2) to = i + 1; }); }
    else { to = from; rects.forEach((r, i) => { if (i > from && center > r.pos + r.size / 2) to = i; }); }
    drag.to = to;
    const size = rects[from].size, axis = isRow ? "y" : "x";
    groups.forEach((grp, i) => {
      let target = 0;
      if (i === from) { grp.forEach((n) => spring(n, axis, delta, delta, true)); return; }
      if (from < to && i > from && i <= to) target = -size;
      if (from > to && i >= to && i < from) target = size;
      grp.forEach((n) => spring(n, axis, null, target));
    });
  });
  function endDrag() {
    if (!drag) return;
    const { isRow, moved, idx } = drag;
    const from = idx[drag.from], to = idx[drag.to];
    drag = null;
    scroller.classList.remove("dragging");
    if (!moved || from === to) {
      const before = measure();
      render();
      flip(before);
      return;
    }
    mutate(() => (isRow ? moveRow(from, to) : moveCol(from, to)),
      (isRow ? "Row moved to " + fmtNum(to + 1) : "Column moved to " + colName(to)) + ".");
  }
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);

  /* ---------- cell editing ---------- */
  scroller.addEventListener("focusin", (e) => {
    const d = e.target.closest(".cell");
    if (!d) return;
    editSession = false;
    active = { r: +d.dataset.r, c: +d.dataset.c };
    markActive(active.r, active.c);
    say(active.r < 0 ? "Header, column " + colName(active.c) : "Row " + (active.r + 1) + ", column " + colName(active.c));
  });
  scroller.addEventListener("input", (e) => {
    const d = e.target.closest(".cell");
    if (!d) return;
    const r = +d.dataset.r, c = +d.dataset.c;
    if (!editSession) { pushHistory({ cell: true, r, c, v: getCell(r, c) }); editSession = true; }
    const v = store(d.textContent);
    setCell(r, c, v);
    growCol(c, v);
    if (model.rows.length < ASYNC_ROWS) writeMarkdown();
    else { clearTimeout(cellTimer); cellTimer = setTimeout(writeMarkdown, 250); updateDims(); }
  });
  let cellTimer = 0;

  function caretEdge(d, end) {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return false;
    const r = s.getRangeAt(0).cloneRange();
    const probe = document.createRange();
    probe.selectNodeContents(d);
    if (end) probe.setStart(r.endContainer, r.endOffset); else probe.setEnd(r.endContainer, r.endOffset);
    return probe.toString().length === 0;
  }

  scroller.addEventListener("keydown", (e) => {
    const d = e.target.closest(".cell");
    if (!d) return;
    const r = +d.dataset.r, c = +d.dataset.c;
    const n = model.header.length, last = model.rows.length - 1;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
    if (e.key === "Escape") { d.blur(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (c > 0) focusCell(r, c - 1, true); else if (r > -1) focusCell(r - 1, n - 1, true);
      } else if (c < n - 1) focusCell(r, c + 1, true);
      else if (r < last) focusCell(r + 1, 0, true);
      else if (model.rows.length < MAX_ROWS) mutate(() => addRow(model.rows.length), "Row added.", () => focusCell(r + 1, 0, true));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) { if (r > -1) focusCell(r - 1, c, true); }
      else if (r < last) focusCell(r + 1, c, true);
      else if (model.rows.length < MAX_ROWS) mutate(() => addRow(model.rows.length), "Row added.", () => focusCell(r + 1, c, true));
      return;
    }
    if (e.key === "ArrowUp" && r > -1) { e.preventDefault(); focusCell(r - 1, c, true); return; }
    if (e.key === "ArrowDown" && r < last) { e.preventDefault(); focusCell(r + 1, c, true); return; }
    if (e.key === "ArrowLeft" && c > 0 && caretEdge(d, false)) { e.preventDefault(); focusCell(r, c - 1, false); return; }
    if (e.key === "ArrowRight" && c < n - 1 && caretEdge(d, true)) { e.preventDefault(); focusCell(r, c + 1, false); }
  });

  /* Paste: plain text only. Multi-cell clipboard (from a spreadsheet) fills the grid. */
  scroller.addEventListener("paste", (e) => {
    const d = e.target.closest(".cell");
    if (!d) return;
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    if (!text) return;
    if (text.length > MAX_CHARS) { say("Paste too large (max 25 MB)."); return; }
    const trimmed = text.replace(/\r?\n$/, "");
    if (/[\t\n]/.test(trimmed)) {
      const grid = T.parseDelimited(trimmed, "\t");
      const r0 = +d.dataset.r, c0 = +d.dataset.c;
      mutate(() => {
        grid.forEach((line, i) => {
          const r = r0 + i;
          while (r >= model.rows.length && addRow(model.rows.length));
          if (r >= model.rows.length) return;
          line.forEach((v, j) => {
            const c = c0 + j;
            while (c >= model.header.length && addCol(model.header.length));
            if (c >= model.header.length) return;
            if (r < 0) model.header[c] = v; else model.rows[r][c] = v;
          });
        });
      }, "Pasted " + grid.length + " × " + Math.max.apply(null, grid.map((l) => l.length)) + " cells.", () => focusCell(r0, c0, false));
      return;
    }
    if (!document.execCommand("insertText", false, trimmed)) {
      const sel = getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(trimmed));
      range.collapse(false);
      d.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  scroller.addEventListener("dragover", (e) => e.preventDefault());
  scroller.addEventListener("drop", (e) => e.preventDefault());

  /* ---------- markdown side ---------- */
  let mdTimer = 0, parseJob = 0;
  function parseText(text, rewrite) {
    const job = ++parseJob;
    if (text.length > MAX_CHARS) { say("Input too large (max 25 MB)."); return; }
    const apply = (t, ms) => {
      model = t;
      freshIds();
      active = null;
      scroller.scrollTop = 0;
      render();
      if (rewrite) writeMarkdown(true); else updateDims();
      if (!model.header.length) say("No table found in the Markdown yet.");
      else if (ms != null) say("Loaded " + fmtNum(model.rows.length) + " rows in " + (ms / 1000).toFixed(1) + " s. Nothing left this tab.");
      else say("Table updated from Markdown.");
    };
    if (text.length < SYNC_PARSE_CHARS) { apply(T.parse(text)); return; }
    const p = new T.Parser(text);
    runSliced(p, () => job === parseJob, () => "Reading " + fmtNum(p.rowsSoFar()) + " rows", (ms) => apply(p.result(), ms));
  }
  md.addEventListener("focus", () => { mdSession = false; });
  md.addEventListener("input", () => {
    if (!mdSession) { pushHistory(); mdSession = true; }
    clearTimeout(mdTimer);
    parseJob++; // cancel a parse that is already running
    mdTimer = setTimeout(() => parseText(md.value, false), md.value.length < SYNC_PARSE_CHARS ? 120 : 200);
  });
  /* Big pastes skip the textarea entirely and go straight to the sliced parser. */
  md.addEventListener("paste", (e) => {
    const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    if (text.length <= LARGE_CHARS && !md.readOnly) return;
    e.preventDefault();
    if (!text) return;
    clearTimeout(mdTimer);
    pushHistory();
    mdFull = null;
    md.readOnly = true;
    md.value = "";
    $("md-large-text").textContent = "Reading " + (text.length / 1048576).toFixed(1) + " MB…";
    $("md-large").hidden = false;
    parseText(text, true);
  });
  md.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $("format").click(); }
  });

  /* ---------- toolbar ---------- */
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("format").addEventListener("click", () => {
    if (!model.header.length) { say("Nothing to format."); return; }
    writeMarkdown(true);
    say("Formatted.");
  });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    style = b.dataset.style;
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    writeMarkdown(true);
    say(style === "compact" ? "Compact output." : "Padded output.");
  }));
  $("align").addEventListener("change", (e) => {
    const v = e.target.value;
    e.target.value = "";
    if (!v || !model.header.length) return;
    mutate(() => { model.align = model.header.map(() => v); }, "All columns aligned " + ALIGN_LABEL[v].toLowerCase() + ".");
  });
  $("transpose").addEventListener("click", () => {
    if (!model.header.length) return;
    if (model.rows.length + 1 > MAX_COLS) { say("Transpose works on tables with up to " + (MAX_COLS - 1) + " rows."); return; }
    mutate(() => { model = T.transpose(model); freshIds(); }, "Transposed.");
  });
  $("new").addEventListener("click", () => newTable(parseInt($("cols").value, 10) || 1, parseInt($("rows").value, 10) || 0));

  /* Copy confirmation: the button itself becomes the receipt, then quietly reverts. */
  const copyBtn = $("copy");
  const copyIdle = Array.from(copyBtn.childNodes).map((n) => n.cloneNode(true));
  let copyTimer = 0;
  function confirmCopy(rows) {
    clearTimeout(copyTimer);
    copyBtn.style.minWidth = copyBtn.offsetWidth + "px";
    copyBtn.textContent = "";
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.classList.add("check");
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
    s.appendChild(p);
    copyBtn.append(s, document.createTextNode(rows ? "Copied " + fmtNum(rows) + (rows === 1 ? " row" : " rows") : "Copied"));
    copyBtn.classList.add("copied");
    copyTimer = setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.textContent = "";
      copyIdle.forEach((n) => copyBtn.appendChild(n.cloneNode(true)));
      copyBtn.style.minWidth = "";
    }, 1800);
  }

  $("copy").addEventListener("click", () => {
    const all = getMarkdown();
    if (!all) { say("Nothing to copy."); return; }
    const done = () => {
      const rows = model.rows.length;
      say("Copied " + (rows ? fmtNum(rows) + " row" + (rows === 1 ? "" : "s") + " of Markdown" : "the Markdown") + " to your clipboard.");
      confirmCopy(rows);
    };
    const fallback = () => { if (mdFull != null) { say("Clipboard unavailable. Use Edit full text, then select all and press Ctrl+C."); return; } md.select(); if (document.execCommand("copy")) done(); else say("Select the Markdown and press Ctrl+C."); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(all).then(done, fallback);
    else fallback();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target === md || e.target.closest(".cell") || /INPUT|SELECT/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
  });

  /* ---------- start ---------- */
  model = T.parse("|System|Owner|Data class|Retention|\n|:-|:-|:-:|-:|\n|Payroll|Finance|Restricted|7 years|\n|CRM|Sales|Confidential|3 years|\n|Wiki|IT|Internal|1 year|\n");
  freshIds();
  render();
  writeMarkdown(true);
  say("Ready. Everything you do here stays in this tab.");
  window.addEventListener("load", checkFiles);
  if (document.readyState === "complete") checkFiles();
})();
