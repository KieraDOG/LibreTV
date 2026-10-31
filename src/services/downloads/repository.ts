import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CreateDownload, DownloadTask } from './schemas'

export interface StoredTask extends DownloadTask { sourceUrl: string }
export const DATA_DIR = path.resolve(process.env.DOWNLOAD_DATA_DIR || './data/nas-downloads')
export const TEMP_DIR = path.join(DATA_DIR, 'files')

// Each process owns one connection; SQLite coordinates API writes and worker claims.
let database: Database.Database | undefined
export const getDatabase = (): Database.Database => {
  if (database) return database
  mkdirSync(TEMP_DIR, { recursive: true })
  database = new Database(path.join(DATA_DIR, 'tasks.sqlite'))
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  database.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, sourceUrl TEXT NOT NULL,
    status TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, error TEXT,
    createdAt INTEGER NOT NULL
  ); CREATE UNIQUE INDEX IF NOT EXISTS active_source ON tasks(sourceUrl)
    WHERE status IN ('queued', 'downloading', 'uploading');`)
  return database
}
export const listTasks = (): DownloadTask[] => getDatabase().prepare(
  'SELECT id,title,status,seconds,error,createdAt FROM tasks ORDER BY createdAt DESC LIMIT 100',
).all() as DownloadTask[]
export const getTask = (id: string): StoredTask | undefined => getDatabase().prepare(
  'SELECT * FROM tasks WHERE id = ?',
).get(id) as StoredTask | undefined
export const enqueue = (input: CreateDownload): string => getDatabase().transaction(() => {
  const existing = getDatabase().prepare("SELECT id FROM tasks WHERE sourceUrl = ? AND status IN ('queued','downloading','uploading')").get(input.sourceUrl) as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  getDatabase().prepare("INSERT INTO tasks (id,title,sourceUrl,status,createdAt) VALUES (?,?,?,'queued',?)").run(id, input.title, input.sourceUrl, Date.now())
  return id
})()
export const claim = (): StoredTask | undefined => getDatabase().prepare(`UPDATE tasks SET status='downloading', error=NULL
  WHERE id=(SELECT id FROM tasks WHERE status='queued' ORDER BY createdAt LIMIT 1)
  RETURNING *`).get() as StoredTask | undefined
export const setStatus = (id: string, status: DownloadTask['status'], error: string | null = null): void => {
  getDatabase().prepare("UPDATE tasks SET status=?, error=? WHERE id=? AND status!='cancelled'").run(status, error, id)
}
export const setProgress = (id: string, seconds: number): void => {
  getDatabase().prepare('UPDATE tasks SET seconds=? WHERE id=?').run(seconds, id)
}
export const recover = (): void => {
  getDatabase().prepare("UPDATE tasks SET status='queued' WHERE status IN ('downloading','uploading')").run()
}
export const cancel = (id: string): void => {
  getDatabase().prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND status IN ('queued','downloading','uploading','failed')").run(id)
}
export const retry = (id: string): void => {
  getDatabase().prepare("UPDATE tasks SET status='queued',error=NULL,seconds=0 WHERE id=? AND status IN ('failed','cancelled') AND NOT EXISTS (SELECT 1 FROM tasks active WHERE active.sourceUrl=tasks.sourceUrl AND active.status IN ('queued','downloading','uploading'))").run(id)
}
