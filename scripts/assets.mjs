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
const OUT_UPGRADES = resolve(ROOT, "data/upgrades.json");
const OUT_TASKS    = resolve(ROOT, "data/tasks.json");
const OUT_NAMES    = resolve(ROOT, "data/item-names.json");

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

async function extractStats(game){
  let items;
  if (game && game.__rawText){
    console.log(`  scanning ${game.__rawText.length} chars for item objects…`);
    items = harvestItems(game.__rawText);
    console.log(`  harvested ${items.length} objects with combat bonuses`);
    if (!items.length) items = null;
  } else {
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

/** The one place the icon filename is decided. Both the fetcher and the name
    map call this, so data/icons/<key>.png always matches what the page asks for. */
const iconKeyFor = item =>
  String(item.nameLocKey || item.NameLocKey ||
         norm(item.name ?? item.Name).replace(/ /g, "_"));

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

  /* Every item, not just equipment. The first version fetched gear only, which
     is why the market and skilling panels — ores, bars, fish, potions, seeds,
     none of them wearable — showed names with no picture beside them. */
  const targets = list;
  console.log(`  ${list.length} items (${gear.length} of them equippable)`);

  /* The name map is written from THIS list rather than the game-data dump.
     Metadata carries a real display name ("Otherworldly gloves") where the
     dump often carries only a loc key, and its nameLocKey is the exact
     filename the loop below saves an icon under — so the page can never ask
     for a key the fetcher didn't use. Written before any wiki call, so a
     403 up there still leaves the page with names. */
  const names = {};
  for (const item of list){
    const id = item.id ?? item.Id ?? item.itemId;
    if (id == null) continue;
    const display = item.name ?? item.Name;
    if (!display) continue;
    names[id] = [String(display), iconKeyFor(item)];
  }
  await mkdir(dirname(OUT_NAMES), { recursive: true });
  await writeFile(OUT_NAMES, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: Object.keys(names).length,
    items: names
  }) + "\n");
  console.log(`  wrote data/item-names.json — ${Object.keys(names).length} names, ` +
              `~${(JSON.stringify(names).length / 1024).toFixed(0)}KB`);

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
    const key  = iconKeyFor(item);
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

/* ------------------------------------------------------------------ */
/* Upgrades                                                            */
/* ------------------------------------------------------------------ */

/* Field names confirmed against the live payload, not guessed:
     Type              — the identifier, and what the player profile keys match
     Tiers             — the ceiling (Keep It Spacious is 190 of them)
     TierNameLocKeys   — per-tier names; [0] is a fallback identifier
     Discontinued      — removed from the game; never list it as "missing"
     IsClanUpgrade     — bought by the clan, not the player                     */
const NAME_FIELDS = ["type", "name", "displayname", "title", "upgradetype",
                     "namelocalizationkey", "namelockey", "localizationkey"];
const MAX_FIELDS  = ["tiers", "maxlevel", "maxtier", "maxupgradelevel", "maxlevels",
                     "levels", "maxrank", "maxamount", "maxcount"];
/* Arrays whose length IS the number of levels, when no explicit max exists. */
const LEVEL_ARRAYS = ["tiers", "costs", "tiernamelockeys", "tierdescriptionlockeys",
                      "tierunlocks", "itemcosts", "levels", "upgradelevels",
                      "levelcosts", "requirements", "prices"];
/* The game groups upgrades (Skilling / Combat / Pets) and shows a description
   for each; carry both through when the data has them. */
const CAT_FIELDS  = ["category", "upgradecategory", "group", "type", "section"];
const DESC_FIELDS = ["description", "descriptionlocalizationkey", "desclockey",
                     "tooltip", "effect"];

/** The member profile spells these many ways; reduce both sides to one form. */
export function upgradeKey(raw){
  return String(raw || "")
    .replace(/^upgrade[_\s-]*/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** "keepItSpacious" / "Upgrade_bloodmoon_preparation" -> "Keep it spacious" */
export function upgradeTitle(raw){
  const words = String(raw || "")
    .replace(/^upgrade[_\s-]*/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

function pick(map, names){
  for (const n of names) if (map.has(n)) return map.get(n);
  return undefined;
}

async function extractUpgrades(game){
  console.log("\nExtracting upgrade definitions…");
  if (!game || game.__rawText){
    console.log("  !! game data did not parse; cannot read upgrades this run.");
    return null;
  }

  // Find the section, then descend to the actual list inside it. The payload
  // wraps collections one level down — Upgrades is { Id, Items: [...] }, the
  // same shape as Items — so iterating the wrapper yields "Id" and "Items"
  // as if they were upgrades, which is exactly what went wrong first time.
  let section = null, where = null;
  for (const [k, v] of Object.entries(game)){
    if (/upgrade/i.test(k) && v && typeof v === "object"){ section = v; where = k; break; }
  }
  if (!section){ console.log("  !! no top-level key matching /upgrade/i."); return null; }

  const isObj = v => v && typeof v === "object" && !Array.isArray(v);

  /** Largest array of objects anywhere in this subtree — that's the list. */
  function biggestList(node, path, seen = new Set()){
    let best = null;
    const walk = (n, p) => {
      if (!n || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)){
        const objs = n.filter(isObj).length;
        if (objs && (!best || objs > best.n)) best = { list:n, path:p, n:objs };
        n.forEach((v, i) => { if (i < 50) walk(v, `${p}[${i}]`); });
        return;
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${p}.${k}`);
    };
    walk(node, path);
    return best;
  }

  let entries, shape;
  const list = biggestList(section, "$." + where);
  if (list && list.n >= 3){
    entries = list.list.map((v, i) => [null, v, i]);
    shape = `array at ${list.path}`;
  } else if (isObj(section)){
    entries = Object.entries(section).map(([k, v]) => [k, v, null]);
    shape = "map of key -> definition";
  } else {
    console.log("  !! could not find a list of upgrades inside", where);
    return null;
  }
  console.log(`  ${where}: ${shape}, ${entries.length} entries`);

  const firstObj = entries.find(([, v]) => isObj(v));
  if (firstObj) console.log("  fields on a sample entry:", Object.keys(firstObj[1]).join(", "));
  else console.log("  sample entry:", JSON.stringify(entries[0] && entries[0][1]).slice(0, 200));

  /* Print entries verbatim. Guessing at this shape from field names alone has
     now failed three times; a couple of real rows settles it in one run.
     Long arrays are summarised so the log stays readable. */
  const preview = v => JSON.stringify(v, (k, val) =>
    Array.isArray(val) && val.length > 4
      ? `[${val.length} items: ${JSON.stringify(val.slice(0, 3))}…]`
      : val);
  entries.slice(0, 3).forEach(([, v], i) => {
    if (isObj(v)) console.log(`  ENTRY ${i}: ${preview(v).slice(0, 900)}`);
  });

  const out = {};
  let withMax = 0, noMax = 0, flavourOnly = 0;
  const flavourSamples = [];
  const unresolved = [];

  /* Loc keys arrive per tier: "keep_it_spacious_tier_1" names one tier, not the
     upgrade. Strip the tier suffix so the whole thing reads as one upgrade. */
  /* Tier loc keys come in two flavours:
       "toolbelt_upgrade_tier_1_name"  -> the upgrade's own name, decorated
       "cardboard_box"                 -> flavour text for that tier only
     Strip the decoration; the second kind is unusable as identity and is
     reported rather than trusted. */
  const stripTier = t => String(t)
    .replace(/[_\s-]*(name|title|label)$/i, "")
    .replace(/[_\s-]*tier[_\s-]*\d+$/i, "")
    .replace(/[_\s-]\d+$/, "");
  const decorated = t => /[_\s-]*tier[_\s-]*\d+([_\s-]*(name|title|label))?$/i.test(String(t));

  const longest = (...arrays) => arrays.reduce(
    (n, a) => Array.isArray(a) && a.length > n ? a.length : n, 0);

  for (const [key, val] of entries){
    let name = key, max = null, disc = false, clan = false, desc = null;

    if (val && typeof val === "object" && !Array.isArray(val)){
      const m = new Map(Object.entries(val).map(([k, v]) => [k.toLowerCase(), v]));

      // Identity: Type is the join key the player profile uses.
      const type = m.get("type");
      const locs = m.get("tiernamelockeys");
      if (typeof type === "string" && type.trim()) name = type;
      // Only trust a tier loc key when it's decorated with a tier marker —
      // otherwise it's this tier's flavour name ("Cardboard box" is Housing
      // tier 1), which would file the upgrade under the wrong identity.
      else if (Array.isArray(locs) && typeof locs[0] === "string" && decorated(locs[0]))
        name = stripTier(locs[0]);
      else if (Array.isArray(locs) && typeof locs[0] === "string"){
        flavourOnly++;
        if (flavourSamples.length < 6) flavourSamples.push(locs[0]);
      }
      else if (Number.isFinite(Number(type)) && Array.isArray(locs) && typeof locs[0] === "string")
        name = stripTier(locs[0]);
      else if (key) name = key;

      // Ceiling: an explicit count, else however many tiers are described.
      const tiers = m.get("tiers");
      if (!Array.isArray(tiers) && Number.isFinite(Number(tiers)) && Number(tiers) > 0){
        max = Number(tiers);
      } else {
        const n = longest(tiers, m.get("costs"), m.get("tiernamelockeys"),
                          m.get("tierunlocks"), m.get("tierdescriptionlockeys"), m.get("itemcosts"));
        if (n > 0) max = n;
      }

      disc = m.get("discontinued") === true;
      clan = m.get("isclanupgrade") === true;

      const dl = m.get("tierdescriptionlockeys");
      if (Array.isArray(dl) && typeof dl[0] === "string" && /\s/.test(dl[0])) desc = dl[0];
      const cat = pick(m, CAT_FIELDS);
      if (typeof cat === "string" && cat) desc = desc || null;
    } else if (Number.isFinite(Number(val))){
      max = Number(val);
    } else if (Array.isArray(val)){
      max = val.length;
    }

    const id = upgradeKey(name || key);
    if (!id) continue;
    out[id] = { name: upgradeTitle(name || key) };
    if (max != null && max > 0){ out[id].max = max; withMax++; }
    else { noMax++; if (unresolved.length < 12) unresolved.push(String(name || key)); }
    if (disc) out[id].disc = true;
    if (clan) out[id].clan = true;
    if (desc) out[id].desc = desc;
  }

  console.log(`  ${withMax} with a max level, ${noMax} without`);
  if (flavourOnly) console.log(`  ${flavourOnly} had only per-tier flavour names, no usable identity: ${
    flavourSamples.join(", ")}`);
  if (unresolved.length) console.log("  no max found for:", unresolved.join(", "));
  const sample = Object.entries(out).slice(0, 6)
    .map(([k, v]) => `${k}${v.max ? "/" + v.max : " (no max)"}`).join(", ");
  console.log("  sample of what was written:", sample);
  const vals = Object.values(out);
  console.log(`  ${vals.filter(v => v.disc).length} discontinued, ${
    vals.filter(v => v.clan).length} are clan upgrades`);
  const first = entries.find(([, v]) => isObj(v));
  if (first){
    const v = first[1];
    console.log("  sample entry values: Type=" + JSON.stringify(v.Type) +
      " Tiers=" + JSON.stringify(Array.isArray(v.Tiers) ? `[${v.Tiers.length}]` : v.Tiers) +
      " Costs=" + (Array.isArray(v.Costs) ? `[${v.Costs.length}]` : JSON.stringify(v.Costs)) +
      " TierNameLocKeys[0]=" + JSON.stringify(Array.isArray(v.TierNameLocKeys) ? v.TierNameLocKeys[0] : undefined));
  }

  await mkdir(dirname(OUT_UPGRADES), { recursive: true });
  await writeFile(OUT_UPGRADES, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: where,
    count: Object.keys(out).length,
    upgrades: out
  }) + "\n");
  console.log(`  wrote data/upgrades.json — ${Object.keys(out).length} upgrades`);
  return withMax;
}

/* ------------------------------------------------------------------ */
/* Skill icons                                                         */
/* ------------------------------------------------------------------ */

/* The wiki files them under the game's internal asset names, which match the
   display names for every skill except attack, stored as "Rigour". */
const SKILL_ICONS = [
  ["attack","Rigour"], ["strength","Strength"], ["defence","Defence"],
  ["archery","Archery"], ["magic","Magic"], ["health","Health"],
  ["woodcutting","Woodcutting"], ["carpentry","Carpentry"], ["fishing","Fishing"],
  ["cooking","Cooking"], ["mining","Mining"], ["smithing","Smithing"],
  ["foraging","Foraging"], ["farming","Farming"], ["crafting","Crafting"],
  ["agility","Agility"], ["plundering","Plundering"], ["enchanting","Enchanting"],
  ["brewing","Brewing"], ["exterminating","Exterminating"], ["invocation","Invocation"]
];

async function fetchSkillIcons(){
  console.log("\nFetching skill icons…");
  await mkdir(ICON_DIR, { recursive: true });
  const have = new Set(await readdir(ICON_DIR).catch(() => []));

  let got = 0, already = 0;
  const missed = [];

  for (const [key, asset] of SKILL_ICONS){
    const file = `skill-${key}.png`;
    if (have.has(file)){ already++; continue; }

    // The asset name first, then the display name, then a lowercase variant.
    const names = [...new Set([`${asset}.png`, `${asset}_icon.png`,
      `${key[0].toUpperCase() + key.slice(1)}.png`])];
    let saved = false;
    for (const n of names){
      try {
        const res = await fetch(WIKI + wikiPath(n), { headers: WIKI_HEADERS,
          signal: AbortSignal.timeout(20000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) continue;
        await writeFile(join(ICON_DIR, file), buf);
        saved = true; got++;
        break;
      } catch { /* next spelling */ }
      await new Promise(r => setTimeout(r, 60));
    }
    if (!saved) missed.push(key);
  }

  console.log(`  downloaded ${got}, already had ${already}, no image for ${missed.length}`);
  if (missed.length) console.log("  no icon for:", missed.join(", "));
  return got + already;
}

/* ------------------------------------------------------------------ */
/* Skilling tasks                                                      */
/* ------------------------------------------------------------------ */

/* Everything a profit calculator needs is already in the payload: how long an
   action takes, what it consumes, what it produces. It is only unreachable
   from a browser because the whole document is megabytes — so we lift the few
   fields that matter into a small file, the same way we did item stats.

   Combat sits in the same Tasks section and is filtered out by looking for the
   enemy fields rather than by naming skills, so a new combat skill doesn't
   quietly appear in a list of things to smelt. */
const COMBAT_MARKERS = ["enemyhealth", "enemyattackinterval", "isboss", "isclanboss"];

function isCombatTask(t){
  const m = new Map(Object.entries(t).map(([k, v]) => [k.toLowerCase(), v]));
  if (m.get("isboss") === true || m.get("isclanboss") === true) return true;
  for (const key of COMBAT_MARKERS){
    const v = Number(m.get(key));
    if (Number.isFinite(v) && v > 0) return true;
  }
  return false;
}

/* This payload wraps its collections, and not consistently:
     Items    -> { Items: [ … ] }
     Upgrades -> { Id, Items: [ … ] }
     Tasks.X  -> [ { _id, Items: [ … ] } ]      <- an ARRAY holding the wrapper
   And a skill's tasks are split across TABS, each its own list: Smithing holds
   Smelting, Bronze, Iron … Diamond separately, so taking only the biggest kept
   twelve bars and threw away every piece of jewellery. Collect them ALL. */
function collectLists(node, looksRight, depth = 0, found = []){
  if (!node || typeof node !== "object" || depth > 6) return found;
  if (Array.isArray(node)){
    if (node.some(looksRight)) found.push(node);
    for (const v of node.slice(0, 80)) collectLists(v, looksRight, depth + 1, found);
    return found;
  }
  for (const v of Object.values(node)) collectLists(v, looksRight, depth + 1, found);
  return found;
}

const looksLikeTask = v => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).some(k => /^(basetime|itemreward|taskid|expreward)$/i.test(k.replace(/\s+/g, "")));

/** Costs arrive in a few shapes; normalise to [[itemId, amount], …]. */
function readCosts(raw){
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw){
    if (!c || typeof c !== "object") continue;
    const m = new Map(Object.entries(c).map(([k, v]) => [k.toLowerCase(), v]));
    const id  = Number(m.get("item") ?? m.get("itemid") ?? m.get("id"));
    const amt = Number(m.get("amount") ?? m.get("count") ?? m.get("quantity") ?? 1);
    if (Number.isFinite(id) && id > 0 && Number.isFinite(amt) && amt > 0) out.push([id, amt]);
  }
  return out;
}

async function extractTasks(game){
  console.log("\nExtracting skilling tasks…");
  if (!game || game.__rawText){
    console.log("  !! game data did not parse; cannot read tasks this run.");
    return null;
  }
  const tasksNode = game.Tasks || game.tasks;
  if (!tasksNode || typeof tasksNode !== "object"){
    console.log("  !! no top-level Tasks section.");
    return null;
  }

  const skills = Object.keys(tasksNode);
  console.log(`  Tasks has ${skills.length} sections: ${skills.join(", ")}`);

  const out = {};
  const skipped = {};                 // one example per skill, for diagnosis
  let kept = 0, combat = 0, noOutput = 0;

  for (const [skill, listRaw] of Object.entries(tasksNode)){
    const lists = collectLists(listRaw, looksLikeTask);
    if (!lists.length){ console.log(`  ${skill}: no task-shaped list found, skipped`); continue; }

    /* One skill can hold many lists (one per tab). Merge them, and de-duplicate
       in case a list is reachable by more than one path through the wrappers. */
    const seenTask = new Set();
    const list = [];
    for (const arr of lists){
      for (const t of arr){
        if (!looksLikeTask(t)) continue;
        const key = `${t.TaskId ?? t.taskId ?? "?"}|${t.Name ?? t.name ?? "?"}`;
        if (seenTask.has(key)) continue;
        seenTask.add(key);
        list.push(t);
      }
    }

    const rows = [];
    for (const t of list){
      if (!t || typeof t !== "object") continue;
      const m = new Map(Object.entries(t).map(([k, v]) => [k.toLowerCase(), v]));
      if (isCombatTask(t)){ combat++; continue; }
      if (m.get("disabled") === true) continue;

      const outId  = Number(m.get("itemreward"));
      const outAmt = Number(m.get("itemamount"));
      const base   = Number(m.get("basetime"));
      if (!Number.isFinite(outId) || outId <= 0){
        noOutput++;
        /* Six whole skills vanished through this branch — Farming, Carpentry,
           Foraging, Brewing, Enchanting, Plundering — yet a Farming task
           plainly yields five potatoes. They must record their output under a
           field this doesn't know about, so show one rather than guess. */
        if (!skipped[skill]) skipped[skill] = t;
        continue;
      }

      rows.push({
        name:  String(m.get("name") ?? ""),
        lvl:   Number(m.get("levelrequirement")) || 0,
        ms:    Number.isFinite(base) ? base : 0,
        xp:    Number(m.get("expreward")) || 0,
        out:   outId,
        n:     Number.isFinite(outAmt) && outAmt > 0 ? outAmt : 1,
        costs: readCosts(m.get("costs")),
        hidden: m.get("hidden") === true ? 1 : undefined
      });
      kept++;
    }
    if (rows.length){
      out[skill] = rows;
      const withCost = rows.filter(r => r.costs.length).length;
      const instant  = rows.filter(r => !r.ms).length;
      console.log(`  ${skill}: ${rows.length} tasks from ${lists.length} list(s) · ` +
                  `${withCost} consume materials` +
                  (instant ? ` · ${instant} instant (no processing time)` : ""));
    }
  }

  console.log(`  kept ${kept}, skipped ${combat} combat and ${noOutput} with no item output`);

  /* Print a real example from each skill that produced nothing, trimmed of the
     dozens of zeroed combat fields every task carries. */
  const interesting = ([k, v]) =>
    !/^(enemy|secondaryattack|invocationdata|previousattack|usedattack|attackstyle|pvmstat|isboss|isclanboss|canbeteamed|amountoftargets|enableprotections|weapontype|customicon|identifiabletype|triggermilestone|builtstorage|descriptionlockey|additionallevel|magiclevelrequirement|scrolltype|basesuccess|canreceive|affectedby|custompet)/i.test(k)
    && v !== 0 && v !== "" && v !== false && v !== null;
  for (const [skill, t] of Object.entries(skipped)){
    const shown = Object.fromEntries(Object.entries(t).filter(interesting));
    console.log(`  SKIPPED ${skill}: ${JSON.stringify(shown).slice(0, 400)}`);
  }
  const sample = Object.values(out)[0] && Object.values(out)[0][0];
  if (sample) console.log("  sample:", JSON.stringify(sample));

  await mkdir(dirname(OUT_TASKS), { recursive: true });
  await writeFile(OUT_TASKS, JSON.stringify({
    generatedAt: new Date().toISOString(),
    skills: Object.keys(out).length,
    taskCount: kept,
    tasks: out
  }) + "\n");
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`  wrote data/tasks.json — ${Object.keys(out).length} skills, ${kept} tasks, ~${kb}KB`);
  return kept;
}

async function main(){
  const needGame = !process.env.SKIP_STATS || !process.env.SKIP_UPGRADES;
  let game = null;
  if (needGame){
    console.log("Fetching game data (this is the big one)…");
    game = await get("/api/Configuration/game-data");
    describe(game, "game-data");
  }

  const stats = process.env.SKIP_STATS    ? null : await extractStats(game);
  const ups   = process.env.SKIP_UPGRADES ? null : await extractUpgrades(game);
  const tasks = process.env.SKIP_TASKS    ? null : await extractTasks(game);
  const icons = process.env.SKIP_ICONS    ? null : await fetchIcons();
  const sicons = process.env.SKIP_ICONS   ? null : await fetchSkillIcons();

  console.log("\nDone.");
  if (stats != null) console.log(`  ${stats} items have combat bonuses`);
  if (ups   != null) console.log(`  ${ups} upgrades with a known maximum`);
  if (tasks != null) console.log(`  ${tasks} skilling tasks`);
  if (icons != null) console.log(`  ${icons} item icons available`);
  if (sicons != null) console.log(`  ${sicons} of ${SKILL_ICONS.length} skill icons available`);
  console.log("  Commit data/ and the dashboard picks it all up.");
}

main().catch(err => { console.error("Asset build failed:", err.message); process.exit(1); });
