// Optional zero-dependency static server. Binds to 127.0.0.1 only.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const ALLOW = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/css/style.css", "css/style.css"],
  ["/js/core.js", "js/core.js"],
  ["/js/app.js", "js/app.js"],
]);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
  "Cache-Control": "no-store",
};

http.createServer((req, res) => {
  const file = req.method === "GET" ? ALLOW.get(new URL(req.url, "http://x").pathname) : undefined;
  if (!file) { res.writeHead(404, HEADERS).end("Not found"); return; }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(500, HEADERS).end(); return; }
    res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[path.extname(file)] }).end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}`));
