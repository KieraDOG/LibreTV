import { NextResponse } from 'next/server'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { isPasswordConfigured, sessionFromCookieHeader } from '@/lib/auth'
import { checkUpstreamAllowed } from '@/lib/ssrf'
import { createDownloadSchema, downloadActionSchema } from '@/services/downloads/schemas'
import { cancel, enqueue, getTask, listTasks, retry, TEMP_DIR } from '@/services/downloads/repository'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const authorize = (req: Request, mutation = false): boolean => {
  if (process.env.NAS_DOWNLOAD_ENABLED !== '1' || !isPasswordConfigured()) return false
  if (mutation) {
    try {
      const origin = new URL(req.headers.get('origin') || '')
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.get('host')) return false
    } catch { return false }
  }
  try { return sessionFromCookieHeader(req.headers.get('cookie')) } catch { return false }
}
export const GET = async (req: Request): Promise<NextResponse> => {
  if (!authorize(req)) return NextResponse.json({ error: 'NAS 下载未启用或尚未登录' }, { status: 403 })
  return NextResponse.json({ tasks: listTasks() }, { headers: { 'Cache-Control': 'no-store' } })
}
export const POST = async (req: Request): Promise<NextResponse> => {
  if (!authorize(req, true)) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const parsed = createDownloadSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '下载参数无效' }, { status: 400 })
  const verdict = await checkUpstreamAllowed(parsed.data.sourceUrl)
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 })
  return NextResponse.json({ id: enqueue(parsed.data) }, { status: 202 })
}
export const PATCH = async (req: Request): Promise<NextResponse> => {
  if (!authorize(req, true)) return NextResponse.json({ error: '无权限' }, { status: 403 })
  const parsed = downloadActionSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '操作参数无效' }, { status: 400 })
  const task = getTask(parsed.data.id)
  if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 })
  if (parsed.data.action === 'cancel') {
    cancel(parsed.data.id)
    if (['failed', 'queued'].includes(task.status)) {
      await rm(path.join(TEMP_DIR, `${task.id}.mp4`), { force: true })
    }
  } else retry(parsed.data.id)
  return NextResponse.json({ ok: true })
}
