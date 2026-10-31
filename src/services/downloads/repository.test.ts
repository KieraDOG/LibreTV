import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDownloadSchema, downloadActionSchema } from './schemas'

const dir = mkdtempSync(path.join(tmpdir(), 'libretv-queue-test-'))
let repository: typeof import('./repository')
beforeAll(async () => {
  vi.stubEnv('DOWNLOAD_DATA_DIR', dir)
  repository = await import('./repository')
})
afterAll(() => {
  repository?.getDatabase().close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
describe('NAS task lifecycle', () => {
  it('deduplicates active jobs and claims each job once', () => {
    const input = { title: '电影', sourceUrl: 'https://example.com/a.m3u8' }
    const id = repository.enqueue(input)
    expect(repository.enqueue(input)).toBe(id)
    expect(repository.claim()?.id).toBe(id)
    expect(repository.claim()).toBeUndefined()
    expect(repository.listTasks()[0]).not.toHaveProperty('sourceUrl')
    repository.cancel(id)
    repository.setStatus(id, 'completed')
    expect(repository.getTask(id)?.status).toBe('cancelled')
    repository.retry(id)
    expect(repository.claim()?.id).toBe(id)
    repository.setProgress(id, 12.5)
    repository.setStatus(id, 'uploading')
    repository.recover()
    expect(repository.getTask(id)).toMatchObject({ status: 'queued', seconds: 12.5 })
    repository.claim()
    repository.setStatus(id, 'failed', 'NAS offline')
    repository.retry(id)
    expect(repository.getTask(id)).toMatchObject({ status: 'queued', error: null, seconds: 0 })
    repository.claim()
    repository.setStatus(id, 'completed')
  })
  it('does not retry an older failed job while the same source is active', () => {
    const input = { title: '剧集', sourceUrl: 'https://example.com/b.m3u8' }
    const first = repository.enqueue(input)
    repository.cancel(first)
    const second = repository.enqueue(input)
    repository.retry(first)
    expect(repository.getTask(first)?.status).toBe('cancelled')
    expect(repository.claim()?.id).toBe(second)
  })
})
describe('download boundary validation', () => {
  it.each(['file:///etc/passwd', 'ftp://example.com/a', 'https://user:password@example.com/a', 'not-a-url'])(
    'rejects %s', sourceUrl => expect(createDownloadSchema.safeParse({ title: 'test', sourceUrl }).success).toBe(false),
  )
  it('rejects invalid actions and empty titles', () => {
    expect(downloadActionSchema.safeParse({ id: '../a', action: 'retry' }).success).toBe(false)
    expect(createDownloadSchema.safeParse({ title: ' ', sourceUrl: 'https://example.com/a' }).success).toBe(false)
  })
})
