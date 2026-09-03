#!/usr/bin/env node
/**
 * One-off asset preparation for the Overkill dashboard.
 *
 * Two jobs, both done here so the browser never has to:
 *
 *  1. Equipment stats. The game-data payload is several megabytes, but the
 *     part we need — nine combat bonuses per item — compresses to a tiny
 *     lookup. Extract it once instead of making every visitor download the lot.
 *
 *  2. Equipment icons. Pulled from the community wiki, which stores files at a
 *     path derived from the md5 of the filename, then committed here so the
 *     dashboard serves them from its own domain rather than hotlinking.
 *
 * Re-run it after a game update. It is deliberately chatty: the first run tells
 * us the real field names rather than us guessing at them.
 *
 *   node scripts/assets.mjs
 *   SKIP_ICONS=1 node scripts/assets.mjs     # stats only
 */

import { writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = resolve(ROOT, "data/item-stats.json");
const ICON_DIR = resolve(ROOT, "data/icons");

const API  = process.env.API_BASE || "https://query.idleclans.com";
const WIKI = process.env.WIKI_BASE || "https://idleclans.wiki";

/* The nine numbers the paper doll shows, and the field names we expect to find.
   Every candidate is tried case-insensitively; whatever matches is reported. */
const STAT_FIELDS = {
  meleeStr : ["StrengthBonus", "MeleeStrengthBonus"],
  meleeAcc : ["AccuracyBonus", "MeleeAccuracyBonus"],
  meleeDef : ["DefenceBonus", "MeleeDefenceBonus"],
  rangeStr : ["ArcheryStrengthBonus", "RangedStrengthBonus"],
  rangeAcc : ["ArcheryAccuracyBonus", "RangedAccuracyBonus"],
  rangeDef : ["ArcheryDefenceBonus", "RangedDefenceBonus"],
  magicStr : ["MagicStrengthBonus"],
  magicAcc : ["MagicAccuracyBonus"],
  magicDef : ["MagicDefenceBonus"]
};

async function get(path, base = API){
  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const res = await fetch(base + path, {
        headers: { Accept: "application/json", "User-Agent": "overkill-dashboard-assets" },
        signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err){
      if (attempt === 3) throw new Error(`${path}: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

/** Find the array of item definitions wherever it lives in the payload. */
function findItems(root){
  const seen = new Set();
  const queue = [root];
  while (queue.length){
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)){
      // An item array is one whose members look like equipment definitions.
      const hit = node.find(v => v && typeof v === "object" &&
        Object.keys(v).some(k => /strengthbonus|accuracybonus|defencebonus/i.test(k)));
      if (hit) return node;
      for (const v of node) queue.push(v);
      continue;
    }
    for (const v of Object.values(node)) queue.push(v);
  }
  return null;
}

const lower = obj => {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase(), v);
  return m;
};

async function extractStats(){
  console.log("Fetching game data (this is the big one)…");
  const game = await get("/api/Configuration/game-data");
  console.log("  top-level keys:", Object.keys(game).join(", "));

  const items = findItems(game);
  if (!items){
    console.log("  !! no item array with combat-bonus fields found.");
    console.log("  !! Send this output back and I'll adjust the extractor.");
    return null;
  }
  console.log(`  found ${items.length} item definitions`);

  const sample = items.find(i => Object.values(lower(i)).some(v => typeof v === "number" && v !== 0)) || items[0];
  console.log("  fields on a sample item:", Object.keys(sample).join(", "));

  const resolved = {}, missing = [];
  const first = lower(sample);
  for (const [slot, names] of Object.entries(STAT_FIELDS)){
    const hit = names.find(n => first.has(n.toLowerCase()));
    if (hit) resolved[slot] = hit.toLowerCase(); else missing.push(slot);
  }
  console.log("  matched stat fields:", Object.entries(resolved).map(([k,v]) => `${k}=${v}`).join(", ") || "(none)");
  if (missing.length) console.log("  unmatched:", missing.join(", "));

  const out = {};
  let withStats = 0;
  for (const raw of items){
    const m = lower(raw);
    const id = m.get("id") ?? m.get("itemid");
    if (id == null) continue;
    const row = {};
    let any = false;
    for (const [slot, field] of Object.entries(resolved)){
      const v = Number(m.get(field)) || 0;
      if (v){ row[slot] = v; any = true; }
    }
    if (any){ out[id] = row; withStats++; }
  }

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    fields: resolved,
    itemCount: withStats,
    stats: out
  }) + "\n");

  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`  wrote data/item-stats.json — ${withStats} items with bonuses, ~${kb}KB`);
  return withStats;
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/** MediaWiki stores File:X.png at /images/<a>/<ab>/X.png where ab = md5(X.png). */
function wikiPath(filename){
  const h = createHash("md5").update(filename).digest("hex");
  return `/w/images/${h[0]}/${h.slice(0,2)}/${filename}`;
}

/** Filename spellings worth trying for one item. */
function candidates(item){
  const out = new Set();
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const fromKey  = item.nameLocKey ? cap(item.nameLocKey) : null;
  const fromName = item.name ? cap(String(item.name).trim().replace(/\s+/g, "_")) : null;
  for (const base of [fromKey, fromName]) if (base) out.add(base + ".png");
  return [...out];
}

async function fetchIcons(){
  console.log("\nFetching item metadata for equipment…");
  const meta = await get("/api/Items/metadata");
  const gear = (meta || []).filter(i =>
    i.equipmentSlot && String(i.equipmentSlot).toLowerCase() !== "none");
  console.log(`  ${gear.length} equippable items of ${meta.length} total`);

  await mkdir(ICON_DIR, { recursive: true });
  const have = new Set((await readdir(ICON_DIR).catch(() => [])));

  let got = 0, already = 0, missed = 0;
  const misses = [];

  for (const item of gear){
    const key = item.nameLocKey || String(item.name).toLowerCase().replace(/\s+/g, "_");
    const file = `${key}.png`;
    if (have.has(file)){ already++; continue; }

    let saved = false;
    for (const cand of candidates(item)){
      try {
        const res = await fetch(WIKI + wikiPath(cand), {
          headers: { "User-Agent": "overkill-dashboard-assets (clan dashboard, one-off)" },
          signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) continue;                 // not a real image
        await writeFile(join(ICON_DIR, file), buf);
        saved = true; got++;
        break;
      } catch { /* try the next spelling */ }
      await new Promise(r => setTimeout(r, 60));        // be a polite guest
    }
    if (!saved){ missed++; if (misses.length < 15) misses.push(item.name); }
  }

  console.log(`  downloaded ${got}, already had ${already}, no image found for ${missed}`);
  if (misses.length) console.log("  examples with no image:", misses.join(", "));
  return got + already;
}

async function main(){
  const stats = await extractStats();
  const icons = process.env.SKIP_ICONS ? null : await fetchIcons();
  console.log("\nDone.");
  if (stats)  console.log(`  ${stats} items have combat bonuses`);
  if (icons != null) console.log(`  ${icons} icons available`);
  console.log("  Commit data/item-stats.json and data/icons/ and the dashboard picks them up.");
}

main().catch(err => { console.error("Asset build failed:", err.message); process.exit(1); });
