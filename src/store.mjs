// 状态库：node:sqlite。表的用途见 docs/design.md“状态库”。

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  key TEXT PRIMARY KEY,
  aliases TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artist_ids (
  artist_key TEXT NOT NULL,
  source TEXT NOT NULL,
  platform_id TEXT,
  platform_name TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (artist_key, source)
);
CREATE TABLE IF NOT EXISTS artist_sources (
  artist_key TEXT NOT NULL,
  source TEXT NOT NULL,
  baseline_at INTEGER NOT NULL,
  PRIMARY KEY (artist_key, source)
);
CREATE TABLE IF NOT EXISTS listings (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  data TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  missing_runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, source_id, artist_key)
);
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_key TEXT NOT NULL,
  city TEXT,
  venue TEXT,
  date_start TEXT,
  date_end TEXT,
  title TEXT NOT NULL DEFAULT '',
  is_mixed INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  ever_sold INTEGER NOT NULL DEFAULT 0,
  next_sale_at INTEGER,
  announced_sale_at INTEGER,
  withdraw_runs INTEGER NOT NULL DEFAULT 0,
  known_sale_times TEXT NOT NULL DEFAULT '[]',
  reached TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shows_artist ON shows (artist_key);
CREATE TABLE IF NOT EXISTS show_listings (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  show_id INTEGER NOT NULL,
  PRIMARY KEY (source, source_id, artist_key)
);
CREATE INDEX IF NOT EXISTS show_listings_show ON show_listings (show_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  artist_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  sale_at INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}',
  silent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  UNIQUE (show_id, kind, round, sale_at)
);
CREATE TABLE IF NOT EXISTS reminders (
  show_id INTEGER NOT NULL,
  sale_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (show_id, sale_at)
);
CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_ok_at INTEGER,
  last_error TEXT,
  fail_runs INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  stats TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  migrate(db)
  const q = (sql) => db.prepare(sql)

  const store = {
    db,
    close: () => db.close(),

    transaction(fn) {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    // 值一律存成字符串：对象存 JSON，读回来是 JSON 字符串，由用的地方自己解析
    kv: {
      get: (key) => q('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null,
      set: (key, value) =>
        q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          key,
          value == null ? null : typeof value === 'string' ? value : JSON.stringify(value),
        ),
    },

    // —— 艺人 ——

    /**
     * 按清单同步。清单里没有了的停用，不删记录；还没推出去的消息作废。
     * 停用的又加回来，按新关注处理：清掉建底记录，下一轮重新建底、发汇总。
     * 别名变了，还没找到 ID 的平台下一轮用新别名重找；找到了的不动。
     */
    syncArtists(list, now) {
      const keys = new Set(list.map((a) => a.key))
      for (const a of list) {
        const aliases = JSON.stringify(a.aliases ?? [])
        const old = q('SELECT aliases, active FROM artists WHERE key = ?').get(a.key)
        if (!old) {
          q('INSERT INTO artists (key, aliases, active, added_at) VALUES (?, ?, 1, ?)').run(a.key, aliases, now)
          continue
        }
        if (!old.active) {
          q('DELETE FROM artist_sources WHERE artist_key = ?').run(a.key)
          q('UPDATE artists SET added_at = ? WHERE key = ?').run(now, a.key)
        }
        if (old.aliases !== aliases) q('DELETE FROM artist_ids WHERE artist_key = ? AND platform_id IS NULL').run(a.key)
        q('UPDATE artists SET aliases = ?, active = 1 WHERE key = ?').run(aliases, a.key)
      }
      for (const row of q('SELECT key FROM artists WHERE active = 1').all()) {
        if (keys.has(row.key)) continue
        q('UPDATE artists SET active = 0 WHERE key = ?').run(row.key)
        q('UPDATE events SET notified_at = ? WHERE artist_key = ? AND notified_at IS NULL').run(now, row.key)
      }
    },

    /** 状态库里出现过的艺人主名，包括取消关注的。 */
    knownArtistKeys: () => new Set(q('SELECT key FROM artists').all().map((r) => r.key)),

    /** 在用的艺人，带上各平台 ID 和找 ID 的时间。 */
    activeArtists() {
      return q('SELECT key, aliases, added_at FROM artists WHERE active = 1 ORDER BY added_at, key').all().map((row) => {
        const ids = {}
        const idsCheckedAt = {}
        const idNames = {}
        for (const r of q('SELECT source, platform_id, platform_name, checked_at FROM artist_ids WHERE artist_key = ?').all(row.key)) {
          ids[r.source] = r.platform_id ?? undefined
          idNames[r.source] = r.platform_name ?? undefined
          idsCheckedAt[r.source] = r.checked_at
        }
        return { key: row.key, aliases: JSON.parse(row.aliases), addedAt: row.added_at, ids, idNames, idsCheckedAt }
      })
    },

    setArtistId(artistKey, source, found, now) {
      q(`INSERT INTO artist_ids (artist_key, source, platform_id, platform_name, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(artist_key, source) DO UPDATE SET platform_id = excluded.platform_id, platform_name = excluded.platform_name, checked_at = excluded.checked_at`).run(
        artistKey,
        source,
        found?.id != null ? String(found.id) : null,
        found?.name ?? null,
        now,
      )
    },

    isBaselined: (artistKey, source) => Boolean(q('SELECT 1 FROM artist_sources WHERE artist_key = ? AND source = ?').get(artistKey, source)),
    hasAnyBaseline: (artistKey) => Boolean(q('SELECT 1 FROM artist_sources WHERE artist_key = ?').get(artistKey)),
    markBaselined: (artistKey, source, now) =>
      q('INSERT OR IGNORE INTO artist_sources (artist_key, source, baseline_at) VALUES (?, ?, ?)').run(artistKey, source, now),
    baselinedSources: (artistKey) => q('SELECT source FROM artist_sources WHERE artist_key = ?').all(artistKey).map((r) => r.source),

    // —— 统一记录 ——

    getListing(source, sourceId, artistKey) {
      const row = q('SELECT * FROM listings WHERE source = ? AND source_id = ? AND artist_key = ?').get(source, String(sourceId), artistKey)
      return row ? rowToListing(row) : null
    },

    /** 存这一轮取到的记录，返回上一轮的那份（没有为 null）。 */
    upsertListing(listing, now) {
      const prev = store.getListing(listing.source, listing.sourceId, listing.artistKey)
      q(`INSERT INTO listings (source, source_id, artist_key, data, first_seen, last_seen, missing_runs) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(source, source_id, artist_key) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen, missing_runs = 0`).run(
        listing.source,
        listing.sourceId,
        listing.artistKey,
        JSON.stringify(listing),
        now,
        now,
      )
      return prev
    },

    /** 这一轮这位艺人在这个数据源上没再出现的售票记录，缺席轮数加 1。 */
    markMissing(artistKey, source, seenIds) {
      const seen = new Set(seenIds.map(String))
      for (const row of q('SELECT source_id, data FROM listings WHERE artist_key = ? AND source = ?').all(artistKey, source)) {
        if (seen.has(row.source_id)) continue
        if (JSON.parse(row.data).kind !== 'ticket') continue
        q('UPDATE listings SET missing_runs = missing_runs + 1 WHERE artist_key = ? AND source = ? AND source_id = ?').run(artistKey, source, row.source_id)
      }
    },

    // —— 演出 ——

    showIdForListing: (l) => q('SELECT show_id FROM show_listings WHERE source = ? AND source_id = ? AND artist_key = ?').get(l.source, l.sourceId, l.artistKey)?.show_id ?? null,

    linkListing: (showId, l) =>
      q('INSERT OR IGNORE INTO show_listings (source, source_id, artist_key, show_id) VALUES (?, ?, ?, ?)').run(l.source, l.sourceId, l.artistKey, showId),

    createShow(fields, now) {
      const r = q(`INSERT INTO shows (artist_key, city, venue, date_start, date_end, title, is_mixed, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        fields.artistKey,
        fields.city ?? null,
        fields.venue ?? null,
        fields.dateStart ?? null,
        fields.dateEnd ?? null,
        fields.title ?? '',
        fields.isMixed ? 1 : 0,
        now,
        now,
      )
      return Number(r.lastInsertRowid)
    },

    getShow(id) {
      const row = q('SELECT * FROM shows WHERE id = ?').get(id)
      return row ? rowToShow(row) : null
    },

    showsForArtist: (artistKey) => q('SELECT * FROM shows WHERE artist_key = ? ORDER BY date_start, id').all(artistKey).map(rowToShow),

    allShows: () => q('SELECT * FROM shows ORDER BY artist_key, date_start, id').all().map(rowToShow),

    updateShow(id, f, now) {
      q(`UPDATE shows SET city = ?, venue = ?, date_start = ?, date_end = ?, title = ?, is_mixed = ?, stage = ?, round = ?, ever_sold = ?,
         next_sale_at = ?, announced_sale_at = ?, withdraw_runs = ?, known_sale_times = ?, reached = ?, updated_at = ? WHERE id = ?`).run(
        f.city ?? null,
        f.venue ?? null,
        f.dateStart ?? null,
        f.dateEnd ?? null,
        f.title ?? '',
        f.isMixed ? 1 : 0,
        f.stage ?? null,
        f.round ?? 0,
        f.everSold ? 1 : 0,
        f.nextSaleAt ?? null,
        f.announcedSaleAt ?? null,
        f.withdrawRuns ?? 0,
        JSON.stringify(f.knownSaleTimes ?? []),
        JSON.stringify(f.reached ?? []),
        now,
        id,
      )
    },

    /**
     * 把 fromId 这场并进 toId：记录改归过去，开过票、到过的阶段、出现过的开售时间取并集，轮次取大的。
     * 没推出去的事件和提醒随旧场一起删掉，由合并后的那场重新判断。
     */
    absorbShow(fromId, toId, now) {
      const from = store.getShow(fromId)
      const to = store.getShow(toId)
      if (!from || !to || fromId === toId) return
      q('UPDATE show_listings SET show_id = ? WHERE show_id = ?').run(toId, fromId)
      store.updateShow(
        toId,
        {
          ...to,
          everSold: to.everSold || from.everSold,
          round: Math.max(to.round, from.round),
          knownSaleTimes: [...new Set([...to.knownSaleTimes, ...from.knownSaleTimes])].sort((a, b) => a - b),
          reached: [...new Set([...to.reached, ...from.reached])],
        },
        now,
      )
      q('DELETE FROM events WHERE show_id = ? AND notified_at IS NULL').run(fromId)
      // 推过的事件跟过去，免得合并后同一件事再推一遍；和目标场重复的丢掉
      q('UPDATE OR IGNORE events SET show_id = ? WHERE show_id = ?').run(toId, fromId)
      q('DELETE FROM events WHERE show_id = ?').run(fromId)
      q('DELETE FROM reminders WHERE show_id = ?').run(fromId)
      q('DELETE FROM shows WHERE id = ?').run(fromId)
    },

    /** 一场演出名下的记录，带缺席轮数。 */
    listingsOfShow(showId) {
      return q(`SELECT l.* FROM show_listings sl JOIN listings l
                ON l.source = sl.source AND l.source_id = sl.source_id AND l.artist_key = sl.artist_key
                WHERE sl.show_id = ?`).all(showId).map(rowToListing)
    },

    // —— 事件 ——

    /** 记一条事件；同一场演出、同一类、同一轮、同一开售时间只记一次。返回是否新记。 */
    addEvent(e, now) {
      const r = q(`INSERT OR IGNORE INTO events (show_id, artist_key, kind, round, sale_at, detail, silent, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        e.showId,
        e.artistKey,
        e.kind,
        e.round ?? 0,
        e.saleAt ?? 0,
        JSON.stringify(e.detail ?? {}),
        e.silent ? 1 : 0,
        now,
      )
      return r.changes > 0
    },

    pendingEvents: () =>
      q(`SELECT e.* FROM events e JOIN artists a ON a.key = e.artist_key
         WHERE e.notified_at IS NULL AND e.silent = 0 AND a.active = 1 ORDER BY e.created_at, e.id`).all().map((row) => ({
        id: row.id,
        showId: row.show_id,
        artistKey: row.artist_key,
        kind: row.kind,
        round: row.round,
        saleAt: row.sale_at || null,
        detail: JSON.parse(row.detail),
        createdAt: row.created_at,
      })),

    markNotified: (id, now) => q('UPDATE events SET notified_at = ? WHERE id = ?').run(now, id),

    countEventsSince: (since) => q('SELECT COUNT(*) AS n FROM events WHERE notified_at >= ? AND silent = 0').get(since).n,

    // —— 开售提醒 ——

    dueReminders(now, windowMs) {
      return q(`SELECT s.* FROM shows s
                WHERE s.stage IN ('sale_pending', 'resale_pending') AND s.next_sale_at > ? AND s.next_sale_at <= ?
                AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.show_id = s.id AND r.sale_at = s.next_sale_at)
                AND EXISTS (SELECT 1 FROM artists a WHERE a.key = s.artist_key AND a.active = 1)
                ORDER BY s.next_sale_at`).all(now, now + windowMs).map(rowToShow)
    },

    markReminded: (showId, saleAt, now) => q('INSERT OR IGNORE INTO reminders (show_id, sale_at, sent_at) VALUES (?, ?, ?)').run(showId, saleAt, now),

    // —— 数据源健康 ——

    getHealth(source) {
      const row = q('SELECT * FROM source_health WHERE source = ?').get(source)
      return row
        ? { source, lastOkAt: row.last_ok_at, lastError: row.last_error, failRuns: row.fail_runs, alerted: Boolean(row.alerted) }
        : { source, lastOkAt: null, lastError: null, failRuns: 0, alerted: false }
    },

    saveHealth(h) {
      q(`INSERT INTO source_health (source, last_ok_at, last_error, fail_runs, alerted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, last_error = excluded.last_error,
         fail_runs = excluded.fail_runs, alerted = excluded.alerted`).run(h.source, h.lastOkAt ?? null, h.lastError ?? null, h.failRuns ?? 0, h.alerted ? 1 : 0)
    },

    // —— 每轮记录 ——

    startRun: (now) => Number(q('INSERT INTO runs (started_at) VALUES (?)').run(now).lastInsertRowid),
    finishRun: (id, now, stats) => q('UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?').run(now, JSON.stringify(stats), id),
  }
  return store
}

/** 老的状态库补上后来加的列。 */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(shows)').all().map((c) => c.name))
  if (!cols.has('withdraw_runs')) db.exec('ALTER TABLE shows ADD COLUMN withdraw_runs INTEGER NOT NULL DEFAULT 0')
}

function rowToListing(row) {
  return { ...JSON.parse(row.data), firstSeen: row.first_seen, lastSeen: row.last_seen, missingRuns: row.missing_runs }
}

function rowToShow(row) {
  return {
    id: row.id,
    artistKey: row.artist_key,
    city: row.city,
    venue: row.venue,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    title: row.title,
    isMixed: Boolean(row.is_mixed),
    stage: row.stage,
    round: row.round,
    everSold: Boolean(row.ever_sold),
    nextSaleAt: row.next_sale_at,
    announcedSaleAt: row.announced_sale_at,
    withdrawRuns: row.withdraw_runs ?? 0,
    knownSaleTimes: JSON.parse(row.known_sale_times),
    reached: JSON.parse(row.reached),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
