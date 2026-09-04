#!/usr/bin/env node
/**
 * Hourly market snapshot.
 *
 * The API is stateless: every endpoint tells you what is true right now. It
 * cannot tell you whether a buy order has been sitting at 10,761 for six hours
 * or appeared ninety seconds ago — and that difference is what separates a real
 * trade from bait. So we record the board every hour and keep the history
 * ourselves. Nothing else can reconstruct it later; a day not recorded is gone.
 *
 * Two files come out of this:
 *
 *   data/market/latest.json  — this hour's board, ready for the dashboard to
 *                              read directly. No API calls in the browser.
 *   data/market/hourly.json  — the history, stored as CHANGE POINTS rather than
 *                              samples. An illiquid item's ask is identical in
 *                              all 24 snapshots; writing it 24 times is 24x
 *                              waste. We write it when it moves.
 *
 *   node scripts/market-snapshot.mjs
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR    = resolve(ROOT, "data/market");
const LATEST = resolve(DIR, "latest.json");
const HOURLY = resolve(DIR, "hourly.json");

const API = process.env.API_BASE || "https://query.idleclans.com";

/* Keep two weeks of hourly detail. Beyond that the daily averages in the
   summary endpoint carry the long-run picture, and holding every hour forever
   would make the browser download grow without bound. */
const KEEP_HOURS = 24 * 14;

async function get(path){
  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const res = await fetch(API + path, {
        headers: { Accept: "application/json", "User-Agent": "overkill-dashboard-market" },
        signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err){
      if (attempt === 3) throw new Error(`${path}: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
}

const asMap = raw => {
  // These endpoints have been seen returning both an array and an object map.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.values(raw);
  return [];
};

/** Median of the trailing daily averages — a fair value that a single silly
    listing can't drag around, unlike a mean. */
function median(nums){
  const v = nums.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

async function main(){
  const stamp = new Date();
  const hourKey = stamp.toISOString().slice(0, 13) + ":00Z";   // hour resolution
  console.log("Snapshot for", hourKey);

  console.log("Fetching the live board…");
  const live = asMap(await get("/api/PlayerMarket/items/prices/latest?includeAveragePrice=true"));
  console.log(`  ${live.length} items on the live board`);

  console.log("Fetching the 30-day activity summary…");
  let summary = [];
  try { summary = asMap(await get("/api/PlayerMarket/items/prices/summary?period=30d")); }
  catch (e){ console.log("  !! summary failed:", e.message); }
  console.log(`  ${summary.length} items in the summary`);

  // This is the measurement that decides how much of the dashboard's per-item
  // machinery can be deleted: if both calls cover the whole market, the browser
  // never needs to ask about a single item again.
  const withVolume = summary.filter(s => Number(s.tradeVolume) > 0).length;
  console.log(`  ${withVolume} of them have traded in the window`);

  const byId = new Map();
  for (const s of summary) if (s && s.itemId != null) byId.set(Number(s.itemId), s);

  /* ---------------- this hour's board ---------------- */
  const rows = {};
  let priced = 0, twoSided = 0;
  for (const p of live){
    const id  = Number(p.itemId);
    if (!Number.isFinite(id)) continue;
    const bid = Number(p.highestBuyPrice)  || 0;
    const ask = Number(p.lowestSellPrice)  || 0;
    if (!bid && !ask) continue;
    priced++;
    if (bid && ask) twoSided++;

    const s = byId.get(id);
    const dailyAvgs = s && Array.isArray(s.prices) ? s.prices.map(Number) : [];
    const dailyVols = s && Array.isArray(s.volumes) ? s.volumes.map(Number) : [];

    const row = { bid, ask };
    const avg24 = Number(p.dailyAveragePrice) || 0;
    if (avg24) row.avg1d = avg24;
    if (dailyAvgs.length){
      row.fair = median(dailyAvgs);                       // 30-day median
      row.avg7 = median(dailyAvgs.slice(-7));
    }
    if (s && Number.isFinite(Number(s.tradeVolume))) row.vol30 = Number(s.tradeVolume);
    if (dailyVols.length){
      /* The final bucket is the day in progress, not a finished one: two items
         trading 116k and 465k a day both ended at ~180 on the first live run,
         which is four hours of trading, not a day of it. Averaging it in drags
         every item's rate down, so complete days only. */
      const complete = dailyVols.slice(0, -1).filter(n => Number.isFinite(n));
      const last7 = complete.slice(-7);
      if (last7.length) row.volPerDay = Math.round(last7.reduce((a, b) => a + b, 0) / last7.length);
      if (complete.length) row.volPrevDay = Math.round(complete[complete.length - 1]);
      row.volToday = Math.round(dailyVols[dailyVols.length - 1] || 0);   // partial
    }
    if (s && s.lastTradeTimestamp) row.lastTrade = s.lastTradeTimestamp;
    rows[id] = row;
  }
  console.log(`  ${priced} items priced, ${twoSided} with both a bid and an ask`);

  /* Print the tail of two busy items so the shape of the volume series is a
     matter of record rather than inference. The final bucket looks like a
     partial day; this is how we confirm it instead of assuming it. */
  for (const id of [0, 1]){
    const s0 = byId.get(id);
    if (!s0 || !Array.isArray(s0.volumes)) continue;
    const v = s0.volumes.map(Number);
    console.log(`  item ${id}: ${v.length} volume buckets, last 5 = ${
      v.slice(-5).map(n => Math.round(n)).join(", ")}` +
      (Array.isArray(s0.prices) ? ` · ${s0.prices.length} price buckets` : ""));
  }

  await mkdir(DIR, { recursive: true });

  /* ---------------- history, as change points ---------------- */
  let hist = { startedAt: stamp.toISOString(), hours: [], items: {} };
  try { hist = JSON.parse(await readFile(HOURLY, "utf8")); }
  catch { console.log("  starting a new history file"); }
  if (!Array.isArray(hist.hours)) hist.hours = [];
  if (!hist.items || typeof hist.items !== "object") hist.items = {};

  if (hist.hours[hist.hours.length - 1] === hourKey){
    console.log("  this hour is already recorded; refreshing it in place");
    hist.hours.pop();
    for (const rec of Object.values(hist.items)){
      for (const key of ["a", "b"]){
        const arr = rec[key];
        if (Array.isArray(arr) && arr.length && arr[arr.length - 1][0] === hist.hours.length) arr.pop();
      }
    }
  }
  const h = hist.hours.length;
  hist.hours.push(hourKey);

  let changed = 0;
  for (const [idStr, row] of Object.entries(rows)){
    const rec = hist.items[idStr] || (hist.items[idStr] = { a: [], b: [] });
    for (const [key, value] of [["a", row.ask], ["b", row.bid]]){
      const arr = rec[key];
      const prev = arr.length ? arr[arr.length - 1][1] : null;
      // Only write when it moves. A quiet item costs one entry a fortnight.
      if (prev !== value){ arr.push([h, value]); changed++; }
    }
  }
  console.log(`  ${changed} price changes recorded this hour`);

  /* Drop hours that have aged out, and rebase the indices so they stay small. */
  if (hist.hours.length > KEEP_HOURS){
    const drop = hist.hours.length - KEEP_HOURS;
    hist.hours = hist.hours.slice(drop);
    for (const [idStr, rec] of Object.entries(hist.items)){
      for (const key of ["a", "b"]){
        const arr = rec[key] || [];
        // Keep the last value from before the cut: it's still in force.
        const before = arr.filter(([hr]) => hr < drop).pop();
        const after  = arr.filter(([hr]) => hr >= drop).map(([hr, v]) => [hr - drop, v]);
        rec[key] = before && (!after.length || after[0][0] !== 0)
          ? [[0, before[1]], ...after] : after;
      }
      if (!rec.a.length && !rec.b.length) delete hist.items[idStr];
    }
    console.log(`  pruned ${drop} hour(s) past the ${KEEP_HOURS}-hour window`);
  }

  /* ---------------- what the history is FOR ----------------
     The browser never downloads hourly.json — two weeks of it is a megabyte,
     and a page that costs a megabyte to answer "what should I buy" has failed.
     The Action holds the history and writes only its conclusions: how long the
     current quotes have stood, and how restless the item has been. Three small
     numbers per item instead of a fortnight of samples. */
  const HOURS = hist.hours.length;
  const ageOf = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    // hours[] already includes this hour, so the newest index is HOURS-1.
    // A quote set this hour has held for 0 hours, not 1 — reporting 1 would
    // make a brand-new quote look like it had survived a round of trading.
    return (HOURS - 1) - arr[arr.length - 1][0];
  };
  const movesIn = (arr, window) => {
    if (!Array.isArray(arr)) return 0;
    const from = Math.max(0, HOURS - window);
    return arr.filter(([hr]) => hr >= from).length;
  };

  let withAge = 0;
  for (const [idStr, row] of Object.entries(rows)){
    const rec = hist.items[idStr];
    if (!rec) continue;
    const bidAge = ageOf(rec.b), askAge = ageOf(rec.a);
    if (bidAge != null){ row.bidHeldH = bidAge; withAge++; }
    if (askAge != null) row.askHeldH = askAge;
    const moves = movesIn(rec.a, 24) + movesIn(rec.b, 24);
    if (moves) row.moves24 = moves;
  }
  console.log(`  ${withAge} items carry a quote age (needs 2+ snapshots to mean anything)`);

  await writeFile(LATEST, JSON.stringify({
    capturedAt: stamp.toISOString(),
    hour: hourKey,
    hoursOfHistory: HOURS,
    counts: { live: live.length, summary: summary.length, priced, twoSided, traded: withVolume },
    items: rows
  }) + "\n");
  console.log(`  wrote data/market/latest.json (${(JSON.stringify(rows).length/1024).toFixed(0)}KB) — this is the only file the dashboard reads`);

  hist.updatedAt = stamp.toISOString();
  await writeFile(HOURLY, JSON.stringify(hist) + "\n");
  const kb = (JSON.stringify(hist).length / 1024).toFixed(0);
  console.log(`  wrote data/market/hourly.json — ${hist.hours.length} hours, ` +
              `${Object.keys(hist.items).length} items, ${kb}KB`);

  console.log("\nDone.");
}

main().catch(err => { console.error("Market snapshot failed:", err.message); process.exit(1); });
