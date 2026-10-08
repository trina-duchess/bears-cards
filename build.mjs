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
  .replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&bull;/g, "•").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
  .replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘").replace(/&eacute;/g, "é").replace(/&ntilde;/g, "ñ").replace(/&amp;/g, "&");
// Decoded twice because the team site sometimes double-escapes (e.g. "&amp;bull;").
const text = h => decode(decode(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " "))).replace(/\s+/g, " ").trim();
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
function parseSchedule(html) {
  const games = [];
  // Section headings ("REGULAR SEASON", "PRESEASON", "POSTSEASON") followed by matchup cards.
  const marks = [...html.matchAll(/<h2[^>]*d3-o-section-title[^>]*>\s*<span>\s*([^<]+?)\s*<\/span>/gi)].map(m => ({ i: m.index, name: m[1].trim() }));
  const starts = [...html.matchAll(/<div class="nfl-o-matchup-cards[ "]/g)].map(m => m.index);
  starts.forEach((s, k) => {
    const chunk = html.slice(s, starts[k + 1] ?? s + 20000);
    const sec = marks.filter(m => m.i < s).pop();
    const section = sec ? sec.name.toUpperCase() : "";
    const sType = /PRE/.test(section) ? "PRE" : /POST/.test(section) ? "POST" : "REG";
    const week = text((chunk.match(/<strong>([\s\S]*?)<\/strong>/) || [])[1] || "");
    if (/--bye/.test(chunk.slice(0, 200))) { games.push({ season: sType, week, bye: true }); return; }
    const pick = re => { const m = chunk.match(re); return m ? text(m[1]) : ""; };
    const gt = (chunk.match(/data-gametime="([^"]*)"/) || [])[1] || "";
    let kickoff = null;
    const g = gt.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):\d{2} ([+-]\d{2}):(\d{2})$/);
    if (g && g[3] !== "0001") kickoff = `${g[3]}-${g[1]}-${g[2]}T${g[4]}:${g[5]}:00${g[6]}:${g[7]}`;
    const headText = text((chunk.match(/<p class="nfl-o-matchup-cards__date-info">([\s\S]*?)<\/p>/) || [])[1] || "");
    const final = /--post-game/.test(chunk.slice(0, 200));
    const logo = (chunk.match(/(https:\/\/static\.www\.nfl\.com\/[^"\s]*\/clubs\/logos\/[A-Z]+)/) || [])[1] || "";
    const links = [...chunk.matchAll(/<a href="([^"]+)"[^>]*class="nfl-o-matchup-cards__btn-(?:game-day|buy-tickets)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(m => ({ label: text(m[2]), href: decode(m[1]) })).filter(l => l.label && !/ticket|watch|listen/i.test(l.label));
    games.push({
      season: sType, week, kickoff, tbd: !kickoff, header: headText,
      final, result: pick(/__score--result">([\s\S]*?)<\/span>/), score: pick(/__score--points">([\s\S]*?)<\/span>/),
      homeAway: pick(/__team-prefix">([\s\S]*?)<\/span>/) || pick(/__team-game-location">([\s\S]*?)<\/p>/),
      opp: pick(/__team-short-name">([\s\S]*?)<\/p>/), oppFull: pick(/__team-full-name">([\s\S]*?)<\/p>/), logo,
      tv: pick(/__media-tv--networks">([\s\S]*?)<\/span>/), radio: pick(/__media-radio--networks">([\s\S]*?)<\/span>/),
      venue: pick(/__venue--location">([\s\S]*?)<\/span>/), links,
    });
  });
  return games;
}
// ----- Bears news (ESPN) -----
// Keeps only stories about the Bears: ESPN must tag them "Chicago Bears", and stories that cover
// several teams must name the Bears, Chicago, the head coach or a current Bears player.
function bearsNewsFilter(names){
  const nameRe = names.length ? new RegExp("\\b(" + names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|") + ")\\b") : null;
  return a => {
    const teams=(a.categories||[]).filter(c=>c.type==="team").map(c=>c.description||"");
    if (!teams.includes("Chicago Bears")) return false;
    if (teams.length === 1) return true;                        // tagged only with the Bears
    const about = t => /\bBears\b|\bChicago\b|Ben Johnson/.test(t) || (nameRe ? nameRe.test(t) : false);
    if (teams.length <= 2) return about(`${a.headline||""} ${a.description||""}`);
    return about(a.headline||"");                               // league-wide stories: Bears must be in the headline
  };
}
const slimNews = a => ({
  id: String(a.id||a.links?.web?.href||a.headline), headline: a.headline||"", description: a.description||"",
  published: a.published||a.lastModified||"", type: a.type||"", premium: !!a.premium,
  image: a.images?.[0]?.url||"", link: a.links?.web?.href||"", source: "ESPN",
});
const playerSearchNames = players => Object.values(players).map(p=>p.name.replace(/\s+(Jr\.|Sr\.|II|III|IV)$/,"")).filter(n=>n.split(" ").length>1);
// RSS / Atom feed reader for the other news sources (team site, Sun-Times, Tribune, Windy City Gridiron)
function parseFeed(xml, source){
  const out=[];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const b=m[2];
    const tag=name=>{ const r=b.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`)); return r?r[1]:""; };
    const cdata=s=>s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/,"$1");
    const title=text(decode(cdata(tag("title"))));
    let link=cdata(tag("link")).trim();
    if (!link || link.startsWith("<")) { const r=b.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/)||b.match(/<link\b[^>]*href="([^"]+)"/); link=r?decode(r[1]):""; }
    const when=new Date((tag("pubDate")||tag("published")||tag("updated")).trim());
    const body=cdata(tag("description")||tag("summary")||tag("content"));
    const img=(b.match(/<media:content[^>]*url="([^"]+)"/)||b.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)||b.match(/<img[^>]*src="([^"]+)"/)||decode(b).match(/<img[^>]*src="([^"]+)"/)||[])[1]||"";
    let desc=text(decode(body)).replace(/\[…\]|\[\.\.\.\]|\[&#8230;\]/g,"").trim();
    if (desc.length>240) desc=desc.slice(0,240).replace(/\s+\S*$/,"")+"…";
    if (!title || !link || isNaN(when)) continue;
    out.push({ id:link, headline:title, description:desc===title?"":desc, published:when.toISOString(), type:"Story", premium:false, image:decode(img), link, source });
  }
  return out;
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

function previousData() {
  try {
    const old = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const m = old.match(/const DATA = (\{.*?\});\n/s);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
}

function seasonYear(d = new Date()) { return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }

async function main() {
  const year = seasonYear();
  const [depthHtml, rosterHtml, statsHtml] = await Promise.all([
    get("/team/depth-chart"), get("/team/players-roster/"), get(`/team/stats/${year}/REG`),
  ]);
  // The schedule is optional: if it can't be read, keep the schedule from the last good build.
  let schedule = [];
  try {
    schedule = parseSchedule(await get("/schedule/"));
    if (schedule.filter(g => !g.bye).length < 10) throw new Error(`only ${schedule.length} games found`);
  } catch (e) {
    console.warn("Schedule update skipped:", e.message);
    schedule = previousData().schedule || [];
  }
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

  // Team logos are saved into the page itself, so they show even where outside images are blocked.
  const prevLogos = {};
  for (const g of previousData().schedule || []) if (g.logo && g.logoData) prevLogos[g.logo] = g.logoData;
  const logoCache = {};
  for (const g of schedule) {
    if (!g.logo) continue;
    const abbr = g.logo.split("/").pop();
    if (!(g.logo in logoCache)) {
      logoCache[g.logo] = prevLogos[g.logo] || "";
      try {
        const r = await fetch(`https://static.www.nfl.com/image/upload/w_160,f_png/league/api/clubs/logos/${abbr}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const isPng = buf.length > 200 && buf.length < 60000 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";
        if (r.ok && isPng) logoCache[g.logo] = "data:image/png;base64," + buf.toString("base64");
      } catch (e) { /* keep the previous copy or fall back to the web address */ }
    }
    if (logoCache[g.logo]) g.logoData = logoCache[g.logo];
  }

  // Bears news from several sources, merged into one list (newest first).
  // Each update saves the latest stories, so the News tab can scroll back further than any one feed goes.
  // The app itself also pulls fresh ESPN stories every time it opens.
  const names = playerSearchNames(players);
  const nameRe = new RegExp("\\b(" + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b");
  const NEWS_SOURCES = [
    { source: "ChicagoBears.com", url: "https://www.chicagobears.com/rss/news" },
    { source: "Sun-Times", url: "https://chicago.suntimes.com/rss/bears/index.xml" },
    { source: "Windy City Gridiron", url: "https://www.windycitygridiron.com/rss/index.xml" },
    // The Tribune blocks direct feed readers, so its Bears stories come through Google News.
    { source: "Tribune", url: "https://news.google.com/rss/search?q=%22Chicago+Bears%22+site:chicagotribune.com+when:14d&hl=en-US&gl=US&ceid=US:en",
      tidy: n => ({ ...n, headline: n.headline.replace(/\s+-\s+Chicago Tribune$/, ""), description: "" }),
      keep: n => /\bBears\b|Ben Johnson/.test(n.headline) || nameRe.test(n.headline) },
  ];
  let fresh = [];
  try {
    const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?team=3&limit=50");
    fresh.push(...((await r.json()).articles || []).filter(bearsNewsFilter(names)).map(slimNews));
  } catch (e) { console.warn("ESPN news skipped:", e.message); }
  for (const src of NEWS_SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BearsDepthCards/1.0)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let items = parseFeed(await res.text(), src.source);
      if (src.tidy) items = items.map(src.tidy);
      if (src.keep) items = items.filter(src.keep);
      fresh.push(...items);
      console.log(`News: ${items.length} from ${src.source}`);
    } catch (e) { console.warn(`${src.source} news skipped:`, e.message); }
  }
  const linkKey = u => String(u).replace(/^https?:\/\//, "").replace(/#.*$/, "").replace(/\/$/, "");
  const seen = new Set();
  let news = [...fresh, ...(previousData().news || [])]
    .filter(n => n.link && n.published && !seen.has(linkKey(n.link)) && seen.add(linkKey(n.link)));
  news.sort((a, b) => new Date(b.published) - new Date(a.published));
  news = news.slice(0, 300);

  const keep = {};
  for (const s of onChart) if (players[s]) keep[s] = players[s];
  const statsKept = {};
  for (const s of onChart) if (stats[s]) statsKept[s] = stats[s];

  const data = {
    asOf, season: year, built: new Date().toISOString().slice(0, 10),
    slots: slots.map(s => ({ ...s, list: s.list.filter(x => keep[x]) })).filter(s => s.list.length),
    players: keep, stats: statsKept, schedule, news,
  };
  const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  if (!tpl.includes("__BEARS_DATA__")) throw new Error("template.html is missing the __BEARS_DATA__ marker");
  const out = tpl.replace("__BEARS_DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
  writeFileSync(new URL("./index.html", import.meta.url), out);
  console.log(`Built: ${data.slots.length} depth rows, ${Object.keys(keep).length} players, ${Object.keys(statsKept).length} with stats, ${schedule.length} schedule entries, ${news.length} news stories, depth chart as of ${asOf}`);
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
