// Rebuilds index.html from the Chicago Bears website (depth chart, roster, stats).
// Runs weekly in GitHub Actions. No dependencies: Node 20+ only.
// If anything looks wrong, it exits with an error and leaves the old page in place.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://www.chicagobears.com";

// ==PARSE START== (plain JS, also runnable in a browser for testing)
const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const text = h => decode(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const slugOf = h => { const m = h.match(/players-roster\/([^\/"?#]+)/); return m ? m[1] : null; };
const tables = html => [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].map(m => ({ attrs: m[1], body: m[2] }));
const rows = body => [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
  [...m[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(c => ({ tag: c[1].toLowerCase(), html: c[2], text: text(c[2]), slug: slugOf(c[2]) })));

function parseDepth(html) {
  const asOf = (html.match(/As of\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i) || [])[1] || "";
  const slots = [];
  for (const t of tables(html)) {
    if (!/depthchart/i.test(t.attrs)) continue;
    const sum = (t.attrs.match(/summary="([^"]*)"/i) || [])[1] || "";
    const unit = /def/i.test(sum) ? "D" : /special/i.test(sum) ? "S" : "O";
    for (const r of rows(t.body)) {
      if (!r.length || r[0].tag === "th") continue;
      const pos = r[0].text;
      const list = r.slice(1, 4).map(c => c.slug).filter(Boolean);
      if (pos && list.length) slots.push({ unit, pos, list });
    }
  }
  return { asOf, slots };
}

function parseRoster(html) {
  const players = {};
  for (const t of tables(html)) {
    const rs = rows(t.body);
    if (!rs.length) continue;
    const head = rs[0].map(c => c.text.toLowerCase());
    if (head[0] !== "player" || !head.includes("college")) continue;
    const get = (r, k) => (r[head.indexOf(k)] || {}).text || "";
    for (const r of rs.slice(1)) {
      const c = r[0];
      if (!c || !c.slug || players[c.slug]) continue;
      const tm = c.html.match(/title="([^"]+)"/);
      players[c.slug] = {
        name: tm ? decode(tm[1]).trim() : c.text, num: get(r, "#"), pos: get(r, "pos"),
        ht: get(r, "ht"), wt: get(r, "wt"), age: get(r, "age"), exp: get(r, "exp"), col: get(r, "college"),
      };
    }
  }
  return players;
}

function statKind(h) {
  const has = k => h.includes(k);
  if (has("COMP") && has("RATE")) return "passing";
  if (has("TOTAL") && has("SOLO")) return "tackles";
  if (has("PUNTS")) return "punting";
  if (has("20-29")) return "fg";
  if (h[1] === "REC") return "receiving";
  if (h[1] === "INT") return "interceptions";
  if (h[1] === "ATT" && has("YDS/ATT")) return "rushing";
  if (h[1] === "RET" && has("YDS")) return "kr";
  if (h[1] === "RET") return "pr";
  return null;
}
function parseStats(html) {
  const stats = {};
  for (const t of tables(html)) {
    const rs = rows(t.body);
    if (!rs.length || rs[0][0]?.tag !== "th") continue;
    const head = rs[0].map(c => c.text.toUpperCase());
    const kind = statKind(head);
    if (!kind) continue;
    for (const r of rs.slice(1)) {
      const slug = r[0]?.slug;
      if (!slug) continue;
      const o = {};
      head.forEach((k, i) => { if (i > 0 && r[i]) o[k] = r[i].text; });
      (stats[slug] ||= {})[kind] = o;
    }
  }
  return stats;
}
// ==PARSE END==

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.text();
}

function seasonYear(d = new Date()) { return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }

async function main() {
  const year = seasonYear();
  const [depthHtml, rosterHtml, statsHtml] = await Promise.all([
    get("/team/depth-chart"), get("/team/players-roster/"), get(`/team/stats/${year}/REG`),
  ]);
  const { asOf, slots } = parseDepth(depthHtml);
  const players = parseRoster(rosterHtml);
  const stats = parseStats(statsHtml);

  // Sanity checks: refuse to publish a broken page.
  const onChart = new Set(slots.flatMap(s => s.list));
  const missing = [...onChart].filter(s => !players[s]);
  if (slots.length < 25) throw new Error(`Only ${slots.length} depth chart rows found`);
  if (Object.keys(players).length < 45) throw new Error(`Only ${Object.keys(players).length} roster players found`);
  if (!slots.some(s => s.pos === "QB")) throw new Error("No QB row on the depth chart");
  if (missing.length > 3) throw new Error(`Depth chart players missing from roster: ${missing.join(", ")}`);

  const keep = {};
  for (const s of onChart) if (players[s]) keep[s] = players[s];
  const statsKept = {};
  for (const s of onChart) if (stats[s]) statsKept[s] = stats[s];

  const data = {
    asOf, season: year, built: new Date().toISOString().slice(0, 10),
    slots: slots.map(s => ({ ...s, list: s.list.filter(x => keep[x]) })).filter(s => s.list.length),
    players: keep, stats: statsKept,
  };
  const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  if (!tpl.includes("__BEARS_DATA__")) throw new Error("template.html is missing the __BEARS_DATA__ marker");
  const out = tpl.replace("__BEARS_DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
  writeFileSync(new URL("./index.html", import.meta.url), out);
  console.log(`Built: ${data.slots.length} depth rows, ${Object.keys(keep).length} players, ${Object.keys(statsKept).length} with stats, depth chart as of ${asOf}`);
}

if (process.argv[2] === "--from-json") {
  // Local testing: build from a saved data file instead of the website.
  const data = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  writeFileSync(new URL("./index.html", import.meta.url), tpl.replace("__BEARS_DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c")));
  console.log("Built from JSON");
} else {
  main().catch(e => { console.error("Update failed:", e.message); process.exit(1); });
}
