/**
 * A self-contained 10-document corpus for the demo `search` tool, plus a
 * built-in classify task pool so `d402-mcp-seller` is a complete paid MCP
 * server with no files at all. Four topics, the same labels the example
 * search API uses.
 */
import type { TaskFileItem } from "@d402/spec";

export interface Doc {
  id: string;
  title: string;
  url: string;
  text: string;
  topic: "sports" | "business" | "tech" | "world";
}

export const LABELS = ["sports", "business", "tech", "world"] as const;

const doc = (topic: Doc["topic"], slug: string, title: string, text: string): Doc => ({
  id: `${topic}/${slug}`,
  title,
  url: `https://example.com/${topic}/${slug}`,
  text,
  topic,
});

export const CORPUS: Doc[] = [
  doc("sports", "cup-final", "Cup final decided in extra time", "The home side won the cup final in extra time after a late goal from their rookie striker."),
  doc("sports", "marathon-record", "Marathon record falls", "The marathon favourite set a course record on Sunday, a minute ahead of the defending champion."),
  doc("sports", "tennis-upset", "Top seed out in straight sets", "The top seed was beaten in straight sets by a qualifier in the second round of the championships."),
  doc("business", "retailer-profit", "Retailer posts surprise profit", "The retailer reported a surprise quarterly profit as consumer demand held up despite high interest rates."),
  doc("business", "airline-merger", "Airline agrees merger", "The airline agreed a merger with its closest competitor, creating the largest carrier in the region."),
  doc("business", "rate-decision", "Central bank holds rates", "The central bank left its benchmark rate unchanged and said inflation was slowing in line with forecasts."),
  doc("tech", "gpu-prices", "GPU prices fall as supply recovers", "Graphics card prices fell for a third month as supply recovered and crypto mining demand stayed low."),
  doc("tech", "browser-release", "Browser ships new privacy mode", "The browser's latest release blocks third-party trackers by default and adds an on-device translation model."),
  doc("world", "election-count", "Vote count continues after close election", "Counting continued overnight in the general election with the two main parties separated by a handful of seats."),
  doc("world", "flood-relief", "Flood relief reaches the delta", "Relief convoys reached villages in the river delta a week after floods displaced tens of thousands of people."),
];

export interface Hit {
  id: string;
  title: string;
  url: string;
  topic: Doc["topic"];
  score: number;
  snippet: string;
}

/** Keyword search: one point per query term found in the title or text, title matches count double. */
export function search(q: string, limit = 5): Hit[] {
  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  const hits: Hit[] = [];
  for (const d of CORPUS) {
    const title = d.title.toLowerCase();
    const text = d.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 2;
      if (text.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ id: d.id, title: d.title, url: d.url, topic: d.topic, score, snippet: d.text.slice(0, 120) });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, Math.max(1, Math.min(limit, CORPUS.length)));
}

/** Built-in classify pool: the 10 corpus documents as goldens plus 10 unknown headlines. */
export const DEMO_TASKS: TaskFileItem[] = [
  ...CORPUS.map((d, i) => ({ id: `g_${i + 1}`, type: "classify" as const, text: `${d.title}. ${d.text}`, golden: d.topic })),
  { id: "u_1", type: "classify", text: "The striker's hat-trick sealed a derby win in front of a record crowd." },
  { id: "u_2", type: "classify", text: "The chipmaker raised its full-year outlook on demand for data-centre accelerators." },
  { id: "u_3", type: "classify", text: "Peace talks resumed in the capital after a two-week pause." },
  { id: "u_4", type: "classify", text: "Shares in the supermarket chain fell after it warned on margins." },
  { id: "u_5", type: "classify", text: "The open-source database project shipped a release with built-in vector search." },
  { id: "u_6", type: "classify", text: "The relay team qualified fastest for the final with a national record." },
  { id: "u_7", type: "classify", text: "Aid agencies warned of food shortages after the harvest failed for a second year." },
  { id: "u_8", type: "classify", text: "The phone maker's new model switches to a modular, repairable design." },
  { id: "u_9", type: "classify", text: "The insurer raised its dividend after a drop in claims improved margins." },
  { id: "u_10", type: "classify", text: "Voters in the island nation approved a new constitution by a narrow margin." },
];
