// Serves the landing page and stores early-access signups in data/early-access.jsonl.
// Zero dependencies. Run: node landing/server.js  (env: PORT, default 8402)
import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8402;
const HOME_PAGE = "d402 Landing v5.dc.html";
const DATA_DIR = path.join(ROOT, "data");
const SIGNUPS = path.join(DATA_DIR, "early-access.jsonl");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
};

// Load existing signups so repeat submissions aren't stored twice.
const seen = new Set(
  existsSync(SIGNUPS)
    ? readFileSync(SIGNUPS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).email)
    : []
);

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleSignup(req, res) {
  let email;
  try {
    email = String(JSON.parse(await readBody(req)).email ?? "").trim().toLowerCase();
  } catch {
    return json(res, 400, { error: "Invalid request." });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return json(res, 400, { error: "Enter a valid email address." });
  }
  if (!seen.has(email)) {
    seen.add(email);
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(SIGNUPS, JSON.stringify({ email, signedUpAt: new Date().toISOString() }) + "\n");
    console.log(`early access signup: ${email} (${seen.size} total)`);
  }
  json(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const rel = urlPath === "/" ? HOME_PAGE : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  // Stay inside the landing folder and never serve stored signups or this server's source.
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR) || rel === "server.js") {
    return json(res, 404, { error: "not found" });
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/early-access") return handleSignup(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "method not allowed" });
  })
  .listen(PORT, () => {
    console.log(`d402 landing on http://localhost:${PORT}  (signups -> ${path.relative(process.cwd(), SIGNUPS)})`);
  });
