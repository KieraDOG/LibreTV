'use client'

import { useEffect, useState, type FC } from 'react'
import type { DownloadTask } from '@/services/downloads/schemas'

interface Props { sourceUrl: string; title: string }
const STATUS_LABELS: Record<DownloadTask['status'], string> = {
  queued: '排队中', downloading: '下载中', uploading: '上传 NAS', completed: '已完成', failed: '失败', cancelled: '已取消',
}
const NasDownloads: FC<Props> = ({ sourceUrl, title }) => {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/api/nas-downloads', { cache: 'no-store' })
      if (!response.ok) { setEnabled(false); return }
      const data = await response.json() as { tasks: DownloadTask[] }
      setEnabled(true)
      setTasks(data.tasks)
    } catch { setError('无法获取 NAS 下载状态') }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [])
  const mutate = async (method: 'POST' | 'PATCH', body: object): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/nas-downloads', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) {
        const data = await response.json() as { error?: string }
        throw new Error(data.error || '操作失败')
      }
      setOpen(true)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); setOpen(true) }
    finally { setBusy(false) }
  }
  if (!enabled) return null
  return <>
    <button className="btn-ghost btn-sm" disabled={busy || !sourceUrl} onClick={() => void mutate('POST', { sourceUrl, title })}>下载到 NAS</button>
    <button className="btn-ghost btn-sm" onClick={() => setOpen(value => !value)}>NAS 任务</button>
    {open && <section aria-label="NAS 下载任务" className="fixed right-4 top-16 z-50 max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-line bg-surface p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between"><strong>NAS 下载任务</strong><button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>关闭</button></div>
      {error && <p role="alert" className="mb-3 text-red-500">{error}</p>}
      {tasks.length === 0 && <p>还没有下载任务</p>}
      {tasks.map(task => <div key={task.id} className="border-b border-line py-3">
        <p className="break-words text-sm">{task.title}</p>
        <p className="text-xs text-faint">{STATUS_LABELS[task.status]} · 已处理 {Math.floor(task.seconds / 60)} 分 {Math.floor(task.seconds % 60)} 秒</p>
        {task.error && <p className="mt-1 text-xs text-red-500">{task.error}</p>}
        {['queued', 'downloading', 'uploading'].includes(task.status) && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void mutate('PATCH', { id: task.id, action: 'cancel' })}>取消</button>}
        {['failed', 'cancelled'].includes(task.status) && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void mutate('PATCH', { id: task.id, action: 'retry' })}>重试</button>}
      </div>)}
    </section>}
  </>
}
export default NasDownloads
