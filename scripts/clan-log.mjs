/* =====================================================================
   Clan log archive
   ---------------------------------------------------------------------
   The game's clan log is a rolling window. The first archive run, on
   2026-09-04, read 639 entries reaching back to 2026-08-22 — thirteen days.
   skip=800 is a 404, so that really is the whole of it. The bound is the
   entry count rather than the age, so a busy fortnight covers fewer days
   than a quiet one.

   Everything the dashboard says about the vault is derived from that log:
   who deposited what, who withdrew it, what it was worth. So every day
   that passes, a day of deposits stops existing, and a member's "vault
   in" total quietly shrinks toward zero. Nothing in the page can fix
   that — by the time the browser asks, the rows are already gone.

   This job asks every few hours and keeps what it finds. Entries are
   identified by timestamp + member + message, which is unique in practice
   and, more importantly, stable: re-reading an entry never duplicates it.

   The archive only ever grows. At roughly forty entries a day that is
   about 15,000 rows a year — a file measured in single-digit megabytes,
   which is fine for a repo and fine to fetch. RETAIN_DAYS is a backstop
   for a clan that suddenly gets very chatty, not a routine trim.
   ===================================================================== */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CLAN        = process.env.CLAN || "Overkill";
const BASE        = "https://query.idleclans.com";
const PAGE        = 200;
const MAX_PAGES   = 20;              // 4,000 entries: far past the live window
const OUT         = "data/clan-log.json";
const RETAIN_DAYS = 1095;            // three years

const key = e => `${e.timestamp}|${e.memberUsername || ""}|${e.message || ""}`;

async function getJSON(url){
  for (let attempt = 1; attempt <= 3; attempt++){
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;                 // past the end
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise(r => setTimeout(r, attempt * 1500));
  }
}

/** Every page the API still holds, newest first. */
async function fetchLive(){
  const all = [];
  for (let p = 0; p < MAX_PAGES; p++){
    const url = `${BASE}/api/Clan/logs/clan/${encodeURIComponent(CLAN)}` +
                `?skip=${p * PAGE}&limit=${PAGE}`;
    const page = await getJSON(url);
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    if (page.length < PAGE) break;                       // short page = last page
  }
  return all;
}

async function readArchive(){
  try {
    const doc = JSON.parse(await readFile(OUT, "utf8"));
    return Array.isArray(doc.entries) ? doc.entries : [];
  } catch { return []; }
}

const live = await fetchLive();
console.log(`Live window: ${live.length} entries` +
  (live.length ? `, ${live[live.length - 1].timestamp} → ${live[0].timestamp}` : ""));

const kept = await readArchive();
console.log(`Archive on disk: ${kept.length} entries`);

/* Merge. The archive is authoritative for anything the API has already
   dropped; the live window is authoritative for nothing at all, since a log
   entry never changes after it is written. So: keep both, drop duplicates. */
const seen = new Map();
for (const e of kept) seen.set(key(e), e);
let added = 0;
for (const e of live) if (!seen.has(key(e))){ seen.set(key(e), e); added++; }

const cutoff = Date.now() - RETAIN_DAYS * 86400000;
const merged = [...seen.values()]
  .filter(e => {
    const t = Date.parse(e.timestamp);
    return !Number.isFinite(t) || t >= cutoff;
  })
  .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

const dropped = seen.size - merged.length;
console.log(`Added ${added} new, dropped ${dropped} past retention, ${merged.length} total`);

if (!merged.length){
  console.log("Nothing to write — refusing to replace the archive with an empty file.");
  process.exit(0);
}

/* An empty or truncated fetch must never shrink the archive. If the merge is
   smaller than what was already on disk and nothing aged out, something went
   wrong upstream; leave the file alone and let the next run try again. */
if (merged.length < kept.length && dropped === 0){
  console.log(`Merge (${merged.length}) is smaller than the archive (${kept.length}); leaving it alone.`);
  process.exit(0);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  clan: CLAN,
  updatedAt: new Date().toISOString(),
  oldest: merged[merged.length - 1].timestamp,
  newest: merged[0].timestamp,
  count: merged.length,
  entries: merged
}, null, 0) + "\n");

console.log(`Wrote ${OUT}: ${merged[merged.length - 1].timestamp} → ${merged[0].timestamp}`);
