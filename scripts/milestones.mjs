/* =====================================================================
   Milestone archive
   ---------------------------------------------------------------------
   /api/Milestone/recent is a GLOBAL feed: the last N events across every
   clan in the game. Overkill's share of any single poll is a handful of
   rows at best, and often none.

   The dashboard used to filter that feed live and keep what it saw for
   the length of a page visit. Which meant the panel was empty unless one
   of twenty members happened to level up in the few minutes someone had
   the tab open — and because it hides itself when empty, it looked like a
   feature that had been removed rather than one with nothing to show.

   Same problem as the vault, same fix: poll it on a schedule and keep
   what passes through. Twenty minutes is comfortably inside the window a
   200-row global feed covers, and a missed run costs only whatever went
   past in that gap.

   History starts the day this job does. Anything already out of the feed
   is gone for good.
   ===================================================================== */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CLAN        = process.env.CLAN || "Overkill";
const BASE        = "https://query.idleclans.com";
const OUT         = "data/milestones.json";
const COUNT       = 200;          // the most the endpoint will hand over
const RETAIN_DAYS = 365;
const MAX_ROWS    = 20000;        // a hard ceiling on file growth

/* Identity has to survive re-reading the same event on the next poll. The feed
   gives a username, a timestamp and either a skill or an item, which together
   are unique in practice — two members cannot hit the same milestone in the
   same second. */
const key = e => `${e.username}|${e.timestamp}|${e.skill ?? ""}|${e.itemId ?? ""}|${e.level ?? ""}`;

async function getJSON(url){
  for (let attempt = 1; attempt <= 3; attempt++){
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise(r => setTimeout(r, attempt * 1500));
  }
}

async function readArchive(){
  try {
    const doc = JSON.parse(await readFile(OUT, "utf8"));
    return Array.isArray(doc.events) ? doc.events : [];
  } catch { return []; }
}

const feed = await getJSON(`${BASE}/api/Milestone/recent?count=${COUNT}`);
if (!Array.isArray(feed)) throw new Error("milestone feed was not a list");

const mine = feed.filter(e => String(e.clan || "").toLowerCase() === CLAN.toLowerCase());
console.log(`Global feed: ${feed.length} events, ${mine.length} of them ${CLAN}'s`);

const kept = await readArchive();
console.log(`Archive on disk: ${kept.length} events`);

const seen = new Map();
for (const e of kept) seen.set(key(e), e);
let added = 0;
for (const e of mine) if (!seen.has(key(e))){ seen.set(key(e), e); added++; }

const cutoff = Date.now() / 1000 - RETAIN_DAYS * 86400;
let merged = [...seen.values()]
  .filter(e => !Number.isFinite(Number(e.timestamp)) || Number(e.timestamp) >= cutoff)
  .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

const dropped = seen.size - merged.length;
if (merged.length > MAX_ROWS) merged = merged.slice(0, MAX_ROWS);

console.log(`Added ${added} new, dropped ${dropped} past retention, ${merged.length} total`);

/* An empty result means one of two things, and they need opposite handling.

   If an archive already exists, this poll simply caught the feed at a moment
   with none of our events in it — leave the file alone.

   If no archive exists yet, write an empty but valid one. The very first run
   will usually find nothing: Overkill's share of a 200-row global feed is
   often zero. Exiting without writing left the workflow trying to commit a
   file that was never created, which is exactly how it failed. */
if (!merged.length){
  if (kept.length){
    console.log("Nothing new and nothing to lose — leaving the existing archive alone.");
    process.exit(0);
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    clan: CLAN, updatedAt: new Date().toISOString(),
    oldest: null, newest: null, count: 0, levelUps: 0, drops: 0, events: []
  }, null, 0) + "\n");
  console.log(`No ${CLAN} events in this poll — wrote an empty archive to start from.`);
  process.exit(0);
}

/* A short or empty poll must never shrink the archive. */
if (merged.length < kept.length && dropped === 0){
  console.log(`Merge (${merged.length}) is smaller than the archive (${kept.length}); leaving it alone.`);
  process.exit(0);
}

const levels = merged.filter(e => e.type === 1).length;
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  clan: CLAN,
  updatedAt: new Date().toISOString(),
  oldest: merged[merged.length - 1].timestamp,
  newest: merged[0].timestamp,
  count: merged.length,
  levelUps: levels,
  drops: merged.length - levels,
  events: merged
}, null, 0) + "\n");

console.log(`Wrote ${OUT}: ${merged.length} events, ${levels} level-ups, ${merged.length - levels} drops`);
