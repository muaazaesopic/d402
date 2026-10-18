/**
 * The jobs the marketplace opens with. Website review is custom code (review.ts);
 * these three are plain dataset specs, the same JSON a poster would send to
 * POST /market/jobs. The data is generated so the demo is self-contained.
 */
import type { DatasetJobSpec } from "./dataset.js";

/** Deterministic PRNG so the seed data is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const PRODUCTS = ["desk lamp", "ceramic mug", "wool throw", "notebook set", "side table", "linen curtains"];

function sentimentJob(): DatasetJobSpec {
  const r = mulberry32(11);
  const positive = ["I love this {p}, it looks even better in person.", "Great {p}. Arrived fast and works perfectly.", "Excellent quality {p}, would recommend to anyone.", "This {p} is perfect for my apartment. Five stars."];
  const negative = ["The {p} broke after a week. Terrible.", "Really disappointed with this {p}, asked for a refund.", "Cheap {p}, nothing like the photos. Returning it.", "My {p} arrived damaged and support never replied."];
  const items = Array.from({ length: 36 }, (_, i) => {
    const label = i % 2 === 0 ? "positive" : "negative";
    const text = pick(r, label === "positive" ? positive : negative).replace("{p}", pick(r, PRODUCTS));
    return { id: `rev-${i + 1}`, text, ...(i < 12 ? { golden: label } : {}) };
  });
  return {
    id: "review-sentiment",
    type: "classify",
    title: "Customer review sentiment",
    poster: "Acme Home Research",
    instructions: "Read each customer review and label it positive or negative.",
    labels: ["positive", "negative"],
    itemsPerTask: 5,
    reward: { calls: 10 },
    items,
  };
}

function triageJob(): DatasetJobSpec {
  const r = mulberry32(23);
  const templates: Record<string, string[]> = {
    billing: ["I was charged twice for order {n}.", "Where is the invoice for my last purchase?", "Please refund the extra charge on my card."],
    shipping: ["My package for order {n} has not arrived.", "The tracking number for {n} shows no updates.", "Can I change the delivery address for order {n}?"],
    bug: ["The checkout page shows an error when I click pay.", "The app crashes when I open my orders.", "The add to cart button does nothing on mobile."],
    account: ["I forgot my password and the reset email never came.", "How do I change the email on my account?", "I cannot log in after updating my phone number."],
  };
  const labels = Object.keys(templates);
  const items = Array.from({ length: 40 }, (_, i) => {
    const label = labels[i % labels.length]!;
    const text = pick(r, templates[label]!).replace("{n}", `#${10_000 + Math.floor(r() * 90_000)}`);
    return { id: `tkt-${i + 1}`, text, ...(i < 12 ? { golden: label } : {}) };
  });
  return {
    id: "ticket-triage",
    type: "classify",
    title: "Support ticket triage",
    poster: "Helpdesk team",
    instructions: "Route each support ticket to the team that should handle it.",
    labels,
    itemsPerTask: 5,
    reward: { calls: 10 },
    items,
  };
}

function invoiceJob(): DatasetJobSpec {
  const r = mulberry32(37);
  const vendors = ["Northwind Supply", "Blue Harbor Freight", "Oakline Ceramics", "Pinecrest Textiles", "Copperleaf Lighting", "Meridian Paper Co."];
  const items = Array.from({ length: 30 }, (_, i) => {
    const vendor = pick(r, vendors);
    const number = `INV-${2000 + Math.floor(r() * 8000)}`;
    const total = (50 + r() * 4950).toFixed(2);
    const lines = [
      `From: ${vendor}`,
      `Invoice #: ${number}`,
      `Date: 2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}`,
      `Bill to: Acme Home, 12 Market St`,
      `Items: ${1 + Math.floor(r() * 9)} line(s)`,
      `Total due: $${Number(total).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    ];
    if (i % 3 === 1) lines.splice(3, 0, "Payment terms: net 30");
    return { id: `inv-${i + 1}`, text: lines.join("\n"), ...(i < 10 ? { golden: { vendor, invoice_number: number, total } } : {}) };
  });
  return {
    id: "invoice-extract",
    type: "extract",
    title: "Invoice field extraction",
    poster: "Acme Home Finance",
    instructions: "For each invoice, give the vendor name, the invoice number and the total due (number only, e.g. 1234.50).",
    fields: [
      { name: "vendor", description: "Company that sent the invoice" },
      { name: "invoice_number", description: "e.g. INV-1234" },
      { name: "total", description: "Total due as a number, no currency symbol" },
    ],
    itemsPerTask: 4,
    reward: { calls: 20 },
    items,
  };
}

export function seedJobs(): DatasetJobSpec[] {
  return [sentimentJob(), triageJob(), invoiceJob()];
}
