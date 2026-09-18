import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureRuntime } from "./run-store.mjs";

const connections = new Map();
const isoNow = () => new Date().toISOString();
const futureIso = (milliseconds) => new Date(Date.now() + milliseconds).toISOString();

function taskId() {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `task-${timestamp}-${randomBytes(3).toString("hex")}`;
}

function mapTask(row) {
  if (!row) return null;
  return {
    taskId: row.id,
    experimentId: row.experiment_id,
    type: row.type,
    state: row.state,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapCheckpoint(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    step: row.step,
    status: row.status,
    attempt: row.attempt,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    createdAt: row.created_at,
  };
}

export function openQueue(config) {
  ensureRuntime(config);
  const path = join(config.runtimeRoot, "queue.sqlite");
  if (connections.has(path)) return connections.get(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      state TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_runnable
      ON tasks(state, available_at, priority, created_at);
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task
      ON checkpoints(task_id, id);
    CREATE TABLE IF NOT EXISTS worker_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
  `);
  connections.set(path, db);
  return db;
}

export function enqueueExperimentTask(config, experimentId, options = {}) {
  const db = openQueue(config);
  const existing = db.prepare("SELECT * FROM tasks WHERE experiment_id = ?").get(experimentId);
  if (existing) throw new Error(`实验已经存在任务：${existing.id}（${existing.state}）`);
  const id = taskId();
  const now = isoNow();
  db.prepare(`
    INSERT INTO tasks(id, experiment_id, type, state, priority, attempts, max_attempts, available_at, created_at, updated_at)
    VALUES (?, ?, 'seismic_training', 'queued', ?, 0, ?, ?, ?, ?)
  `).run(id, experimentId, options.priority ?? 100, options.maxAttempts ?? 3, now, now, now);
  addCheckpoint(config, id, "task", "queued", 0, { experimentId });
  return getTask(config, id);
}

export function getTask(config, id) {
  return mapTask(openQueue(config).prepare("SELECT * FROM tasks WHERE id = ?").get(id));
}

export function getTaskByExperiment(config, experimentId) {
  return mapTask(openQueue(config).prepare("SELECT * FROM tasks WHERE experiment_id = ?").get(experimentId));
}

export function listCheckpoints(config, id) {
  return openQueue(config).prepare("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY id").all(id).map(mapCheckpoint);
}

export function addCheckpoint(config, id, step, status, attempt, payload = null) {
  openQueue(config).prepare(`
    INSERT INTO checkpoints(task_id, step, status, attempt, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, step, status, attempt, payload === null ? null : JSON.stringify(payload), isoNow());
}

export function acquireWorkerLease(config, owner, leaseMs = 30_000) {
  const db = openQueue(config);
  const now = isoNow();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM worker_leases WHERE name = 'gpu-0'").get();
    if (current && current.owner !== owner && current.lease_expires_at > now) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(`
      INSERT INTO worker_leases(name, owner, lease_expires_at, heartbeat_at)
      VALUES ('gpu-0', ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, lease_expires_at=excluded.lease_expires_at, heartbeat_at=excluded.heartbeat_at
    `).run(owner, futureIso(leaseMs), now);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function renewWorkerLease(config, owner, leaseMs = 30_000) {
  return openQueue(config).prepare(`
    UPDATE worker_leases SET lease_expires_at = ?, heartbeat_at = ? WHERE name = 'gpu-0' AND owner = ?
  `).run(futureIso(leaseMs), isoNow(), owner).changes === 1;
}

export function workerLeaseActive(config) {
  const row = openQueue(config).prepare("SELECT * FROM worker_leases WHERE name = 'gpu-0'").get();
  return Boolean(row && row.lease_expires_at > isoNow());
}

export function releaseWorkerLease(config, owner) {
  openQueue(config).prepare("DELETE FROM worker_leases WHERE name = 'gpu-0' AND owner = ?").run(owner);
}

export function recoverExpiredTasks(config) {
  const db = openQueue(config);
  const now = isoNow();
  const dead = db.prepare(`
    UPDATE tasks SET state='dead_letter', last_error='Worker lease expired and retry budget exhausted', updated_at=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL
    WHERE state='running' AND lease_expires_at < ? AND attempts >= max_attempts
  `).run(now, now, now).changes;
  const retried = db.prepare(`
    UPDATE tasks SET state='retrying', last_error='Worker lease expired; task recovered', available_at=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL
    WHERE state='running' AND lease_expires_at < ? AND attempts < max_attempts
  `).run(now, now, now).changes;
  return { retried, deadLettered: dead };
}

export function claimNextTask(config, owner, leaseMs = 30_000) {
  const db = openQueue(config);
  const now = isoNow();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT * FROM tasks
      WHERE state IN ('queued', 'retrying') AND available_at <= ?
      ORDER BY priority ASC, created_at ASC LIMIT 1
    `).get(now);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE tasks SET state='running', attempts=attempts+1, lease_owner=?, lease_expires_at=?, heartbeat_at=?,
        updated_at=?, started_at=COALESCE(started_at, ?), last_error=NULL
      WHERE id=?
    `).run(owner, futureIso(leaseMs), now, now, now, row.id);
    db.exec("COMMIT");
    return getTask(config, row.id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function heartbeatTask(config, id, owner, leaseMs = 30_000) {
  return openQueue(config).prepare(`
    UPDATE tasks SET lease_expires_at=?, heartbeat_at=?, updated_at=?
    WHERE id=? AND state='running' AND lease_owner=?
  `).run(futureIso(leaseMs), isoNow(), isoNow(), id, owner).changes === 1;
}

export function completeTask(config, id, owner) {
  const now = isoNow();
  openQueue(config).prepare(`
    UPDATE tasks SET state='succeeded', updated_at=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL
    WHERE id=? AND lease_owner=?
  `).run(now, now, id, owner);
  return getTask(config, id);
}

export function failTask(config, id, owner, errorMessage, retryable) {
  const db = openQueue(config);
  const task = getTask(config, id);
  if (!task) throw new Error(`任务不存在：${id}`);
  const canRetry = retryable && task.attempts < task.maxAttempts;
  const now = isoNow();
  if (canRetry) {
    const delayMs = 5_000 * (2 ** Math.max(0, task.attempts - 1));
    db.prepare(`
      UPDATE tasks SET state='retrying', available_at=?, last_error=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL
      WHERE id=? AND lease_owner=?
    `).run(futureIso(delayMs), errorMessage, now, id, owner);
  } else {
    db.prepare(`
      UPDATE tasks SET state='dead_letter', last_error=?, updated_at=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL
      WHERE id=? AND lease_owner=?
    `).run(errorMessage, now, now, id, owner);
  }
  return getTask(config, id);
}

export function queueOverview(config) {
  const rows = openQueue(config).prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state").all();
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
}
