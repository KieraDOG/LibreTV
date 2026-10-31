import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkUpstreamAllowed } from '../../lib/ssrf'
import { claim, getDatabase, getTask, recover, setProgress, setStatus, TEMP_DIR, type StoredTask } from './repository'

let stopping = false
let activeController: AbortController | undefined
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { stopping = true; activeController?.abort() })
}
const required = (name: string): string => {
  const value = process.env[name]
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`缺少或无效配置：${name}`)
  return value
}
const run = async (command: string, args: string[], signal: AbortSignal, onOutput?: (text: string) => void): Promise<void> => {
  if (signal.aborted) throw new Error('任务已中止')
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let errorOutput = ''
  child.stdout.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => { errorOutput = (errorOutput + chunk.toString()).slice(-2000) })
  const kill = (): void => { child.kill('SIGTERM') }
  signal.addEventListener('abort', kill, { once: true })
  const deadline = setTimeout(kill, 6 * 60 * 60 * 1000)
  const force = setInterval(() => { if (signal.aborted) child.kill('SIGKILL') }, 5000)
  try {
    const [code] = await once(child, 'close')
    if (signal.aborted) throw new Error('任务已中止')
    if (code !== 0) throw new Error(command === 'smbclient' ? 'SMB 上传失败，请检查 NAS 连接、权限和服务端日志' : `视频下载失败：${errorOutput.replace(/https?:\/\/\S+/g, '[视频地址]').slice(-500)}`)
  } finally { signal.removeEventListener('abort', kill); clearTimeout(deadline); clearInterval(force) }
}

// FFmpeg only receives loopback URLs. Every upstream manifest, segment, key and
// redirect goes through the same public-network validation; never expose this gateway.
const withGateway = async (sourceUrl: string, signal: AbortSignal, execute: (url: string) => Promise<void>): Promise<void> => {
  const token = randomBytes(24).toString('hex')
  const targets = new Map<string, string>()
  let base = ''
  const proxy = (target: string): string => {
    const key = String(targets.size)
    targets.set(key, target)
    return `${base}/${token}/${key}`
  }
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const match = req.url?.match(new RegExp(`^/${token}/(\\d+)$`))
      let target = match ? targets.get(match[1]) : undefined
      if (!target) { res.writeHead(404).end(); return }
      let response: Response | undefined
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const verdict = await checkUpstreamAllowed(target)
        if (!verdict.ok) throw new Error(verdict.reason)
        const url = new URL(target)
        if (url.username || url.password) throw new Error('不支持包含账号的 URL')
        response = await fetch(target, { redirect: 'manual', headers: req.headers.range ? { Range: req.headers.range } : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location || redirects === 5) throw new Error('重定向失败')
          target = new URL(location, target).href
          continue
        }
        break
      }
      if (!response?.ok || !response.body) throw new Error('上游资源不可用')
      const contentType = response.headers.get('content-type') || ''
      const reader = response.body.getReader()
      const first = await reader.read()
      const prefix = Buffer.from(first.value || [])
      if (/mpegurl/i.test(contentType) || /\.m3u8(?:[?#]|$)/i.test(target) || prefix.toString('utf8', 0, 128).trimStart().startsWith('#EXTM3U')) {
        const chunks = [prefix]
        let length = prefix.length
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.length
          if (length > 5_000_000) { await reader.cancel(); throw new Error('播放列表过大') }
          chunks.push(Buffer.from(chunk.value))
        }
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length > 5_000_000 || !text.trimStart().startsWith('#EXTM3U')) throw new Error('播放列表无效')
        const playlist = text.split(/\r?\n/).map(line => {
          if (!line.trim()) return line
          if (!line.startsWith('#')) return proxy(new URL(line.trim(), target).href)
          return line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${proxy(new URL(uri, target).href)}"`)
        }).join('\n')
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(playlist)
      } else {
        const headers: Record<string, string> = { 'Content-Type': contentType || 'application/octet-stream' }
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const value = response.headers.get(name)
          if (value) headers[name] = value
        }
        res.writeHead(response.status, headers)
        await pipeline(Readable.from((async function* () {
          yield prefix
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            yield Buffer.from(chunk.value)
          }
        })()), res)
      }
    })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('下载代理启动失败')
  base = `http://127.0.0.1:${address.port}`
  try { await execute(proxy(sourceUrl)) } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

const upload = async (task: StoredTask, file: string, authFile: string, signal: AbortSignal): Promise<void> => {
  const host = required('NAS_HOST')
  const share = required('NAS_SHARE')
  if (!/^[a-zA-Z0-9.:-]+$/.test(host) || !/^[\p{L}\p{N}_ .-]+$/u.test(share)) throw new Error('NAS 地址或共享名无效')
  const safeTitle = task.title.replace(/[^\p{L}\p{N}_ .-]/gu, '_').slice(0, 100).replace(/^[ .]+|[ .]+$/g, '') || 'video'
  const filename = `${safeTitle}-${task.id.slice(0, 8)}.mp4`
  const part = `${task.id}.part`
  const args = [`//${host}/${share}`, '-A', authFile, '--option=client min protocol=SMB2', '-t', '60']
  await run('smbclient', [...args, '-c', `put "${file}" "${part}"`], signal)
  let info = ''
  await run('smbclient', [...args, '-c', `allinfo "${part}"`], signal, text => { info += text })
  const remoteSize = /stream:\s*\[::\$DATA\],\s*(\d+)\s+bytes|size:\s*(\d+)/i.exec(info)
  if (!remoteSize || Number(remoteSize[1] || remoteSize[2]) !== (await stat(file)).size) throw new Error('NAS 文件大小校验失败，本地文件已保留')
  await run('smbclient', [...args, '-c', `rename "${part}" "${filename}"`], signal)
}
const processTask = async (task: StoredTask, authFile: string): Promise<void> => {
  const controller = new AbortController()
  activeController = controller
  const cancelTimer = setInterval(() => { if (getTask(task.id)?.status === 'cancelled') controller.abort() }, 500)
  const file = path.join(TEMP_DIR, `${task.id}.mp4`)
  const part = `${file}.part`
  try {
    const space = await statfs(TEMP_DIR)
    if (space.bavail * space.bsize < 2 * 1024 ** 3) throw new Error('临时目录可用空间不足 2GB')
    const alreadyDownloaded = await stat(file).then(s => s.size > 0).catch(() => false)
    if (!alreadyDownloaded) {
      await withGateway(task.sourceUrl, controller.signal, async url => {
        let pending = ''
        await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp,crypto', '-allowed_extensions', 'ALL', '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', part], controller.signal, text => {
          pending += text
          const lines = pending.split('\n')
          pending = lines.pop() || ''
          for (const line of lines) if (line.startsWith('out_time_us=')) {
            const seconds = Number(line.slice(12)) / 1_000_000
            if (Number.isFinite(seconds)) setProgress(task.id, seconds)
          }
        })
      })
      await rename(part, file)
    }
    if (controller.signal.aborted) throw new Error('任务已中止')
    setStatus(task.id, 'uploading')
    await upload(task, file, authFile, controller.signal)
    setStatus(task.id, 'completed')
    await rm(file, { force: true })
  } catch (error) {
    if (!stopping) setStatus(task.id, 'failed', error instanceof Error ? error.message : '任务失败')
  } finally {
    clearInterval(cancelTimer)
    activeController = undefined
    await rm(part, { force: true })
    if (getTask(task.id)?.status === 'cancelled') await rm(file, { force: true })
  }
}
const main = async (): Promise<void> => {
  if (process.env.NAS_DOWNLOAD_ENABLED !== '1') throw new Error('请设置 NAS_DOWNLOAD_ENABLED=1')
  const credentials = `username = ${required('NAS_USERNAME')}\npassword = ${required('NAS_PASSWORD')}\ndomain = ${process.env.NAS_DOMAIN || 'WORKGROUP'}\n`
  if (/[\r\n]/.test(process.env.NAS_DOMAIN || '')) throw new Error('NAS_DOMAIN 无效')
  required('NAS_HOST'); required('NAS_SHARE')
  const secretDir = await mkdtemp(path.join(tmpdir(), 'libretv-smb-'))
  const authFile = path.join(secretDir, 'credentials')
  await writeFile(authFile, credentials, { mode: 0o600 })
  // An exclusive OS-level lock is provided by flock in Docker; local users must
  // likewise run only one worker against this database.
  try {
    recover()
    while (!stopping) {
      const task = claim()
      if (task) await processTask(task, authFile)
      else await delay(1000)
    }
  } finally { getDatabase().close(); await rm(secretDir, { recursive: true, force: true }) }
}
void main().catch(() => { process.stderr.write('NAS worker 启动或运行失败，请检查配置和数据目录权限\n'); process.exitCode = 1 })
