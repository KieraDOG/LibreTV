import { z } from 'zod'

export const createDownloadSchema = z.object({
  title: z.string().trim().min(1).max(180),
  sourceUrl: z.string().url().max(8192).refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    } catch { return false }
  }, '仅支持 HTTP/HTTPS 视频地址'),
})
export type CreateDownload = z.infer<typeof createDownloadSchema>
export const downloadActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['cancel', 'retry']),
})
export type DownloadAction = z.infer<typeof downloadActionSchema>
export interface DownloadTask {
  id: string
  title: string
  status: 'queued' | 'downloading' | 'uploading' | 'completed' | 'failed' | 'cancelled'
  seconds: number
  error: string | null
  createdAt: number
}
