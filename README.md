# Overkill — Idle Clans clan dashboard

A live dashboard for the **Overkill** clan, built on the [Idle Clans public API](https://query.idleclans.com/api-docs).
Everything is one self-contained `index.html` — no build step, no framework, no dependencies.

The optional daily snapshot job gives it something the API cannot: memory.

---

## What's in here

```
index.html                        the whole dashboard
data/history.json                 daily snapshots (written by the job below)
scripts/snapshot.mjs              captures one snapshot; plain Node, no deps
.github/workflows/snapshot.yml    runs the script once a day and commits the result
```

## Tabs

| Tab | What it shows |
|---|---|
| **Overview** | Who's online now, Clan Cup trophies, world rank, weekly experience, roster health |
| **Member roll** | Sortable roster — total level, combat levels, 7d/24h xp, credits, vault, last seen. Click anyone for their 21 skills and a personal xp chart |
| **XP race** | 24h / 7d leaderboard, filterable by skill, with idle members named |
| **Clan Cup** | All 32 objectives with score and world rank, podium placings, and where climbing is cheapest |
| **Rankings** | World rank, per-skill clan rankings, and side-by-side comparison against rival clans |
| **Vault** | Deposits and withdrawals priced at live player-market rates, per member and per item |
| **Trends** | Appears once `data/history.json` has snapshots — long-term xp, rank and member growth |
| **Activity log** | The raw clan feed, filterable by type and member |

---

## Setting up the daily snapshot

The API only serves a rolling window: about 7 days of experience and 10 days of clan log.
Without snapshots, the dashboard can never answer "how did we do last month?"

The workflow in `.github/workflows/snapshot.yml` runs `scripts/snapshot.mjs` once a day at
07:10 UTC, and commits the result back to this repo. Each snapshot is about 5 KB, so a
year of history is under 2 MB.

**One setting to check after your first push.** GitHub Actions cannot push to your repo
unless you allow it:

1. Repo → **Settings** → **Actions** → **General**
2. Scroll to **Workflow permissions**
3. Select **Read and write permissions** → **Save**

**To confirm it works**, don't wait a day: repo → **Actions** → **Daily clan snapshot** →
**Run workflow**. It finishes in under a minute, and you should see a new commit named
`Snapshot 2026-09-02`.

The Trends tab stays hidden until at least one snapshot exists, and gets more useful the
longer it runs. Two weeks in, it starts telling you things nothing else can.

### Running it by hand

```bash
node scripts/snapshot.mjs           # needs Node 18+
CLAN=SomeOtherClan node scripts/snapshot.mjs
```

---

## Pointing it at a different clan

Two places, both near the top of their file:

- `index.html` — the `CLAN` constant in the first `<script>` block
- `.github/workflows/snapshot.yml` — the `CLAN:` environment variable

---

## Notes on the data

- **Levels** come from the Idle Clans experience table, which is not RuneScape's. Level 120
  is 88,474,739 xp.
- **Attack** is called `Rigour` by the clan-experience endpoints — an internal asset name.
  The dashboard translates it back; `wire` in the skill list is where that mapping lives.
- **The vault** is a record, not a bill. There are no tithe or arrears columns, by design.
  Gold deposits do not appear in the clan log at all, so item value at market price is the
  closest available measure.
- **Clan log depth** caps at roughly 1,000 entries, which for Overkill is about 10 days.
- **Unpriced items** are counted by quantity and valued at zero; the dashboard says so in a
  banner rather than quietly under-reporting.

## Credits

Data from the Idle Clans public API. Unofficial and read-only — this dashboard cannot
change anything in game.
