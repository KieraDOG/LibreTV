import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const dir = mkdtempSync(path.join(tmpdir(), 'libretv-worker-test-'))
const bin = path.join(dir, 'bin')
let repository: typeof import('./repository')
let worker: ChildProcess | undefined
beforeAll(async () => {
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'ffmpeg'), `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(process.argv.at(-1), 'fake-video')
process.stdout.write('out_time_us=12000000\\n')
`, { mode: 0o755 })
  writeFileSync(path.join(bin, 'smbclient'), `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const marker = path.join(process.env.DOWNLOAD_DATA_DIR, 'nas-online')
if (!fs.existsSync(marker)) process.exit(1)
if (process.argv.at(-1).startsWith('allinfo')) process.stdout.write('stream: [::$DATA], 10 bytes\\nsize: 10\\n')
`, { mode: 0o755 })
  vi.stubEnv('DOWNLOAD_DATA_DIR', dir)
  repository = await import('./repository')
})
afterAll(async () => {
  if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await once(worker, 'close') }
  repository?.getDatabase().close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('worker state transition timed out')
    await delay(30)
  }
}
it('preserves completed local video on SMB failure and uploads it on retry', async () => {
  const id = repository.enqueue({ title: '测试影片', sourceUrl: 'https://example.com/test.m3u8' })
  worker = spawn(process.execPath, ['--import', 'tsx', 'src/services/downloads/worker.ts'], {
    cwd: process.cwd(), stdio: 'pipe',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOWNLOAD_DATA_DIR: dir,
      NAS_DOWNLOAD_ENABLED: '1', NAS_HOST: '192.168.1.100', NAS_SHARE: 'video', NAS_USERNAME: 'test', NAS_PASSWORD: 'test' },
  })
  await waitFor(() => repository.getTask(id)?.status === 'failed')
  expect(existsSync(path.join(dir, 'files', `${id}.mp4`))).toBe(true)
  expect(repository.getTask(id)?.seconds).toBe(12)
  writeFileSync(path.join(dir, 'nas-online'), '')
  repository.retry(id)
  await waitFor(() => repository.getTask(id)?.status === 'completed')
  await waitFor(() => !existsSync(path.join(dir, 'files', `${id}.mp4`)))
}, 20000)
