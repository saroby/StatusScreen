import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/statusscreen.db');

export class StoreError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolean(value) {
  return Boolean(value);
}

function mapChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    handle: row.handle,
    connected: boolean(row.connected),
    metrics: {
      7: parseJson(row.metrics_7, {}),
      30: parseJson(row.metrics_30, {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    projectId: row.project_id,
    status: row.status,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    workerId: row.worker_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContent(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    status: row.status,
    durationSeconds: row.duration_seconds,
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    contentId: row.content_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    body: row.body,
    isDefault: boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 1 CHECK (connected IN (0, 1)),
        metrics_7 TEXT NOT NULL,
        metrics_30 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_channels (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        PRIMARY KEY (project_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        locked_at TEXT,
        heartbeat_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_queue_idx
        ON jobs(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id, created_at);

      CREATE TABLE IF NOT EXISTS content_items (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'testing', 'scheduled', 'published')),
        duration_seconds INTEGER NOT NULL DEFAULT 59,
        thumbnail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, channel_id)
      );

      CREATE INDEX IF NOT EXISTS content_filter_idx
        ON content_items(status, channel_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS hook_tests (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL UNIQUE REFERENCES content_items(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hook_variants (
        id TEXT PRIMARY KEY,
        hook_test_id TEXT NOT NULL REFERENCES hook_tests(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
        caption TEXT NOT NULL,
        score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (hook_test_id, position)
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        content_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        title TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'published', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        body TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS brand_profiles (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        name TEXT NOT NULL,
        voice TEXT NOT NULL,
        primary_color TEXT NOT NULL,
        logo_url TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        locale TEXT NOT NULL,
        timezone TEXT NOT NULL,
        email_notifications INTEGER NOT NULL CHECK (email_notifications IN (0, 1)),
        auto_schedule INTEGER NOT NULL CHECK (auto_schedule IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        name TEXT NOT NULL,
        days_remaining INTEGER NOT NULL,
        usage_percent INTEGER NOT NULL CHECK (usage_percent BETWEEN 0 AND 100),
        project_limit INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_snapshots (
        range_days INTEGER PRIMARY KEY CHECK (range_days IN (7, 30)),
        views INTEGER NOT NULL,
        likes INTEGER NOT NULL,
        average_view_rate REAL NOT NULL,
        new_followers INTEGER NOT NULL,
        view_change REAL NOT NULL,
        like_change REAL NOT NULL,
        rate_change REAL NOT NULL,
        follower_change REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_state (
        name TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'stopped')),
        heartbeat_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT
      );
    `,
  },
];

const CHANNEL_SEEDS = [
  {
    id: 'youtube', name: 'YouTube Shorts', kind: 'yt', handle: '@smartvideo',
    metrics7: { subscribers: 124000, views: 687000, averageViewRate: 112, posts: 24 },
    metrics30: { subscribers: 124000, views: 2748000, averageViewRate: 108, posts: 96 },
    hooks: [
      ['이 레시피, 99%가 모릅니다', 46],
      ['의외로 간단한 수분 폭탄 레시피', 32],
      ['맛있어서 충격받았습니다', 22],
    ],
  },
  {
    id: 'instagram', name: 'Instagram Reels', kind: 'ig', handle: '@smartvideo',
    metrics7: { followers: 78000, reach: 1240000, averageWatchSeconds: 3.2, posts: 18 },
    metrics30: { followers: 78000, reach: 4960000, averageWatchSeconds: 3.1, posts: 72 },
    hooks: [
      ['라떼 아트, 이것만 알면 쉬워요', 53],
      ['홈카페 퀄리티 높이는 꿀팁', 29],
      ['바리스타가 절대 알려주지 않는 것', 18],
    ],
  },
  {
    id: 'tiktok', name: 'TikTok', kind: 'tt', handle: '@smartvideo',
    metrics7: { followers: 156000, likes: 892000, averageWatchSeconds: 2.7, posts: 27 },
    metrics30: { followers: 156000, likes: 3568000, averageWatchSeconds: 2.6, posts: 108 },
    hooks: [
      ['3초만에 만드는 초간단 음료', 61],
      ['카페 안 가도 되는 이유', 24],
      ['진짜 쉬운 레시피 공개', 15],
    ],
  },
];

export class StatusScreenStore {
  constructor({ path = process.env.STATUSSCREEN_DB || DEFAULT_DB_PATH, seed = true } = {}) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.closed = false;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    if (seed) this.seed();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, nowIso());
      });
    }
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seed() {
    const timestamp = nowIso();
    this.transaction(() => {
      const insertChannel = this.db.prepare(`
        INSERT OR IGNORE INTO channels
          (id, name, kind, handle, connected, metrics_7, metrics_30, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      `);
      for (const channel of CHANNEL_SEEDS) {
        insertChannel.run(
          channel.id, channel.name, channel.kind, channel.handle,
          JSON.stringify(channel.metrics7), JSON.stringify(channel.metrics30), timestamp, timestamp,
        );
      }

      this.db.prepare(`
        INSERT OR IGNORE INTO projects(id, title, status, created_at, updated_at)
        VALUES ('seed-project', '전자레인지로 만드는 초간단 케이크', 'ready', ?, ?)
      `).run(timestamp, timestamp);

      const addProjectChannel = this.db.prepare(
        'INSERT OR IGNORE INTO project_channels(project_id, channel_id) VALUES (?, ?)',
      );
      const addContent = this.db.prepare(`
        INSERT OR IGNORE INTO content_items
          (id, project_id, channel_id, title, status, duration_seconds, thumbnail, created_at, updated_at)
        VALUES (?, 'seed-project', ?, '전자레인지로 만드는 초간단 케이크', 'testing', 59, ?, ?, ?)
      `);
      const addHookTest = this.db.prepare(`
        INSERT OR IGNORE INTO hook_tests(id, content_id, channel_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?)
      `);
      const addVariant = this.db.prepare(`
        INSERT OR IGNORE INTO hook_variants
          (id, hook_test_id, position, caption, score, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const channel of CHANNEL_SEEDS) {
        const contentId = `seed-content-${channel.id}`;
        const hookId = `seed-hook-${channel.id}`;
        addProjectChannel.run('seed-project', channel.id);
        addContent.run(
          contentId, channel.id,
          `https://images.unsplash.com/photo-1578985545062-69928b1d9587`, timestamp, timestamp,
        );
        addHookTest.run(hookId, contentId, channel.id, timestamp, timestamp);
        channel.hooks.forEach(([caption, score], index) => {
          addVariant.run(
            `${hookId}-${index + 1}`, hookId, index + 1, caption, score,
            index === 0 ? 'leading' : 'candidate', timestamp,
          );
        });
      }

      const addAnalytics = this.db.prepare(`
        INSERT OR IGNORE INTO analytics_snapshots
          (range_days, views, likes, average_view_rate, new_followers,
           view_change, like_change, rate_change, follower_change, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      addAnalytics.run(7, 2814000, 216000, 115, 32000, 12.5, 18.7, 9, 14.3, timestamp);
      addAnalytics.run(30, 11240000, 863000, 109, 128000, 11.8, 16.9, 7.5, 13.1, timestamp);

      const addTemplate = this.db.prepare(`
        INSERT OR IGNORE INTO templates
          (id, name, category, body, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      addTemplate.run('template-recipe', '레시피 훅', 'food', '이 {주제}, {숫자}%가 모릅니다', 1, timestamp, timestamp);
      addTemplate.run('template-howto', '빠른 사용법', 'howto', '{시간}만에 완성하는 {주제}', 0, timestamp, timestamp);

      this.db.prepare(`
        INSERT OR IGNORE INTO brand_profiles
          (id, name, voice, primary_color, logo_url, updated_at)
        VALUES ('default', '스마트비디오', '명확하고 친근한 전문가', '#6842e3', NULL, ?)
      `).run(timestamp);
      this.db.prepare(`
        INSERT OR IGNORE INTO settings
          (id, locale, timezone, email_notifications, auto_schedule, updated_at)
        VALUES ('default', 'ko-KR', 'Asia/Seoul', 1, 0, ?)
      `).run(timestamp);
      this.db.prepare(`
        INSERT OR IGNORE INTO plans
          (id, name, days_remaining, usage_percent, project_limit, updated_at)
        VALUES ('default', '프로 플랜', 28, 72, 100, ?)
      `).run(timestamp);

      const addNotification = this.db.prepare(`
        INSERT OR IGNORE INTO notifications(id, type, title, message, read_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `);
      addNotification.run('notification-1', 'hook_test', '훅 테스트 진행 중', 'YouTube Shorts 테스트가 진행 중입니다.', timestamp);
      addNotification.run('notification-2', 'growth', '채널 성장', 'Instagram 도달이 지난주보다 11.3% 증가했습니다.', timestamp);
      addNotification.run('notification-3', 'schedule', '게시 일정', '오늘 게시 예정 콘텐츠가 있습니다.', timestamp);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  listChannels() {
    return this.db.prepare('SELECT * FROM channels ORDER BY rowid').all().map(mapChannel);
  }

  getChannel(id) {
    return mapChannel(this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id));
  }

  updateChannel(id, changes) {
    const channel = this.getChannel(id);
    if (!channel) throw new StoreError('NOT_FOUND', 'Channel not found.', { status: 404 });
    const next = {
      handle: changes.handle ?? channel.handle,
      connected: changes.connected ?? channel.connected,
    };
    this.db.prepare(`
      UPDATE channels SET handle = ?, connected = ?, updated_at = ? WHERE id = ?
    `).run(next.handle, Number(next.connected), nowIso(), id);
    return this.getChannel(id);
  }

  createProject({ title, channelIds, maxAttempts = 3 }) {
    const projectId = randomUUID();
    const jobId = randomUUID();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects(id, title, status, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?)
      `).run(projectId, title, timestamp, timestamp);
      const link = this.db.prepare(
        'INSERT INTO project_channels(project_id, channel_id) VALUES (?, ?)',
      );
      for (const channelId of channelIds) link.run(projectId, channelId);
      this.db.prepare(`
        INSERT INTO jobs
          (id, type, project_id, payload, status, progress, attempts, max_attempts,
           available_at, created_at, updated_at)
        VALUES (?, 'process_project', ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
      `).run(
        jobId, projectId, JSON.stringify({ projectId, channelIds }), maxAttempts,
        timestamp, timestamp, timestamp,
      );
    });
    return { project: this.getProject(projectId), job: this.getJob(jobId) };
  }

  listProjects({ status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    return rows.map((row) => this.#mapProject(row));
  }

  getProject(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? this.#mapProject(row, true) : null;
  }

  #mapProject(row, includeContent = false) {
    const channels = this.db.prepare(`
      SELECT c.* FROM channels c
      JOIN project_channels pc ON pc.channel_id = c.id
      WHERE pc.project_id = ? ORDER BY c.rowid
    `).all(row.id).map(mapChannel);
    const latestJob = mapJob(this.db.prepare(`
      SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(row.id));
    const project = {
      id: row.id,
      title: row.title,
      status: row.status,
      error: row.error,
      channelIds: channels.map((channel) => channel.id),
      channels,
      latestJob,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (includeContent) {
      project.content = this.db.prepare(`
        SELECT ci.*, c.name AS channel_name FROM content_items ci
        JOIN channels c ON c.id = ci.channel_id
        WHERE ci.project_id = ? ORDER BY ci.created_at
      `).all(row.id).map(mapContent);
    }
    return project;
  }

  retryProject(id) {
    const project = this.getProject(id);
    if (!project) throw new StoreError('NOT_FOUND', 'Project not found.', { status: 404 });
    if (project.status !== 'failed') {
      throw new StoreError('CONFLICT', 'Only failed projects can be retried.', { status: 409 });
    }
    const previous = project.latestJob;
    const jobId = randomUUID();
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE projects SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?
      `).run(timestamp, id);
      this.db.prepare(`
        INSERT INTO jobs
          (id, type, project_id, payload, status, progress, attempts, max_attempts,
           available_at, created_at, updated_at)
        VALUES (?, 'process_project', ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
      `).run(
        jobId, id, JSON.stringify({ projectId: id, channelIds: project.channelIds }),
        previous?.maxAttempts ?? 3, timestamp, timestamp, timestamp,
      );
    });
    return { project: this.getProject(id), job: this.getJob(jobId) };
  }

  getJob(id) {
    return mapJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  listContent({ search, status, channel } = {}) {
    const where = [];
    const values = [];
    if (search) {
      where.push('LOWER(ci.title) LIKE ?');
      values.push(`%${search.toLowerCase()}%`);
    }
    if (status) {
      where.push('ci.status = ?');
      values.push(status);
    }
    if (channel) {
      where.push('ci.channel_id = ?');
      values.push(channel);
    }
    const sql = `
      SELECT ci.*, c.name AS channel_name FROM content_items ci
      JOIN channels c ON c.id = ci.channel_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ci.updated_at DESC
    `;
    return this.db.prepare(sql).all(...values).map(mapContent);
  }

  getContent(id) {
    return mapContent(this.db.prepare(`
      SELECT ci.*, c.name AS channel_name FROM content_items ci
      JOIN channels c ON c.id = ci.channel_id WHERE ci.id = ?
    `).get(id));
  }

  listHookTests({ status, channel } = {}) {
    const where = [];
    const values = [];
    if (status) {
      where.push('ht.status = ?');
      values.push(status);
    }
    if (channel) {
      where.push('ht.channel_id = ?');
      values.push(channel);
    }
    const rows = this.db.prepare(`
      SELECT ht.*, ci.title, c.name AS channel_name
      FROM hook_tests ht
      JOIN content_items ci ON ci.id = ht.content_id
      JOIN channels c ON c.id = ht.channel_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ht.updated_at DESC
    `).all(...values);
    const variants = this.db.prepare(`
      SELECT id, position, caption, score, result FROM hook_variants
      WHERE hook_test_id = ? ORDER BY position
    `);
    return rows.map((row) => ({
      id: row.id,
      contentId: row.content_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      title: row.title,
      status: row.status,
      variants: variants.all(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listSchedules() {
    return this.db.prepare(`
      SELECT s.*, c.name AS channel_name FROM schedules s
      JOIN channels c ON c.id = s.channel_id
      ORDER BY s.scheduled_at
    `).all().map(mapSchedule);
  }

  createSchedule({ contentId = null, channelId, title, scheduledAt, timezone, status = 'scheduled' }) {
    const id = randomUUID();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO schedules
        (id, content_id, channel_id, title, scheduled_at, timezone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, contentId, channelId, title, scheduledAt, timezone, status, timestamp, timestamp);
    return mapSchedule(this.db.prepare(`
      SELECT s.*, c.name AS channel_name FROM schedules s
      JOIN channels c ON c.id = s.channel_id WHERE s.id = ?
    `).get(id));
  }

  deleteSchedule(id) {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  listTemplates() {
    return this.db.prepare('SELECT * FROM templates ORDER BY is_default DESC, created_at').all().map(mapTemplate);
  }

  createTemplate({ name, category, body, isDefault = false }) {
    const id = randomUUID();
    const timestamp = nowIso();
    this.transaction(() => {
      if (isDefault) this.db.prepare('UPDATE templates SET is_default = 0').run();
      this.db.prepare(`
        INSERT INTO templates(id, name, category, body, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, category, body, Number(isDefault), timestamp, timestamp);
    });
    return mapTemplate(this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id));
  }

  deleteTemplate(id) {
    return this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
  }

  getBrand() {
    const row = this.db.prepare('SELECT * FROM brand_profiles WHERE id = \'default\'').get();
    return {
      name: row.name, voice: row.voice, primaryColor: row.primary_color,
      logoUrl: row.logo_url, updatedAt: row.updated_at,
    };
  }

  updateBrand(changes) {
    const current = this.getBrand();
    this.db.prepare(`
      UPDATE brand_profiles SET name = ?, voice = ?, primary_color = ?, logo_url = ?, updated_at = ?
      WHERE id = 'default'
    `).run(
      changes.name ?? current.name,
      changes.voice ?? current.voice,
      changes.primaryColor ?? current.primaryColor,
      changes.logoUrl === undefined ? current.logoUrl : changes.logoUrl,
      nowIso(),
    );
    return this.getBrand();
  }

  getSettings() {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = \'default\'').get();
    return {
      locale: row.locale,
      timezone: row.timezone,
      emailNotifications: boolean(row.email_notifications),
      autoSchedule: boolean(row.auto_schedule),
      updatedAt: row.updated_at,
    };
  }

  updateSettings(changes) {
    const current = this.getSettings();
    this.db.prepare(`
      UPDATE settings
      SET locale = ?, timezone = ?, email_notifications = ?, auto_schedule = ?, updated_at = ?
      WHERE id = 'default'
    `).run(
      changes.locale ?? current.locale,
      changes.timezone ?? current.timezone,
      Number(changes.emailNotifications ?? current.emailNotifications),
      Number(changes.autoSchedule ?? current.autoSchedule),
      nowIso(),
    );
    return this.getSettings();
  }

  getPlan() {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = \'default\'').get();
    return {
      name: row.name,
      daysRemaining: row.days_remaining,
      usagePercent: row.usage_percent,
      projectLimit: row.project_limit,
      updatedAt: row.updated_at,
    };
  }

  updatePlan(changes) {
    const current = this.getPlan();
    this.db.prepare(`
      UPDATE plans SET name = ?, days_remaining = ?, usage_percent = ?, project_limit = ?, updated_at = ?
      WHERE id = 'default'
    `).run(
      changes.name ?? current.name,
      changes.daysRemaining ?? current.daysRemaining,
      changes.usagePercent ?? current.usagePercent,
      changes.projectLimit ?? current.projectLimit,
      nowIso(),
    );
    return this.getPlan();
  }

  listNotifications() {
    return this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all().map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      read: row.read_at !== null,
      readAt: row.read_at,
      createdAt: row.created_at,
    }));
  }

  readNotification(id) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?
    `).run(timestamp, id);
    if (!result.changes) return null;
    return this.listNotifications().find((item) => item.id === id);
  }

  getAnalytics(range) {
    const row = this.db.prepare('SELECT * FROM analytics_snapshots WHERE range_days = ?').get(range);
    return {
      range: row.range_days,
      views: row.views,
      likes: row.likes,
      averageViewRate: row.average_view_rate,
      newFollowers: row.new_followers,
      changes: {
        views: row.view_change,
        likes: row.like_change,
        averageViewRate: row.rate_change,
        newFollowers: row.follower_change,
      },
      updatedAt: row.updated_at,
    };
  }

  getDashboard(range) {
    return {
      range,
      analytics: this.getAnalytics(range),
      channels: this.listChannels(),
      recentContent: this.listContent().slice(0, 6),
      hookTests: this.listHookTests({ status: 'running' }),
      plan: this.getPlan(),
      unreadNotifications: this.listNotifications().filter((item) => !item.read).length,
    };
  }

  updateWorkerHeartbeat({ name = 'project-worker', workerId, status = 'running', startedAt }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO worker_state(name, worker_id, status, heartbeat_at, started_at, stopped_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(name) DO UPDATE SET
        worker_id = excluded.worker_id,
        status = excluded.status,
        heartbeat_at = excluded.heartbeat_at,
        started_at = excluded.started_at,
        stopped_at = CASE WHEN excluded.status = 'stopped' THEN excluded.heartbeat_at ELSE NULL END
    `).run(name, workerId, status, timestamp, startedAt ?? timestamp);
    return this.getWorkerState(name);
  }

  getWorkerState(name = 'project-worker') {
    const row = this.db.prepare('SELECT * FROM worker_state WHERE name = ?').get(name);
    if (!row) return null;
    return {
      name: row.name,
      workerId: row.worker_id,
      status: row.status,
      heartbeatAt: row.heartbeat_at,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
    };
  }

  recoverStaleJobs({ staleAfterMs = 30_000 } = {}) {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const timestamp = nowIso();
    return this.transaction(() => {
      const stale = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'processing' AND (heartbeat_at IS NULL OR heartbeat_at < ?)
      `).all(cutoff);
      for (const row of stale) {
        if (row.attempts >= row.max_attempts) {
          const error = row.last_error || 'Job became stale after reaching the attempt limit.';
          this.db.prepare(`
            UPDATE jobs SET status = 'failed', completed_at = ?, locked_at = NULL,
              heartbeat_at = NULL, worker_id = NULL, last_error = ?, updated_at = ?
            WHERE id = ?
          `).run(timestamp, error, timestamp, row.id);
          this.db.prepare(`
            UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
          `).run(error, timestamp, row.project_id);
        } else {
          this.db.prepare(`
            UPDATE jobs SET status = 'queued', available_at = ?, locked_at = NULL,
              heartbeat_at = NULL, worker_id = NULL, last_error = ?, updated_at = ?
            WHERE id = ?
          `).run(timestamp, row.last_error || 'Recovered stale processing job.', timestamp, row.id);
          this.db.prepare(`
            UPDATE projects SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?
          `).run(timestamp, row.project_id);
        }
      }
      return stale.length;
    });
  }

  claimNextJob(workerId) {
    const timestamp = nowIso();
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY created_at, id LIMIT 1
      `).get(timestamp);
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE jobs SET status = 'processing', progress = 1, attempts = attempts + 1,
          locked_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?),
          worker_id = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(timestamp, timestamp, timestamp, workerId, timestamp, row.id);
      if (!result.changes) return null;
      this.db.prepare(`
        UPDATE projects SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?
      `).run(timestamp, row.project_id);
      const claimed = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
      return { ...mapJob(claimed), payload: parseJson(claimed.payload, {}) };
    });
  }

  heartbeatJob(jobId, workerId, progress) {
    const result = this.db.prepare(`
      UPDATE jobs SET heartbeat_at = ?, progress = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'processing'
    `).run(nowIso(), progress, nowIso(), jobId, workerId);
    return result.changes > 0;
  }

  completeProjectJob({ jobId, workerId, projectId, title, channelIds, generatedHooks }) {
    const timestamp = nowIso();
    this.transaction(() => {
      const job = this.db.prepare(`
        SELECT * FROM jobs WHERE id = ? AND worker_id = ? AND status = 'processing'
      `).get(jobId, workerId);
      if (!job) throw new StoreError('JOB_NOT_CLAIMED', 'Job is not claimed by this worker.', { status: 409 });
      const addContent = this.db.prepare(`
        INSERT INTO content_items
          (id, project_id, channel_id, title, status, duration_seconds, thumbnail, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'testing', 59, NULL, ?, ?)
        ON CONFLICT(project_id, channel_id) DO UPDATE SET
          title = excluded.title, status = excluded.status, updated_at = excluded.updated_at
      `);
      const addHookTest = this.db.prepare(`
        INSERT INTO hook_tests(id, content_id, channel_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?)
        ON CONFLICT(content_id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at
      `);
      const findHook = this.db.prepare('SELECT id FROM hook_tests WHERE content_id = ?');
      const deleteVariants = this.db.prepare('DELETE FROM hook_variants WHERE hook_test_id = ?');
      const addVariant = this.db.prepare(`
        INSERT INTO hook_variants
          (id, hook_test_id, position, caption, score, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const channelId of channelIds) {
        const contentId = `content-${projectId}-${channelId}`;
        addContent.run(contentId, projectId, channelId, title, timestamp, timestamp);
        const existingHook = findHook.get(contentId);
        const hookId = existingHook?.id ?? `hook-${projectId}-${channelId}`;
        addHookTest.run(hookId, contentId, channelId, timestamp, timestamp);
        deleteVariants.run(hookId);
        generatedHooks[channelId].forEach((variant, index) => {
          addVariant.run(
            randomUUID(), hookId, index + 1, variant.caption, variant.score,
            index === 0 ? 'leading' : 'candidate', timestamp,
          );
        });
      }
      this.db.prepare(`
        UPDATE projects SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?
      `).run(timestamp, projectId);
      this.db.prepare(`
        UPDATE jobs SET status = 'completed', progress = 100, completed_at = ?,
          heartbeat_at = ?, locked_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, timestamp, jobId);
    });
    return { project: this.getProject(projectId), job: this.getJob(jobId) };
  }

  failJob({ jobId, workerId, error, retryDelayMs = 100 }) {
    const timestamp = nowIso();
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE id = ? AND worker_id = ? AND status = 'processing'
      `).get(jobId, workerId);
      if (!row) return null;
      const willRetry = row.attempts < row.max_attempts;
      if (willRetry) {
        const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
        this.db.prepare(`
          UPDATE jobs SET status = 'queued', progress = 0, available_at = ?, locked_at = NULL,
            heartbeat_at = NULL, worker_id = NULL, last_error = ?, updated_at = ? WHERE id = ?
        `).run(availableAt, error, timestamp, jobId);
        this.db.prepare(`
          UPDATE projects SET status = 'queued', error = ?, updated_at = ? WHERE id = ?
        `).run(error, timestamp, row.project_id);
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'failed', completed_at = ?, locked_at = NULL,
            heartbeat_at = NULL, last_error = ?, updated_at = ? WHERE id = ?
        `).run(timestamp, error, timestamp, jobId);
        this.db.prepare(`
          UPDATE projects SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
        `).run(error, timestamp, row.project_id);
      }
      return { job: this.getJob(jobId), willRetry };
    });
  }
}

export function openDatabase(options) {
  return new StatusScreenStore(options);
}

export function getDefaultDatabasePath() {
  return process.env.STATUSSCREEN_DB || DEFAULT_DB_PATH;
}
