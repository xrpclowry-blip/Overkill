#!/usr/bin/env node
/**
 * Daily snapshot for the Overkill clan dashboard.
 *
 * The Idle Clans API only serves a rolling window — roughly 7 days of
 * experience and 10 days of clan log. This script captures a small slice of
 * that window once a day and appends it to data/history.json, so the dashboard
 * can show trends the API itself cannot answer.
 *
 * No dependencies. Node 18+ (built-in fetch).
 *
 *   node scripts/snapshot.mjs            # append today's snapshot
 *   CLAN=SomeOtherClan node scripts/snapshot.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/history.json");

const CLAN = process.env.CLAN || "Overkill";
const API = process.env.API_BASE || "https://query.idleclans.com";
const KEEP = Number(process.env.KEEP || 800);   // ~2 years of daily snapshots
const BOARD_LIMIT = 200;

/* Cumulative xp required for each level, from the Idle Clans xp table. */
const XP_TABLE = [
  0,75,151,227,303,380,531,683,836,988,1141,1294,1447,1751,2054,2358,2663,2967,
  3272,3577,4182,4788,5393,5999,6606,7212,7819,9026,10233,11441,12648,13856,15065,
  16273,18682,21091,23500,25910,28319,30729,33140,37950,42761,47572,52383,57195,
  62006,66818,76431,86043,95656,105269,114882,124496,134109,153323,172538,191752,
  210967,230182,249397,268613,307028,345444,383861,422277,460694,499111,537528,
  614346,691163,767981,844800,921618,998437,1075256,1228875,1382495,1536114,
  1689734,1843355,1996975,2150596,2457817,2765038,3072260,3379481,3686703,3993926,
  4301148,4915571,5529994,6144417,6758841,7373264,7987688,8602113,9830937,11059762,
  12288587,13517412,14746238,15975063,17203889,19661516,22119142,24576769,27034396,
  29492023,31949651,34407278,39322506,44237735,49152963,54068192,58983421,63898650,
  68813880,78644309,88474739
];

function levelFromXp(xp){
  if (!(xp > 0)) return 1;
  let lo = 1, hi = XP_TABLE.length;
  while (lo < hi){
    const mid = (lo + hi + 1) >> 1;
    if (xp >= XP_TABLE[mid - 1]) lo = mid; else hi = mid - 1;
  }
  return lo;
}

async function get(path, { optional = false } = {}){
  for (let attempt = 1; attempt <= 3; attempt++){
    try {
      const res = await fetch(API + path, {
        headers: { Accept: "application/json", "User-Agent": "overkill-dashboard-snapshot" },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err){
      if (attempt === 3){
        if (optional){ console.warn(`  ! skipped ${path}: ${err.message}`); return null; }
        throw new Error(`${path} failed after 3 attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

async function pooled(items, worker, limit = 4){
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true){
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i]); } catch { out[i] = null; }
    }
  }));
  return out;
}

async function main(){
  console.log(`Snapshotting ${CLAN}…`);

  const clan = await get(`/api/Clan/recruitment/${encodeURIComponent(CLAN)}`);
  const names = (clan.memberlist || []).map(m => m.memberName);
  console.log(`  ${names.length} members`);

  const [xp168, board, cup, profiles] = await Promise.all([
    get(`/api/Clan/${encodeURIComponent(CLAN)}/experience?hours=168`, { optional:true }),
    get(`/api/Clan/experience/top?hours=168&limit=${BOARD_LIMIT}`, { optional:true }),
    get(`/api/ClanCup/standings/${encodeURIComponent(CLAN)}?gameMode=default`, { optional:true }),
    pooled(names, n => get(`/api/Player/profile/${encodeURIComponent(n)}`, { optional:true }))
  ]);

  const gained = new Map(((xp168 && xp168.playerContributions) || []).map(p => [p.username, p.totalExperience]));

  const members = names.map((name, i) => {
    const prof = profiles[i];
    if (!prof) return { name, missing:true };
    const sx = prof.skillExperiences || {};
    let totalLevel = 0, totalXp = 0;
    for (const v of Object.values(sx)){
      const xp = Number(v) || 0;
      totalXp += xp;
      totalLevel += levelFromXp(xp);
    }
    return {
      name,
      totalLevel,
      totalXp: Math.round(totalXp),
      xp7d: Math.round(gained.get(name) || 0),
      credits: prof.creditsAcquiredForClan || 0,
      hoursOffline: Math.round(prof.hoursOffline || 0)
    };
  });

  const worldRank = board
    ? (board.findIndex(c => (c.clanName || "").toLowerCase() === CLAN.toLowerCase()) + 1) || null
    : null;

  const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    capturedAt: new Date().toISOString(),
    clanXp7d: xp168 ? Math.round(xp168.totalExperience) : null,
    worldRank,
    boardDepth: board ? board.length : null,
    activityScore: clan.activityScore ?? null,
    memberCount: names.length,
    members,
    cup: (cup || []).map(o => ({
      objective: o.objective,
      rank: o.rank ?? null,
      score: o.score ?? null,
      bestTimeMs: o.bestTime ? o.bestTime.time : null
    }))
  };

  let history = { clan: CLAN, snapshots: [] };
  try {
    const existing = JSON.parse(await readFile(OUT, "utf8"));
    if (existing && Array.isArray(existing.snapshots)) history = existing;
  } catch { /* first run */ }

  // One snapshot per calendar day; a re-run replaces the day rather than duplicating it.
  history.clan = CLAN;
  history.snapshots = history.snapshots.filter(s => s.date !== snapshot.date);
  history.snapshots.push(snapshot);
  history.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (history.snapshots.length > KEEP) history.snapshots = history.snapshots.slice(-KEEP);
  history.updatedAt = new Date().toISOString();

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(history) + "\n");

  console.log(`  world rank ${worldRank ?? "unranked"} · 7d xp ${snapshot.clanXp7d ?? "?"}`);
  console.log(`  wrote ${history.snapshots.length} snapshot(s) to data/history.json`);
}

main().catch(err => { console.error("Snapshot failed:", err.message); process.exit(1); });
