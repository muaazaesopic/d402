/**
 * Demo agents for the marketplace, plus the earn-then-spend flow (any job).
 *
 *   honestReviewer   really browses: crawls every link, submits every form, completes
 *                    the goals, and reports what it saw. Its checks are simple heuristics
 *                    (status codes, timings, missing alt/aria-label, a typo list, cart
 *                    arithmetic). A real agent would be an LLM driving a browser and
 *                    returning the same report shape; the grading does not care which.
 *   lazyReviewer     never opens the site and returns a generic "looks great" report.
 *   fakerReviewer    opens the home page only and invents plausible findings and codes.
 *   honestWorker     answers classify and extract jobs (keyword and line-prefix rules stand in for an LLM).
 *   randomWorker     answers them at random without reading.
 */
import { HEADERS, generateKeypair, type Keypair } from "@d402/spec";
import type { Assignment, Finding, ReportInput } from "./review.js";
import { signResult } from "./market.js";
import { pageKey, type Category } from "./site.js";

export type Log = (line: string) => void;

export interface ReviewContext {
  fetch: typeof fetch;
  log: Log;
  /** Pages slower than this are reported. Default 1000 ms. */
  slowThresholdMs?: number;
}

export type Reviewer = (assignment: Assignment, ctx: ReviewContext) => Promise<ReportInput>;

// ---------------------------------------------------------------------------
// A tiny browser: cookies, redirects, timing
// ---------------------------------------------------------------------------

export interface PageResult {
  status: number;
  html: string;
  ms: number;
  path: string;
}

export class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly origin: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  get(path: string): Promise<PageResult> {
    return this.request("GET", path);
  }

  post(path: string, form: Record<string, string>): Promise<PageResult> {
    return this.request("POST", path, form);
  }

  private async request(method: string, path: string, form?: Record<string, string>): Promise<PageResult> {
    let url = new URL(path, this.origin);
    const start = performance.now();
    for (let hop = 0; hop < 5; hop++) {
      const headers = new Headers();
      if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      let body: string | undefined;
      if (form) {
        headers.set("content-type", "application/x-www-form-urlencoded");
        body = new URLSearchParams(form).toString();
      }
      const res = await this.fetchFn(url.toString(), { method, headers, body, redirect: "manual" });
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(";");
        const eq = pair!.indexOf("=");
        if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        method = "GET";
        form = undefined;
        continue;
      }
      return { status: res.status, html: await res.text(), ms: performance.now() - start, path: url.pathname + url.search };
    }
    throw new Error(`too many redirects from ${path}`);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers (regex is enough for this site)
// ---------------------------------------------------------------------------

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1];
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function links(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => m[1]!);
}

interface FormInfo {
  action: string;
  method: string;
  fields: Array<{ name: string; type: string; value: string }>;
}

function forms(html: string): FormInfo[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
    action: attr(m[1]!, "action") ?? "",
    method: (attr(m[1]!, "method") ?? "get").toLowerCase(),
    fields: [...m[2]!.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
      .map((f) => ({ name: attr(f[2]!, "name") ?? "", type: (attr(f[2]!, "type") ?? f[1]!).toLowerCase(), value: attr(f[2]!, "value") ?? "" }))
      .filter((f) => f.name),
  }));
}

function sampleValue(f: FormInfo["fields"][number]): string {
  if (f.type === "hidden") return f.value;
  if (f.type === "email") return "reviewer@example.com";
  if (f.type === "password") return "correct-horse-9";
  if (f.type === "number") return "2";
  return "Testing the form";
}

/** A short list of common misspellings. An LLM reviewer would just read the page. */
const COMMON_TYPOS: Record<string, string> = {
  chekout: "checkout",
  adress: "address",
  recieve: "receive",
  seperate: "separate",
  sucess: "success",
  definately: "definitely",
  occured: "occurred",
  accomodate: "accommodate",
};

const FIXES: Record<Category, string> = {
  "broken-link": "Point the link at an existing page or remove it.",
  accessibility: "Add the missing text alternative (alt on images, aria-label on icon buttons).",
  "form-validation": "Validate the field on the server and show an inline error.",
  "wrong-data": "Recompute the value from its parts and add a test for it.",
  "server-error": "Check the server logs for this endpoint and handle the error.",
  content: "Correct the copy.",
  performance: "Profile the page and remove the slow call or cache it.",
  other: "Investigate.",
};

// ---------------------------------------------------------------------------
// The honest reviewer
// ---------------------------------------------------------------------------

const SKIP_PREFIXES = ["/r/", "/api", "/.well-known", "/admin", "/dashboard"];

export const honestReviewer: Reviewer = async (assignment, ctx) => {
  const { log } = ctx;
  const slowMs = ctx.slowThresholdMs ?? 1000;
  const site = new URL(assignment.siteUrl);
  const b = new Browser(site.origin, ctx.fetch);
  const findings: Finding[] = [];
  const checkpoints: Record<string, string> = {};

  const add = (f: Omit<Finding, "fix"> & { fix?: string }) => {
    const dup = findings.some(
      (x) => pageKey(x.page) === pageKey(f.page) && x.category === f.category && (f.category !== "broken-link" || x.evidence === f.evidence),
    );
    if (!dup) findings.push({ ...f, fix: f.fix ?? FIXES[f.category] });
  };

  // 1. Start the session.
  await b.get(assignment.siteUrl);

  // 2. Crawl every same-site link once, checking each page.
  const seen = new Set<string>(["/"]);
  const queue: Array<{ path: string; from: string | null }> = [{ path: "/", from: null }];
  const formsByPage: Array<{ page: string; form: FormInfo }> = [];
  const crawl = async () => {
    while (queue.length && seen.size <= 40) {
      const { path, from } = queue.shift()!;
      const r = await b.get(path);
      if (r.status >= 400) {
        if (from) {
          add({
            page: from,
            category: "broken-link",
            title: `Link to ${path} is broken`,
            steps: [`Open ${from}`, `Click the link to ${path}`],
            expected: "The linked page loads",
            actual: `HTTP ${r.status}`,
            severity: "medium",
            evidence: `${path} -> HTTP ${r.status}`,
          });
        }
        continue;
      }
      if (r.ms > slowMs) {
        add({
          page: path,
          category: "performance",
          title: `${path} is slow to load`,
          steps: [`Open ${path}`],
          expected: `Loads in under ${slowMs} ms`,
          actual: `Took ${Math.round(r.ms)} ms`,
          severity: "medium",
          evidence: `${Math.round(r.ms)} ms`,
        });
      }
      const noAlt = r.html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? [];
      if (noAlt.length) {
        add({
          page: path,
          category: "accessibility",
          title: `${noAlt.length} image(s) on ${path} have no alt text`,
          steps: [`Open ${path}`, "Inspect the images"],
          expected: "Every image has alt text",
          actual: `${noAlt.length} <img> without alt`,
          severity: "medium",
          evidence: noAlt[0]!,
        });
      }
      for (const m of r.html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
        if (!/aria-label=/i.test(m[1]!) && !/[a-z0-9]/i.test(text(m[2]!))) {
          add({
            page: path,
            category: "accessibility",
            title: `Icon button on ${path} has no accessible name`,
            steps: [`Open ${path}`, "Inspect the icon-only button"],
            expected: "Buttons have visible text or an aria-label",
            actual: "No text and no aria-label",
            severity: "medium",
            evidence: m[0]!,
          });
        }
      }
      for (const word of text(r.html).toLowerCase().match(/[a-z]+/g) ?? []) {
        if (COMMON_TYPOS[word]) {
          add({
            page: path,
            category: "content",
            title: `Typo on ${path}: "${word}"`,
            steps: [`Open ${path}`],
            expected: `"${COMMON_TYPOS[word]}"`,
            actual: `"${word}"`,
            severity: "low",
            evidence: `text contains "${word}"`,
          });
        }
      }
      for (const form of forms(r.html)) formsByPage.push({ page: path, form });
      for (const href of links(r.html)) {
        if (!href.startsWith("/") || href.startsWith("//")) continue;
        const next = new URL(href, site.origin).pathname;
        if (SKIP_PREFIXES.some((p) => next.startsWith(p)) || seen.has(next)) continue;
        seen.add(next);
        queue.push({ path: next, from: path });
      }
    }
  };
  await crawl();
  log(`crawled ${seen.size} page(s), ${formsByPage.length} form(s)`);

  // 3. Submit every ordinary form once (add to cart, coupon, contact...).
  const special = new Set(["/signup", "/checkout"]);
  const tried = new Set<string>();
  for (const { page, form } of formsByPage) {
    if (form.method !== "post" || special.has(form.action)) continue;
    const values = Object.fromEntries(form.fields.map((f) => [f.name, sampleValue(f)]));
    const sig = `${form.action}:${JSON.stringify(values)}`;
    if (tried.has(sig)) continue;
    tried.add(sig);
    const r = await b.post(form.action, values);
    if (r.status >= 500) {
      add({
        page,
        category: "server-error",
        title: `Submitting the form on ${pageKey(page)} fails`,
        steps: [`Open ${page}`, `Fill in the form (${Object.keys(values).join(", ")})`, "Submit"],
        expected: "A confirmation or a validation message",
        actual: `HTTP ${r.status} from POST ${form.action}`,
        severity: "high",
        evidence: `POST ${form.action} -> HTTP ${r.status}`,
      });
    }
  }

  // The cart now has items, so it links to pages an empty cart hides (checkout). Look again.
  queue.push({ path: "/cart", from: null });
  await crawl();

  // 4. Check the cart arithmetic.
  const cart = await b.get("/cart");
  const lines = [...cart.html.matchAll(/class="price">\$([\d.]+)<\/td><td class="qty">(\d+)</g)].map((m) => Number(m[1]) * Number(m[2]));
  const shown = /id="total">\$([\d.]+)</.exec(cart.html);
  if (lines.length && shown) {
    const expected = lines.reduce((a, c) => a + c, 0);
    if (Math.abs(expected - Number(shown[1])) > 0.005) {
      add({
        page: "/cart",
        category: "wrong-data",
        title: "Cart total does not match the line items",
        steps: ["Add a product with quantity 2", "Open /cart"],
        expected: `$${expected.toFixed(2)}`,
        actual: `$${shown[1]}`,
        severity: "high",
        evidence: `line totals sum to $${expected.toFixed(2)}, total shows $${shown[1]}`,
      });
    }
  }

  // 5. Goal: sign up. Try an invalid email first.
  const bad = await b.post("/signup", { email: "not-an-email", password: "correct-horse-9" });
  if (bad.status < 400) {
    add({
      page: "/signup",
      category: "form-validation",
      title: "Signup accepts an invalid email address",
      steps: ["Open /signup", 'Enter "not-an-email" as the email', "Submit"],
      expected: "An error asking for a valid email",
      actual: `HTTP ${bad.status}, account created`,
      severity: "high",
      evidence: 'email "not-an-email" accepted',
    });
  }
  const signup = await b.post("/signup", { email: `reviewer+${Date.now()}@example.com`, password: "correct-horse-9" });
  const member = /id="member-code">([^<]+)</.exec(signup.html)?.[1];
  if (member) checkpoints.signup = member;

  // 6. Goal: place an order (the cart was filled by the product forms in step 3).
  const order = await b.post("/checkout", { name: "Riley Reviewer", email: "reviewer@example.com" });
  const orderCode = /id="order-code">([^<]+)</.exec(order.html)?.[1];
  if (orderCode) checkpoints.checkout = orderCode;
  log(`goals: signup ${member ? "done" : "FAILED"}, checkout ${orderCode ? "done" : "FAILED"}`);

  // 7. Usability verdict.
  const penalty = findings.reduce((p, f) => p + (f.severity === "high" ? 1 : f.severity === "medium" ? 0.5 : 0.25), 0);
  const score = Math.max(1, Math.min(5, Math.round(5 - penalty)));
  const high = findings.filter((f) => f.severity === "high").length;
  return {
    findings,
    checkpoints,
    usability: {
      score,
      summary:
        `Visited ${seen.size} pages and completed signup, add-to-cart and checkout. Navigation is simple and every page is one click from the header. ` +
        `Found ${findings.length} issue(s), ${high} of them high severity.`,
      suggestions: [...new Set(findings.map((f) => `${pageKey(f.page)}: ${f.fix}`))],
    },
  };
};

// ---------------------------------------------------------------------------
// Cheaters
// ---------------------------------------------------------------------------

export const lazyReviewer: Reviewer = async (_assignment, ctx) => {
  ctx.log("does not open the site; writes a generic review");
  return {
    findings: [],
    checkpoints: {},
    usability: { score: 4, summary: "Clean, modern design. Easy to navigate. No major issues found.", suggestions: ["Add more products."] },
  };
};

export const fakerReviewer: Reviewer = async (assignment, ctx) => {
  const b = new Browser(new URL(assignment.siteUrl).origin, ctx.fetch);
  await b.get(assignment.siteUrl);
  ctx.log("opens the home page only, then invents findings and checkpoint codes");
  const guess = (page: string, category: Category, title: string, evidence = ""): Finding => ({
    page,
    category,
    title,
    steps: [`Open ${page}`],
    expected: "It works",
    actual: "It does not",
    severity: "medium",
    evidence,
    fix: FIXES[category],
  });
  return {
    findings: [
      guess("/", "broken-link", "Shipping link is broken", "/shipping"),
      guess("/products", "accessibility", "Images have no alt text"),
      guess("/signup", "form-validation", "Email is not validated"),
      guess("/cart", "wrong-data", "Total looks wrong"),
      guess("/checkout", "content", "Typo in heading"),
      guess("/about", "performance", "Page is slow"),
      guess("/faq", "broken-link", "FAQ link is dead", "/faq"),
    ],
    checkpoints: { signup: "M-12345678", checkout: "O-ABCDEF12" },
    usability: { score: 3, summary: "Some rough edges across the site.", suggestions: ["Fix the bugs listed."] },
  };
};

// ---------------------------------------------------------------------------
// Dataset workers (classify and extract jobs)
// ---------------------------------------------------------------------------

export interface DatasetTask {
  assignmentId: string;
  type: string;
  tier: string;
  instructions: string;
  labels?: string[];
  fields?: Array<{ name: string; description: string }>;
  items: Array<{ id: string; text: string }>;
}

/** Answers a task and returns the result to sign. */
export type Worker = (task: DatasetTask) => unknown;

/** Keywords per label. Stands in for an LLM reading the item; the grading does not care which. */
const LABEL_HINTS: Record<string, RegExp> = {
  positive: /\b(love|great|excellent|perfect|recommend)\b/i,
  negative: /\b(broke|terrible|disappointed|refund|cheap|damaged)\b/i,
  billing: /\b(charged|invoice|refund|charge)\b/i,
  shipping: /\b(package|tracking|delivery|arrived)\b/i,
  bug: /\b(error|crash|crashes|button)\b/i,
  account: /\b(password|log in|email|account)\b/i,
};

/** Line prefixes per field. */
const FIELD_HINTS: Record<string, RegExp> = {
  vendor: /^(?:From|Vendor):\s*(.+)$/im,
  invoice_number: /^Invoice #:\s*(\S+)/im,
  total: /^Total(?: due)?:\s*\$?([\d,.]+)/im,
};

export const honestWorker: Worker = (task) => {
  if (task.type === "classify") {
    const labels = task.labels ?? [];
    return Object.fromEntries(task.items.map((it) => [it.id, labels.find((l) => LABEL_HINTS[l]?.test(it.text)) ?? labels[0]!]));
  }
  return Object.fromEntries(
    task.items.map((it) => [it.id, Object.fromEntries((task.fields ?? []).map((f) => [f.name, FIELD_HINTS[f.name]?.exec(it.text)?.[1]?.replace(/,/g, "") ?? ""]))]),
  );
};

/** Spends no inference: random labels, empty fields. */
export const randomWorker: Worker = (task) =>
  Object.fromEntries(
    task.items.map((it) => [
      it.id,
      task.type === "classify" ? task.labels![Math.floor(Math.random() * task.labels!.length)]! : Object.fromEntries((task.fields ?? []).map((f) => [f.name, "unknown"])),
    ]),
  );

// ---------------------------------------------------------------------------
// Earn a voucher with any job, then spend it
// ---------------------------------------------------------------------------

export interface EarnResult {
  /** Final status of the API call. */
  status: number;
  callsRemaining: string | null;
  outcome: "passed" | "rejected" | "blocked" | "error";
  detail?: string;
}

/** The whole flow for one job: 402, take a task, do it, sign, submit, spend. */
export async function earnAndCall(opts: {
  apiUrl: string;
  /** Job id (offer tier). */
  job: string;
  keypair?: Keypair;
  model: string;
  /** Does the task and returns the result to sign. */
  work: (task: Record<string, unknown>, log: Log) => Promise<unknown> | unknown;
  fetch?: typeof fetch;
  log?: Log;
}): Promise<EarnResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const keypair = opts.keypair ?? generateKeypair();

  const first = await f(opts.apiUrl);
  log(`1. GET ${new URL(opts.apiUrl).pathname} -> ${first.status}${first.status === 402 ? " (payment required: d402 offer)" : ""}`);
  if (first.status !== 402) return { status: first.status, callsRemaining: first.headers.get(HEADERS.callsRemaining), outcome: "error" };
  const offer = (await first.json()) as { accepts: Array<{ scheme: string; taskUrl: string; tiers: Array<{ id: string; reward: { calls: number } }> }> };
  const accept = offer.accepts.find((a) => a.scheme === "d402")!;
  if (!accept.tiers.some((t) => t.id === opts.job)) return { status: 402, callsRemaining: null, outcome: "error", detail: `no job "${opts.job}" on offer` };

  const taskHeaders = { [HEADERS.key]: keypair.publicKey, [HEADERS.model]: opts.model };
  const ar = await f(`${accept.taskUrl}?tier=${opts.job}`, { headers: taskHeaders });
  if (ar.status !== 200) {
    const err = (await ar.json()) as { error: string; message: string };
    log(`2. GET task -> ${ar.status} ${err.error}: ${err.message}`);
    return { status: ar.status, callsRemaining: null, outcome: err.error === "blocked" ? "blocked" : "error", detail: err.message };
  }
  const task = (await ar.json()) as Record<string, unknown> & { assignmentId: string; type: string };
  log(`2. GET task -> ${task.type} assignment ${task.assignmentId}`);

  log(`3. working...`);
  const result = await opts.work(task, (l) => log(`   ${l}`));
  const sig = signResult(keypair.privateKey, task.type, task.assignmentId, result);
  const sr = await f(`${accept.taskUrl}/${task.assignmentId}`, {
    method: "POST",
    headers: { ...taskHeaders, "content-type": "application/json" },
    body: JSON.stringify({ result, model: opts.model, sig }),
  });
  const body = (await sr.json()) as { voucher?: string; calls?: number; error?: string; message?: string };
  if (!body.voucher) {
    log(`4. POST signed result -> ${sr.status} ${body.error}: ${body.message}`);
    return { status: sr.status, callsRemaining: null, outcome: sr.status === 422 ? "rejected" : "error", detail: body.message };
  }
  log(`4. POST signed result -> 200, voucher for ${body.calls} calls`);

  const paid = await f(opts.apiUrl, { headers: { [HEADERS.voucher]: body.voucher } });
  const remaining = paid.headers.get(HEADERS.callsRemaining);
  log(`5. GET ${new URL(opts.apiUrl).pathname} with voucher -> ${paid.status}, calls remaining ${remaining}`);
  return { status: paid.status, callsRemaining: remaining, outcome: "passed" };
}

/** Earn with a dataset job (classify or extract). */
export function workAndCall(opts: { apiUrl: string; job: string; keypair?: Keypair; model: string; worker: Worker; fetch?: typeof fetch; log?: Log }): Promise<EarnResult> {
  return earnAndCall({
    ...opts,
    work: (task, log) => {
      const t = task as unknown as DatasetTask;
      log(`${t.type === "classify" ? "labelling" : "extracting"} ${t.items.length} item(s)`);
      return opts.worker(t);
    },
  });
}

/** Earn with the website review job. */
export function reviewAndCall(opts: {
  apiUrl: string;
  keypair?: Keypair;
  model: string;
  reviewer: Reviewer;
  fetch?: typeof fetch;
  log?: Log;
  slowThresholdMs?: number;
}): Promise<EarnResult> {
  const f = opts.fetch ?? globalThis.fetch;
  return earnAndCall({
    ...opts,
    job: "review",
    work: async (task, log) => {
      const assignment = task as unknown as Assignment;
      log(`reviewing ${assignment.siteUrl}...`);
      const report = await opts.reviewer(assignment, { fetch: f, log, slowThresholdMs: opts.slowThresholdMs });
      log(`report: ${report.findings.length} finding(s), usability ${report.usability.score}/5`);
      return report;
    },
  });
}
