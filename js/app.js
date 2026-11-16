/* UI wiring. Uses textContent/value only; never innerHTML, eval, storage or network. */
(function () {
  "use strict";
  var T = window.MdTable;
  var $ = function (id) { return document.getElementById(id); };
  var input = $("input"), output = $("output"), status = $("status"), align = $("align");
  var MAX_CHARS = 2000000;

  function say(msg) { status.textContent = msg; }

  function current() {
    if (input.value.length > MAX_CHARS) throw new Error("Input too large (max 2 MB).");
    var t = T.parse(input.value);
    if (align.value !== "keep") t = T.setAlign(t, align.value);
    return t;
  }

  function run(fn) {
    try {
      var t = current();
      if (!t.header.length) { output.value = ""; say("Nothing to format."); return; }
      output.value = fn(t);
      say(t.header.length + " columns, " + t.rows.length + " rows.");
    } catch (e) { say(e.message); }
  }

  $("format").addEventListener("click", function () { run(function (t) { return T.format(t); }); });
  $("compact").addEventListener("click", function () { run(function (t) { return T.format(t, { compact: true }); }); });
  $("transpose").addEventListener("click", function () { run(function (t) { return T.format(T.transpose(t)); }); });
  align.addEventListener("change", function () { if (input.value.trim()) run(function (t) { return T.format(t); }); });

  $("new").addEventListener("click", function () {
    var md = T.format(T.blank(parseInt($("cols").value, 10) || 1, parseInt($("rows").value, 10) || 0));
    input.value = md;
    output.value = md;
    say("New table created.");
  });

  $("swap").addEventListener("click", function () { input.value = output.value; say("Output moved to input."); });

  $("copy").addEventListener("click", function () {
    if (!output.value) return;
    output.select();
    var p = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(output.value)
      : Promise.reject(new Error("unavailable"));
    p.then(function () { say("Copied."); }, function () {
      say(document.execCommand && document.execCommand("copy") ? "Copied." : "Select the output and press Ctrl+C.");
    });
  });

  input.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $("format").click(); }
  });

  input.value = "|Name|Role|Score|\n|:-|-|-:|\n|Ada|Engineer|98|\n|Grace Hopper|Admiral|100|\n";
  $("format").click();
})();
