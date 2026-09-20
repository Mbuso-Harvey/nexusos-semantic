// Synthetic SaaS demo — tiny static file server.
// Pure Node, no deps. Listens on PORT (default 7311).
// Resolves `/foo` to `/foo.html` if the bare path is missing.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

const PORT = Number(process.env.PORT || 7311);
const ROOT = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url || "/");
  let p = decodeURIComponent(u.pathname || "/");
  if (p.endsWith("/")) p += "index.html";

  // Resolve to a real file inside ROOT only.
  const candidate = path.normalize(path.join(ROOT, p));
  if (!candidate.startsWith(ROOT)) {
    return send(res, 403, "forbidden");
  }

  // Try the literal path first; if 404, try `<path>.html`.
  fs.stat(candidate, (err, stat) => {
    if (err || !stat.isFile()) {
      const html = candidate + ".html";
      fs.stat(html, (err2, stat2) => {
        if (err2 || !stat2.isFile()) {
          return send(res, 404, "not found");
        }
        serveFile(html, res);
      });
      return;
    }
    serveFile(candidate, res);
  });

  function serveFile(file, res) {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 500, "read error");
      const ext = path.extname(file).toLowerCase();
      send(res, 200, data, MIME[ext] || "application/octet-stream");
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`awg-demo: http://127.0.0.1:${PORT}`);
});
