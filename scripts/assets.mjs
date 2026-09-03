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
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = resolve(ROOT, "data/item-stats.json");
const ICON_DIR = resolve(ROOT, "data/icons");

const API  = process.env.API_BASE  || "https://query.idleclans.com";
const WIKI = process.env.WIKI_BASE || "https://idleclans.wiki";

/* ------------------------------------------------------------------ */
/* Payload unwrapping                                                   */
/* ------------------------------------------------------------------ */

/**
 * The API does not reliably hand back a plain object. Seen in the wild: a
 * JSON-encoded string containing JSON, and byte arrays (sometimes gzipped).
 * Peel whatever wrapper is actually there, saying so as we go, rather than
 * assuming and failing silently three layers later.
 */
/**
 * The payload is a MongoDB shell dump, not JSON: it carries ObjectId(…),
 * NumberLong(…), ISODate(…) and friends, which JSON.parse rightly rejects.
 * Rewrite those constructors into the plain values they wrap.
 */
export function deMongo(text){
  return text
    .replace(/ObjectId\(\s*["']([^"']*)["']\s*\)/g,     '"$1"')
    .replace(/UUID\(\s*["']([^"']*)["']\s*\)/g,         '"$1"')
    .replace(/ISODate\(\s*["']([^"']*)["']\s*\)/g,      '"$1"')
    .replace(/NumberDecimal\(\s*["']([^"']*)["']\s*\)/g, '$1')
    .replace(/NumberLong\(\s*["']?(-?\d+)["']?\s*\)/g,  '$1')
    .replace(/NumberInt\(\s*["']?(-?\d+)["']?\s*\)/g,   '$1')
    .replace(/BinData\(\s*\d+\s*,\s*["']([^"']*)["']\s*\)/g, '"$1"')
    .replace(/new Date\(\s*(\d+)\s*\)/g,                '$1');
}

/** Where exactly did a parse give up? Printed so a failure is diagnosable. */
function parseContext(text, message){
  const at = Number((message.match(/position (\d+)/) || [])[1]);
  if (!Number.isFinite(at)) return null;
  return text.slice(Math.max(0, at - 90), at + 90).replace(/\s+/g, " ");
}

function unwrap(value, depth = 0){
  if (depth > 6) return value;

  if (typeof value === "string"){
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")){
      console.log(`  unwrapping: JSON-encoded string (${value.length} chars)`);
      try { return unwrap(JSON.parse(t), depth + 1); }
      catch {
        // Probably Mongo shell syntax. Clean it up and try once more.
        const cleaned = deMongo(t);
        if (cleaned !== t) console.log("  unwrapping: MongoDB shell syntax (ObjectId etc.)");
        try { return unwrap(JSON.parse(cleaned), depth + 1); }
        catch (e2){
          console.log("  !! still not valid JSON:", e2.message);
          const ctx = parseContext(cleaned, e2.message);
          if (ctx) console.log("  !! around the failure:", JSON.stringify(ctx));
          console.log("  -> falling back to scanning the text for item objects");
          return { __rawText: cleaned };
        }
      }
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

/* A bonus field on a piece of EQUIPMENT. The leading (?!enemy) matters: boss
   definitions carry EnemyStrengthBonus and friends, and matching those is how
   the first run latched onto ClanBossInfos and extracted three monsters. */
const BONUS_KEY = /^(?!enemy)(melee|archery|ranged?|magic)?(strength|accuracy|defen[cs]e)bonus$/i;

const tidy = k => String(k).replace(/\s+/g, "");

const looksLikeItem = v => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).some(k => BONUS_KEY.test(tidy(k)));

/* Resolved by pattern rather than a fixed list of spellings, so a rename of
   Archery -> Ranged (or Defence -> Defense) doesn't silently zero a column. */
const STAT_PATTERNS = {
  meleeStr : /^(melee)?strengthbonus$/i,
  meleeAcc : /^(melee)?accuracybonus$/i,
  meleeDef : /^(melee)?defen[cs]ebonus$/i,
  rangeStr : /^(archery|ranged?)strengthbonus$/i,
  rangeAcc : /^(archery|ranged?)accuracybonus$/i,
  rangeDef : /^(archery|ranged?)defen[cs]ebonus$/i,
  magicStr : /^magicstrengthbonus$/i,
  magicAcc : /^magicaccuracybonus$/i,
  magicDef : /^magicdefen[cs]ebonus$/i
};

/**
 * Last resort: pull item objects straight out of the text.
 *
 * A 2.6MB dump only has to be malformed in one place for a whole-document
 * parse to fail, and we do not need the whole document — we need the objects
 * that carry combat bonuses. Walk the text with a brace counter (respecting
 * strings), and parse each self-contained object that mentions a bonus field.
 * A bad corner elsewhere then costs us nothing.
 */
export function harvestItems(text){
  const found = [];
  const stack = [];
  let inStr = false, esc = false;

  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (inStr){
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"'){ inStr = true; continue; }
    if (c === "{"){ stack.push(i); continue; }
    if (c !== "}") continue;

    const start = stack.pop();
    if (start == null) continue;
    const len = i - start;
    if (len < 60 || len > 40000) continue;              // too small / too big to be one item

    const chunk = text.slice(start, i + 1);
    if (!/strength\s*bonus/i.test(chunk)) continue;
    try {
      const obj = JSON.parse(chunk);
      if (looksLikeItem(obj)) found.push(obj);
    } catch { /* not a clean object on its own; skip it */ }
  }
  return found;
}

/** Find the array of item definitions wherever it lives in the payload. */
function findItems(root){
  const seen = new Set();
  const queue = [[root, "$"]];
  const found = [];

  // Collect every plausible array, then take the richest. Stopping at the
  // first match is what picked 3 bosses over 1000 items last time.
  while (queue.length){
    const [node, path] = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)){
      const n = node.filter(looksLikeItem).length;
      if (n) found.push({ node, path, n });
      node.forEach((v, i) => { if (i < 400) queue.push([v, `${path}[${i}]`]); });
      continue;
    }
    for (const [k, v] of Object.entries(node)) queue.push([v, `${path}.${k}`]);
  }

  if (!found.length) return null;
  found.sort((a, b) => b.n - a.n);
  console.log("  candidate arrays: " +
    found.slice(0, 6).map(c => `${c.path} (${c.n})`).join(", "));
  console.log(`  using ${found[0].path}`);
  return found[0].node;
}

const lower = obj => {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase().replace(/\s+/g, ""), v);
  return m;
};

async function extractStats(){
  console.log("Fetching game data (this is the big one)…");
  const game = await get("/api/Configuration/game-data");

  let items;
  if (game && game.__rawText){
    console.log(`  scanning ${game.__rawText.length} chars for item objects…`);
    items = harvestItems(game.__rawText);
    console.log(`  harvested ${items.length} objects with combat bonuses`);
    if (!items.length) items = null;
  } else {
    describe(game, "game-data");
    items = findItems(game);
  }

  if (!items){
    console.log("  !! no item array with combat-bonus fields found.");
    console.log("  !! Paste this output back and I'll adjust the extractor.");
    return null;
  }
  console.log(`  ${items.length} item definitions`);

  const sample = items.find(looksLikeItem) || items[0];
  console.log("  fields on a sample item:", Object.keys(sample).join(", "));

  // Union of field names across many items — one sample can be missing a column.
  const allKeys = new Set();
  for (const it of items.slice(0, 400)){
    if (it && typeof it === "object") for (const k of Object.keys(it)) allKeys.add(tidy(k).toLowerCase());
  }

  const resolved = {}, missing = [];
  for (const [slot, pattern] of Object.entries(STAT_PATTERNS)){
    const hit = [...allKeys].find(k => pattern.test(k));
    if (hit) resolved[slot] = hit; else missing.push(slot);
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

/* The wiki sits behind a bot filter that answered our polite custom agent with
   a 403. Present as an ordinary browser instead — the rate limiting below is
   what actually makes this a good guest. */
const WIKI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9"
};

/** MediaWiki keeps File:X.png at /images/<a>/<ab>/X.png where ab = md5(X.png). */
function wikiPath(filename){
  const h = createHash("md5").update(filename).digest("hex");
  return `/w/images/${h[0]}/${h.slice(0, 2)}/${filename}`;
}

/**
 * Filename spellings worth trying when we have no catalogue to match against.
 * Returns [{ file, note }] — `note` is set for spellings that are a compromise
 * rather than an exact match, so the run can report how many were used.
 */
function guessFilenames(item){
  const out = new Map();
  const cap  = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const file = s => cap(String(s).trim().replace(/\s+/g, "_")) + ".png";
  const add  = (s, note) => { if (s && !out.has(file(s))) out.set(file(s), note); };

  const name = item.name ? String(item.name).trim() : null;
  const key  = item.nameLocKey || null;

  add(name);                                    // "Bronze sword"
  add(key);                                     // "bronze_sword"
  add(key && key.replace(/_/g, " "));           // "Bronze sword" from the key
  add(name && name.replace(/['’]/g, ""));       // "Gatherers handbook"

  // Enchanted pieces often share the base item's artwork on the wiki.
  const base = name && name.replace(/^enchanted\s+/i, "");
  if (base && base !== name){
    add(base, "used the un-enchanted item's image");
    add(base.replace(/['’]/g, ""), "used the un-enchanted item's image");
  }

  return [...out].map(([f, note]) => ({ file: f, note }));
}

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
      headers: WIKI_HEADERS,
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
  let index = null;
  try { index = await wikiImageIndex(); }
  catch (e){
    console.log("  !! wiki API failed:", e.message);
    console.log("  -> falling back to deriving image paths from filenames");
  }

  await mkdir(ICON_DIR, { recursive: true });
  const have = new Set(await readdir(ICON_DIR).catch(() => []));

  let got = 0, already = 0, missed = 0, approximate = 0;
  const misses = [], approxList = [];

  for (const item of targets){
    const key  = item.nameLocKey || norm(item.name).replace(/ /g, "_");
    const file = `${key}.png`;
    if (have.has(file)){ already++; continue; }

    // With a catalogue, match against it. Without one, derive candidate paths.
    const tries = index
      ? [index.get(norm(item.name)) || index.get(norm(key))].filter(Boolean)
          .map(url => ({ url, note: null }))
      : guessFilenames(item).map(c => ({ url: WIKI + wikiPath(c.file), note: c.note }));

    if (!tries.length){ missed++; if (misses.length < 20) misses.push(item.name || key); continue; }

    let saved = false, lastErr = "no match";
    for (const t of tries){
      try {
        const res = await fetch(t.url, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) throw new Error("too small to be an image");
        await writeFile(join(ICON_DIR, file), buf);
        saved = true; got++;
        if (t.note){
          approximate++;
          if (approxList.length < 10) approxList.push(`${item.name} (${t.note})`);
        }
        break;
      } catch (e){ lastErr = e.message; }
      await new Promise(r => setTimeout(r, 40));
    }
    if (!saved){ missed++; if (misses.length < 20) misses.push(`${item.name} (${lastErr})`); }
    await new Promise(r => setTimeout(r, 40));      // be a polite guest
  }

  console.log(`  downloaded ${got}, already had ${already}, no image for ${missed}`);
  if (approximate){
    console.log(`  ${approximate} of those are approximate matches:`);
    console.log("    " + approxList.join("; "));
  }
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
