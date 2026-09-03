#!/usr/bin/env node
/**
 * One-off asset preparation for the Overkill dashboard.
 *
 * Two jobs, both done here so the browser never has to:
 *
 *  1. Equipment stats. The game-data payload is large, but the part we need —
 *     nine combat bonuses per item — compresses to a tiny lookup. Extract it
 *     once instead of making every visitor download the lot.
 *
 *  2. Equipment icons. Pulled from the community wiki via its MediaWiki API,
 *     then committed here so the dashboard serves them from its own domain
 *     rather than hotlinking.
 *
 * Re-run after a game update. It is deliberately chatty: it reports the shape
 * it actually found rather than assuming the shape we expected.
 *
 *   node scripts/assets.mjs
 *   SKIP_ICONS=1 node scripts/assets.mjs     # stats only
 *   SKIP_STATS=1 node scripts/assets.mjs     # icons only
 */

import { writeFile, mkdir, readdir } from "node:fs/promises";
import { gunzipSync, inflateSync } from "node:zlib";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = resolve(ROOT, "data/item-stats.json");
const ICON_DIR = resolve(ROOT, "data/icons");

const API  = process.env.API_BASE  || "https://query.idleclans.com";
const WIKI = process.env.WIKI_BASE || "https://idleclans.wiki";

/* The nine numbers the paper doll shows, and the field names worth trying.
   Matching is case-insensitive; whatever hits gets reported on stdout. */
const STAT_FIELDS = {
  meleeStr : ["StrengthBonus", "MeleeStrengthBonus"],
  meleeAcc : ["AccuracyBonus", "MeleeAccuracyBonus"],
  meleeDef : ["DefenceBonus", "MeleeDefenceBonus", "Defense Bonus"],
  rangeStr : ["ArcheryStrengthBonus", "RangedStrengthBonus"],
  rangeAcc : ["ArcheryAccuracyBonus", "RangedAccuracyBonus"],
  rangeDef : ["ArcheryDefenceBonus", "RangedDefenceBonus"],
  magicStr : ["MagicStrengthBonus"],
  magicAcc : ["MagicAccuracyBonus"],
  magicDef : ["MagicDefenceBonus"]
};

/* ------------------------------------------------------------------ */
/* Payload unwrapping                                                   */
/* ------------------------------------------------------------------ */

/**
 * The API does not reliably hand back a plain object. Seen in the wild: a
 * JSON-encoded string containing JSON, and byte arrays (sometimes gzipped).
 * Peel whatever wrapper is actually there, saying so as we go, rather than
 * assuming and failing silently three layers later.
 */
function unwrap(value, depth = 0){
  if (depth > 6) return value;

  if (typeof value === "string"){
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")){
      console.log(`  unwrapping: JSON-encoded string (${value.length} chars)`);
      try { return unwrap(JSON.parse(t), depth + 1); }
      catch (e){ console.log("  !! string did not parse as JSON:", e.message); return value; }
    }
    return value;
  }

  // An array of small integers is bytes, not data.
  if (Array.isArray(value) && value.length > 64 &&
      value.every(v => typeof v === "number" && v >= 0 && v <= 255)){
    let buf = Buffer.from(value);
    console.log(`  unwrapping: byte array (${buf.length} bytes)`);
    if (buf[0] === 0x1f && buf[1] === 0x8b){
      console.log("  unwrapping: gzip");
      buf = gunzipSync(buf);
    } else if (buf[0] === 0x78){
      console.log("  unwrapping: zlib deflate");
      buf = inflateSync(buf);
    }
    try { return unwrap(JSON.parse(buf.toString("utf8")), depth + 1); }
    catch (e){ console.log("  !! bytes did not parse as JSON:", e.message); return value; }
  }

  return value;
}

/** What did we actually get? Printed before anything tries to use it. */
function describe(value, label){
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const size = Array.isArray(value) ? `${value.length} entries`
             : typeof value === "string" ? `${value.length} chars`
             : value && typeof value === "object" ? `${Object.keys(value).length} keys`
             : String(value);
  console.log(`  ${label}: ${kind}, ${size}`);
  if (value && typeof value === "object" && !Array.isArray(value)){
    console.log(`  ${label} keys: ${Object.keys(value).slice(0, 40).join(", ")}`);
  }
  if (typeof value === "string"){
    console.log(`  ${label} starts: ${JSON.stringify(value.slice(0, 120))}`);
  }
}

async function get(path, base = API){
  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const res = await fetch(base + path, {
        headers: { Accept: "application/json", "User-Agent": "overkill-dashboard-assets" },
        signal: AbortSignal.timeout(180000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { parsed = text; }              // not JSON at all — hand back the raw text
      return unwrap(parsed);
    } catch (err){
      if (attempt === 3) throw new Error(`${path}: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

const looksLikeItem = v => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).some(k => /strength\s*bonus|accuracy\s*bonus|defen[cs]e\s*bonus/i.test(k));

/** Find the array of item definitions wherever it lives in the payload. */
function findItems(root){
  const seen = new Set();
  const queue = [[root, "$"]];
  while (queue.length){
    const [node, path] = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)){
      if (node.some(looksLikeItem)){
        console.log(`  item array found at ${path}`);
        return node;
      }
      node.forEach((v, i) => { if (i < 400) queue.push([v, `${path}[${i}]`]); });
      continue;
    }
    for (const [k, v] of Object.entries(node)) queue.push([v, `${path}.${k}`]);
  }
  return null;
}

const lower = obj => {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase().replace(/\s+/g, ""), v);
  return m;
};

async function extractStats(){
  console.log("Fetching game data (this is the big one)…");
  const game = await get("/api/Configuration/game-data");
  describe(game, "game-data");

  const items = findItems(game);
  if (!items){
    console.log("  !! no item array with combat-bonus fields found.");
    console.log("  !! Paste this output back and I'll adjust the extractor.");
    return null;
  }
  console.log(`  ${items.length} item definitions`);

  const sample = items.find(looksLikeItem) || items[0];
  console.log("  fields on a sample item:", Object.keys(sample).join(", "));

  const resolved = {}, missing = [];
  const first = lower(sample);
  for (const [slot, names] of Object.entries(STAT_FIELDS)){
    const hit = names.find(n => first.has(n.toLowerCase().replace(/\s+/g, "")));
    if (hit) resolved[slot] = hit.toLowerCase().replace(/\s+/g, ""); else missing.push(slot);
  }
  console.log("  matched stat fields:",
    Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)");
  if (missing.length) console.log("  UNMATCHED:", missing.join(", "));

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

const norm = s => String(s || "").toLowerCase()
  .replace(/\.png$/, "")
  .replace(/['’]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

/**
 * Ask the wiki what images it actually has, rather than deriving md5 paths and
 * hoping the filename matches. One paged listing, then a normalised lookup —
 * this turns "guess and 404" into "match or honestly report a miss".
 */
async function wikiImageIndex(){
  const index = new Map();
  let cont = null, pages = 0;

  do {
    const qs = new URLSearchParams({
      action: "query", list: "allimages", ailimit: "500",
      aiprop: "url", format: "json", formatversion: "2"
    });
    if (cont) qs.set("aicontinue", cont);

    const res = await fetch(`${WIKI}/api.php?${qs}`, {
      headers: { "User-Agent": "overkill-dashboard-assets (clan dashboard, one-off)" },
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error("wiki api HTTP " + res.status);
    const body = await res.json();

    for (const img of body?.query?.allimages || []){
      if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(img.name || "")) continue;
      const key = norm(img.name);
      if (key && !index.has(key)) index.set(key, img.url);
    }
    cont = body?.continue?.aicontinue || null;
    pages++;
  } while (cont && pages < 40);

  console.log(`  wiki lists ${index.size} images (${pages} pages)`);
  return index;
}

async function fetchIcons(){
  console.log("\nFetching item metadata…");
  const meta = await get("/api/Items/metadata");
  describe(meta, "metadata");

  const list = Array.isArray(meta) ? meta : (meta?.items || meta?.Items || []);
  if (!list.length){ console.log("  !! metadata is not a list of items; skipping icons."); return 0; }
  console.log("  fields on a sample item:", Object.keys(list[0]).join(", "));

  // Prefer real equipment, but never silently do nothing: if no slot field is
  // recognisable, take everything and let the wiki decide what it has.
  const slotOf = i => i.equipmentSlot ?? i.EquipmentSlot ?? i.slot ?? i.Slot;
  const gear = list.filter(i => {
    const s = slotOf(i);
    return s != null && String(s).toLowerCase() !== "none" && String(s) !== "-1";
  });
  const targets = gear.length ? gear : list;
  console.log(`  ${gear.length} equippable of ${list.length} total` +
              (gear.length ? "" : " — no slot field recognised, trying all items"));

  console.log("Asking the wiki for its image list…");
  let index;
  try { index = await wikiImageIndex(); }
  catch (e){ console.log("  !! wiki API failed:", e.message); return 0; }

  await mkdir(ICON_DIR, { recursive: true });
  const have = new Set(await readdir(ICON_DIR).catch(() => []));

  let got = 0, already = 0, missed = 0;
  const misses = [];

  for (const item of targets){
    const key  = item.nameLocKey || norm(item.name).replace(/ /g, "_");
    const file = `${key}.png`;
    if (have.has(file)){ already++; continue; }

    // Try the display name first, then the loc key with underscores stripped.
    const url = index.get(norm(item.name)) || index.get(norm(key));
    if (!url){ missed++; if (misses.length < 20) misses.push(item.name || key); continue; }

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "overkill-dashboard-assets (clan dashboard, one-off)" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error("too small to be an image");
      await writeFile(join(ICON_DIR, file), buf);
      got++;
    } catch (e){
      missed++; if (misses.length < 20) misses.push(`${item.name} (${e.message})`);
    }
    await new Promise(r => setTimeout(r, 40));      // be a polite guest
  }

  console.log(`  downloaded ${got}, already had ${already}, no image for ${missed}`);
  if (misses.length) console.log("  examples with no image:", misses.join(", "));
  return got + already;
}

async function main(){
  const stats = process.env.SKIP_STATS ? null : await extractStats();
  const icons = process.env.SKIP_ICONS ? null : await fetchIcons();
  console.log("\nDone.");
  if (stats != null) console.log(`  ${stats} items have combat bonuses`);
  if (icons != null) console.log(`  ${icons} icons available`);
  console.log("  Commit data/item-stats.json and data/icons/ and the dashboard picks them up.");
}

main().catch(err => { console.error("Asset build failed:", err.message); process.exit(1); });
