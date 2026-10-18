/**
 * The website under review: "Acme Home", a tiny shop.
 *
 * Every review assignment gets its own session (cookie `review_session`, set by
 * GET /r/:sessionId). The session decides which planted bugs are switched on and
 * records every request the reviewer makes, so the grader can check what the
 * agent actually did instead of trusting what it says it did.
 *
 *   planted bugs   known defects, switched on per session; the reviewer is never told which
 *   visit log      method, path, status and time of every request in the session
 *   goals          signup, add-to-cart, checkout: set by the server when the action happens
 *   checkpoints    codes shown only after signup and after an order; derived from the session
 *
 * Without a session cookie the site runs in "preview" mode with no planted bugs,
 * so a human can click around it normally.
 */
import { createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const CATEGORIES = [
  "broken-link",
  "accessibility",
  "form-validation",
  "wrong-data",
  "server-error",
  "content",
  "performance",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface PlantedBug {
  id: string;
  /** Page key (first path segment) the bug lives on. */
  page: string;
  category: Category;
  description: string;
}

/** The control items. A session switches some of these on; the rest are known to be absent. */
export const BUG_CATALOG: PlantedBug[] = [
  { id: "broken-shipping-link", page: "/", category: "broken-link", description: "The 'Shipping info' link on the home page goes to a page that does not exist" },
  { id: "missing-alt", page: "/products", category: "accessibility", description: "Product images on /products have no alt text" },
  { id: "unlabeled-wishlist", page: "/product", category: "accessibility", description: "The heart-icon wishlist button has no accessible name" },
  { id: "signup-email", page: "/signup", category: "form-validation", description: "Signup accepts an invalid email address" },
  { id: "cart-total", page: "/cart", category: "wrong-data", description: "Cart total ignores item quantity" },
  { id: "coupon-500", page: "/cart", category: "server-error", description: "Applying a coupon returns HTTP 500" },
  { id: "checkout-typo", page: "/checkout", category: "content", description: "Checkout heading is misspelled 'Chekout'" },
  { id: "slow-about", page: "/about", category: "performance", description: "The about page takes well over a second to load" },
];

/** Defects that are always present and not in the catalog. Nobody knows about them; reviewers have to agree on them. */
export const REAL_BUGS = [
  { page: "/about", category: "broken-link" as Category, description: "The 'Careers' link on /about returns 404" },
  { page: "/contact", category: "server-error" as Category, description: "Submitting the contact form returns HTTP 500" },
];

export const GOALS = [
  { id: "signup", description: "Create an account on /signup", checkpoint: true },
  { id: "add-to-cart", description: "Add at least one product to the cart", checkpoint: false },
  { id: "checkout", description: "Place an order through /checkout", checkpoint: true },
] as const;
export type GoalId = (typeof GOALS)[number]["id"];

export const SESSION_COOKIE = "review_session";

export const PRODUCTS = [
  { id: "1", name: "Desk Lamp", price: 34, blurb: "Warm, dimmable, and small enough for any desk." },
  { id: "2", name: "Ceramic Mug", price: 12, blurb: "Holds a generous 350 ml. Dishwasher safe." },
  { id: "3", name: "Wool Throw", price: 58, blurb: "Soft merino blend in oatmeal grey." },
  { id: "4", name: "Notebook Set", price: 9, blurb: "Three dot-grid notebooks, A5." },
];

/** "/product/2?x=1" -> "/product". The grader compares findings to bugs by this key. */
export function pageKey(path: string): string {
  let p = path.trim();
  try {
    p = new URL(p, "http://site.invalid").pathname;
  } catch {
    // keep as is
  }
  const seg = p.split("/").filter(Boolean)[0];
  return seg ? `/${seg}` : "/";
}

export interface Visit {
  method: string;
  path: string;
  status: number;
  ms: number;
  at: number;
  /** True for HTML page responses (not images). */
  page: boolean;
}

export interface ReviewSession {
  id: string;
  activeBugs: Set<string>;
  createdAt: number;
  expiresAt: number;
  visits: Visit[];
  goals: Set<GoalId>;
  cart: Map<string, number>;
}

const MAX_VISITS = 2000;

export class SessionStore {
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly secret: string;
  /** Sessionless visitors share this one: no planted bugs. */
  readonly preview: ReviewSession;

  constructor(secret: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.secret = secret;
    this.preview = this.blank("preview", [], Number.MAX_SAFE_INTEGER);
  }

  create(bugIds: string[], ttl: number): ReviewSession {
    const s = this.blank(`s_${randomBytes(9).toString("base64url")}`, bugIds, this.now() + ttl);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): ReviewSession | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s || s.expiresAt <= this.now()) return undefined;
    return s;
  }

  /** The code a page shows after `goal` is done. Unguessable without doing it. */
  checkpoint(s: ReviewSession, goal: GoalId): string {
    const prefix = goal === "signup" ? "M" : "O";
    return `${prefix}-${this.mac(`${s.id}:${goal}`).slice(0, 8).toUpperCase()}`;
  }

  /** The broken shipping link's href differs per session, so it cannot be guessed. */
  brokenHref(s: ReviewSession): string {
    return `/shipping-${this.mac(`${s.id}:href`).slice(0, 6).toLowerCase()}`;
  }

  /** Distinct page keys the session loaded as HTML. */
  pagesVisited(s: ReviewSession): string[] {
    return [...new Set(s.visits.filter((v) => v.page).map((v) => pageKey(v.path)))];
  }

  private mac(msg: string): string {
    return createHmac("sha256", this.secret).update(msg).digest("base64url").replace(/[-_]/g, "x");
  }

  private blank(id: string, bugIds: string[], expiresAt: number): ReviewSession {
    return { id, activeBugs: new Set(bugIds), createdAt: this.now(), expiresAt, visits: [], goals: new Set(), cart: new Map() };
  }
}

export interface SiteOptions {
  sessions: SessionStore;
  /** Delay of the planted slow page, in ms. Default 1500. */
  slowMs?: number;
}

type Env = { Variables: { session: ReviewSession } };

const money = (n: number) => `$${n.toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Acme Home</title>
<style>
  :root { --bg:#fbfaf7; --ink:#1f2328; --ink-2:#59636e; --line:#e4e1da; --accent:#b4532a; --panel:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --ink:#e8e6e3; --ink-2:#a0a7b0; --line:#2c3038; --accent:#f0a07a; --panel:#1b1e23; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, sans-serif; }
  header, main, footer { max-width: 880px; margin: 0 auto; padding: 16px; }
  header { display:flex; flex-wrap:wrap; gap:16px; align-items:center; border-bottom:1px solid var(--line); }
  header strong { margin-right:auto; font-size:20px; }
  nav { display:flex; flex-wrap:wrap; gap:14px; }
  a { color: var(--accent); }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  table { width:100%; border-collapse:collapse; }
  td, th { text-align:left; padding:8px; border-bottom:1px solid var(--line); }
  form { display:grid; gap:10px; max-width:420px; }
  input, textarea, select { font:inherit; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--ink); }
  button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.icon { background:transparent; color:var(--accent); font-size:20px; }
  .error { color:#c0392b; }
  footer { color: var(--ink-2); border-top:1px solid var(--line); margin-top:32px; }
</style>
</head>
<body>
<header>
  <strong>Acme Home</strong>
  <nav>
    <a href="/">Home</a>
    <a href="/products">Products</a>
    <a href="/cart">Cart</a>
    <a href="/signup">Sign up</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
</header>
<main>
${body}
</main>
<footer><a href="/privacy">Privacy</a> · © Acme Home</footer>
</body>
</html>`;
}

function productImage(id: string): string {
  const hue = (Number(id) * 77) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="hsl(${hue} 45% 70%)"/><circle cx="120" cy="80" r="40" fill="hsl(${hue} 45% 45%)"/></svg>`;
}

export function createSite(opts: SiteOptions): Hono<Env> {
  const { sessions } = opts;
  const slowMs = opts.slowMs ?? 1500;
  const site = new Hono<Env>();
  const on = (s: ReviewSession, bug: string) => s.activeBugs.has(bug);

  // -- session + visit log ---------------------------------------------------
  site.use("*", async (c, next) => {
    const s = sessions.get(getCookie(c, SESSION_COOKIE)) ?? sessions.preview;
    c.set("session", s);
    const start = performance.now();
    await next();
    if (s.visits.length < MAX_VISITS) {
      s.visits.push({
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
        at: Math.floor(Date.now() / 1000),
        page: (c.res.headers.get("content-type") ?? "").includes("text/html"),
      });
    }
  });

  site.get("/r/:sessionId", (c) => {
    const s = sessions.get(c.req.param("sessionId"));
    if (!s) return c.html(layout("Session expired", `<h1>Review session not found</h1><p>It may have expired. Ask for a new assignment.</p>`), 404);
    setCookie(c, SESSION_COOKIE, s.id, { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.redirect("/", 302);
  });

  // -- pages ------------------------------------------------------------------
  site.get("/", (c) => {
    const s = c.get("session");
    const shipping = on(s, "broken-shipping-link") ? sessions.brokenHref(s) : "/shipping";
    const cards = PRODUCTS.slice(0, 3)
      .map((p) => `<div class="card"><h3><a href="/product/${p.id}">${esc(p.name)}</a></h3><p>${money(p.price)}</p></div>`)
      .join("");
    return c.html(
      layout(
        "Home",
        `<h1>Simple things for a calm home</h1>
<p>Hand-picked lamps, mugs and throws. Free returns for 30 days.</p>
<div class="grid">${cards}</div>
<h2>Why shop with us</h2>
<p>We ship within two working days. <a href="${shipping}">Shipping info</a></p>
<p><a href="/products">Browse all products</a></p>`,
      ),
    );
  });

  site.get("/products", (c) => {
    const s = c.get("session");
    const noAlt = on(s, "missing-alt");
    const cards = PRODUCTS.map(
      (p) => `<div class="card">
  <img src="/img/${p.id}.svg" ${noAlt ? "" : `alt="${esc(p.name)}" `}width="240" height="160" style="max-width:100%;height:auto">
  <h3><a href="/product/${p.id}">${esc(p.name)}</a></h3>
  <p>${money(p.price)}</p>
</div>`,
    ).join("");
    return c.html(layout("Products", `<h1>All products</h1><div class="grid">${cards}</div>`));
  });

  site.get("/product/:id", (c) => {
    const s = c.get("session");
    const p = PRODUCTS.find((x) => x.id === c.req.param("id"));
    if (!p) return c.html(layout("Not found", `<h1>Product not found</h1>`), 404);
    const wishAttr = on(s, "unlabeled-wishlist") ? "" : ` aria-label="Add to wishlist"`;
    return c.html(
      layout(
        p.name,
        `<h1>${esc(p.name)}</h1>
<img src="/img/${p.id}.svg" alt="${esc(p.name)}" width="240" height="160">
<p>${esc(p.blurb)}</p>
<p><strong>${money(p.price)}</strong></p>
<form method="post" action="/cart/add">
  <input type="hidden" name="id" value="${p.id}">
  <label for="qty">Quantity</label>
  <input id="qty" name="qty" type="number" min="1" max="10" value="1">
  <button type="submit">Add to cart</button>
</form>
<p><button type="button" class="icon"${wishAttr}>♡</button></p>
<p><a href="/products">Back to products</a></p>`,
      ),
    );
  });

  site.post("/cart/add", async (c) => {
    const s = c.get("session");
    const body = await c.req.parseBody();
    const id = String(body.id ?? "");
    const qty = Math.max(1, Math.min(10, Number.parseInt(String(body.qty ?? "1"), 10) || 1));
    if (!PRODUCTS.some((p) => p.id === id)) return c.html(layout("Not found", `<h1>Product not found</h1>`), 404);
    s.cart.set(id, (s.cart.get(id) ?? 0) + qty);
    s.goals.add("add-to-cart");
    return c.redirect("/cart", 303);
  });

  function cartPage(s: ReviewSession, message = ""): string {
    const rows = [...s.cart].map(([id, qty]) => {
      const p = PRODUCTS.find((x) => x.id === id)!;
      return `<tr><td>${esc(p.name)}</td><td class="price">${money(p.price)}</td><td class="qty">${qty}</td><td class="line">${money(p.price * qty)}</td></tr>`;
    });
    const total = [...s.cart].reduce((sum, [id, qty]) => {
      const price = PRODUCTS.find((x) => x.id === id)!.price;
      return sum + (on(s, "cart-total") ? price : price * qty);
    }, 0);
    const table = rows.length
      ? `<table><thead><tr><th>Item</th><th>Price</th><th>Qty</th><th>Line total</th></tr></thead><tbody>${rows.join("")}</tbody></table>
<p>Total: <strong id="total">${money(total)}</strong></p>
<p><a href="/checkout">Proceed to checkout</a></p>`
      : `<p>Your cart is empty. <a href="/products">Browse products</a></p>`;
    return layout(
      "Cart",
      `<h1>Your cart</h1>${message ? `<p class="error">${esc(message)}</p>` : ""}${table}
<h2>Have a coupon?</h2>
<form method="post" action="/cart/coupon">
  <label for="code">Coupon code</label>
  <input id="code" name="code" type="text">
  <button type="submit">Apply coupon</button>
</form>`,
    );
  }

  site.get("/cart", (c) => c.html(cartPage(c.get("session"))));

  site.post("/cart/coupon", async (c) => {
    const s = c.get("session");
    if (on(s, "coupon-500")) return c.html(layout("Error", `<h1>500 Internal Server Error</h1>`), 500);
    return c.html(cartPage(s, "That coupon code is not recognised."));
  });

  site.get("/checkout", (c) => {
    const s = c.get("session");
    const heading = on(s, "checkout-typo") ? "Chekout" : "Checkout";
    const empty = s.cart.size === 0 ? `<p>Your cart is empty, so there is nothing to order yet.</p>` : "";
    return c.html(
      layout(
        "Checkout",
        `<h1>${heading}</h1>${empty}
<form method="post" action="/checkout">
  <label for="name">Full name</label>
  <input id="name" name="name" type="text" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <button type="submit">Place order</button>
</form>`,
      ),
    );
  });

  site.post("/checkout", async (c) => {
    const s = c.get("session");
    const body = await c.req.parseBody();
    if (s.cart.size === 0) return c.html(layout("Checkout", `<h1>Checkout</h1><p class="error">Your cart is empty.</p>`), 400);
    if (!String(body.name ?? "").trim() || !EMAIL_RE.test(String(body.email ?? ""))) {
      return c.html(layout("Checkout", `<h1>Checkout</h1><p class="error">Please enter your name and a valid email.</p>`), 400);
    }
    s.cart.clear();
    s.goals.add("checkout");
    return c.html(layout("Order placed", `<h1>Thank you!</h1><p>Order number: <strong id="order-code">${sessions.checkpoint(s, "checkout")}</strong></p>`));
  });

  site.get("/signup", (c) =>
    c.html(
      layout(
        "Sign up",
        `<h1>Create an account</h1>
<form method="post" action="/signup">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <label for="password">Password (8+ characters)</label>
  <input id="password" name="password" type="password">
  <button type="submit">Sign up</button>
</form>`,
      ),
    ),
  );

  site.post("/signup", async (c) => {
    const s = c.get("session");
    const body = await c.req.parseBody();
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    if (!on(s, "signup-email") && !EMAIL_RE.test(email)) {
      return c.html(layout("Sign up", `<h1>Create an account</h1><p class="error">Please enter a valid email address.</p>`), 400);
    }
    if (password.length < 8) {
      return c.html(layout("Sign up", `<h1>Create an account</h1><p class="error">Password must be at least 8 characters.</p>`), 400);
    }
    s.goals.add("signup");
    return c.html(layout("Welcome", `<h1>Welcome aboard</h1><p>Your member code: <strong id="member-code">${sessions.checkpoint(s, "signup")}</strong></p>`));
  });

  site.get("/about", async (c) => {
    if (on(c.get("session"), "slow-about")) await sleep(slowMs);
    return c.html(
      layout(
        "About",
        `<h1>About Acme Home</h1>
<p>We are a small team that likes well-made, quiet things.</p>
<p>Want to work with us? See <a href="/careers">Careers</a>.</p>`,
      ),
    );
  });

  site.get("/contact", (c) =>
    c.html(
      layout(
        "Contact",
        `<h1>Contact us</h1>
<form method="post" action="/contact">
  <label for="message">Message</label>
  <textarea id="message" name="message"></textarea>
  <button type="submit">Send</button>
</form>`,
      ),
    ),
  );

  site.post("/contact", (c) => c.html(layout("Error", `<h1>500 Internal Server Error</h1>`), 500));

  site.get("/shipping", (c) => c.html(layout("Shipping", `<h1>Shipping</h1><p>Orders ship within two working days.</p>`)));
  site.get("/privacy", (c) => c.html(layout("Privacy", `<h1>Privacy</h1><p>We only keep what we need to ship your order.</p>`)));

  site.get("/img/:file", (c) => {
    const id = c.req.param("file").replace(/\.svg$/, "");
    if (!PRODUCTS.some((p) => p.id === id)) return c.notFound();
    return c.body(productImage(id), 200, { "Content-Type": "image/svg+xml" });
  });

  site.all("*", (c) => c.html(layout("Not found", `<h1>Page not found</h1><p><a href="/">Go home</a></p>`), 404));

  return site;
}
