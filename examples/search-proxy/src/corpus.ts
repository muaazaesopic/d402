/**
 * A tiny in-memory corpus for the example search API: ~40 short documents
 * across the four topics the d402 classify task uses.
 */
export interface Doc {
  title: string;
  url: string;
  text: string;
  topic: "sports" | "business" | "tech" | "world";
}

export const LABELS = ["sports", "business", "tech", "world"] as const;

const doc = (topic: Doc["topic"], slug: string, title: string, text: string): Doc => ({
  title,
  url: `https://example.com/${topic}/${slug}`,
  text,
  topic,
});

export const CORPUS: Doc[] = [
  doc("sports", "cup-final-extra-time", "Cup final decided in extra time", "The home side won the cup final in extra time after a late goal from their rookie striker, sending a sold-out stadium into celebration."),
  doc("sports", "marathon-record", "Marathon record falls", "The marathon favourite set a course record on Sunday, finishing more than a minute ahead of the defending champion."),
  doc("sports", "goalkeeper-retires", "Veteran goalkeeper retires", "The veteran goalkeeper announced his retirement after twenty seasons, three league titles and two cup wins."),
  doc("sports", "relegation-battle", "Relegation battle goes to the last day", "Three clubs are still threatened with relegation going into the final weekend of the league season."),
  doc("sports", "tennis-upset", "Top seed knocked out in straight sets", "The tennis top seed was beaten in straight sets by a qualifier in the second round of the championships."),
  doc("sports", "sprint-relay", "Sprint relay squad qualifies", "The Olympic sprint squad qualified fastest for the relay final with a national record."),
  doc("sports", "penalty-shootout", "Title holders out on penalties", "The title holders were eliminated in a penalty shootout after a goalless draw in the semi-final."),
  doc("sports", "coach-sacked", "Coach sacked after losing streak", "The club sacked its coach after a sixth straight defeat left the league leaders twelve points clear."),
  doc("sports", "transfer-window", "Transfer window closes", "The transfer window closed with a record fee paid for a midfielder from the host nation's league."),
  doc("sports", "stadium-expansion", "Stadium expansion approved", "The club's stadium expansion to 60,000 seats was approved by the city council on Tuesday."),

  doc("business", "retailer-profit", "Retailer posts surprise quarterly profit", "The retailer reported a surprise quarterly profit as consumer demand held up despite high interest rates."),
  doc("business", "bank-job-cuts", "Regional bank cuts jobs", "A regional bank announced job losses across its branch network, citing weaker margins and rising costs."),
  doc("business", "airline-merger", "Airline agrees merger", "The airline agreed a merger with its closest competitor, creating the largest carrier in the region."),
  doc("business", "carmaker-guidance", "Carmaker lowers guidance", "The carmaker cut its annual guidance below market expectations, sending its stock lower in early trading."),
  doc("business", "buyback", "Energy group launches share buyback", "The energy group announced a share buyback worth billions after booking record annual revenue."),
  doc("business", "dividend-increase", "Insurer raises dividend", "The insurer raised its dividend for shareholders after a drop in claims improved its margins."),
  doc("business", "pe-acquisition", "Private equity firm buys logistics company", "The private equity firm disclosed the acquisition of a logistics company in a deal valued at two billion."),
  doc("business", "supermarket-prices", "Supermarket chain warns on prices", "The supermarket chain warned of higher prices as supply chain costs continued to rise."),
  doc("business", "pharma-downgrade", "Analysts downgrade pharmaceutical giant", "Analysts downgraded the pharmaceutical giant after a key drug trial missed its targets."),
  doc("business", "rates-hold", "Central bank holds interest rates", "The central bank held interest rates steady and projected slower growth for the rest of the year."),

  doc("tech", "new-llm", "AI lab releases new large language model", "The AI lab released a new large language model with support for on-device inference and a permissive licence."),
  doc("tech", "kernel-patch", "Critical kernel security fix shipped", "The open-source project shipped a critical security fix for its kernel after a privilege escalation bug was disclosed."),
  doc("tech", "gpu-launch", "Chipmaker unveils faster data centre GPU", "The chipmaker unveiled a faster GPU for data centres, claiming a 2x speedup on transformer training."),
  doc("tech", "os-beta", "Smartphone maker opens OS beta", "The smartphone maker rolled out a beta of its next operating system to developers this week."),
  doc("tech", "e2e-chats", "End-to-end encryption for group chats", "The social network launched end-to-end encryption for group chats after months of testing."),
  doc("tech", "vector-search", "Database vendor adds vector search", "The database vendor released a vector search feature with support for Rust and Python clients."),
  doc("tech", "compiler-silicon", "Compiler for custom silicon open-sourced", "The cloud provider open-sourced a compiler for its custom silicon under a permissive licence."),
  doc("tech", "edge-transformer", "Smaller transformer for edge devices", "A startup benchmarked a smaller transformer for edge devices that runs on a phone with low latency."),
  doc("tech", "browser-deprecation", "Browser team deprecates legacy API", "The browser team deprecated a legacy API and rewrote its streaming protocol for lower latency."),
  doc("tech", "robot-warehouse", "Robotics company ships warehouse robots", "The robotics company shipped its first warehouse robots to customers after a two-year pilot."),

  doc("world", "ceasefire-border", "Ceasefire agreed along disputed border", "The UN envoy brokered a ceasefire along the disputed border as diplomats gathered in Geneva."),
  doc("world", "flood-emergency", "State of emergency after floods", "The prime minister declared a state of emergency after the floods and rescue teams evacuated the besieged city."),
  doc("world", "sanctions", "Parliament approves sanctions", "The parliament approved sanctions on the neighbouring regime in a televised vote drawing international criticism."),
  doc("world", "election-postponed", "General election postponed amid unrest", "The election commission postponed the general election amid unrest after weeks of demonstrations."),
  doc("world", "aid-corridors", "Aid corridors reopened", "The coalition government reopened aid corridors into the besieged city, according to state media."),
  doc("world", "referendum-constitution", "New constitution approved by referendum", "Voters approved a new constitution after the referendum, the foreign ministry said in a statement."),
  doc("world", "opposition-talks", "Talks with the opposition resume", "The regional governor negotiated talks with the opposition leader to end the capital's curfew."),
  doc("world", "embassy-attack", "Embassy suspended after attack", "The foreign ministry suspended operations at the embassy following the attack and evacuated staff."),
  doc("world", "peace-deal", "Peace deal signed after years of conflict", "Negotiators signed a peace deal after years of conflict, in a ceremony attended by the UN envoy."),
  doc("world", "protest-march", "Protesters march against curfew", "Protesters marched against the capital's curfew for a third night as the border agency reopened crossings."),
];

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Case-insensitive term match: every whitespace-separated term in `q` must appear
 * in the title or text. Hits are ordered by how many times the terms occur.
 */
export function search(q: string, corpus: Doc[] = CORPUS, limit = 10): Hit[] {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length) return [];
  const scored: Array<{ doc: Doc; score: number; first: number }> = [];
  for (const d of corpus) {
    const hay = `${d.title}\n${d.text}`.toLowerCase();
    let score = 0;
    let first = Infinity;
    let ok = true;
    for (const t of terms) {
      const idx = hay.indexOf(t);
      if (idx < 0) {
        ok = false;
        break;
      }
      first = Math.min(first, idx);
      score += hay.split(t).length - 1;
    }
    if (ok) scored.push({ doc: d, score, first });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
  return scored.slice(0, limit).map(({ doc: d, first }) => {
    const text = `${d.title}\n${d.text}`;
    const start = Math.max(0, first - 40);
    const snippet = (start > 0 ? "..." : "") + text.slice(start, start + 140).replace(/\s+/g, " ").trim() + (start + 140 < text.length ? "..." : "");
    return { title: d.title, url: d.url, snippet };
  });
}
