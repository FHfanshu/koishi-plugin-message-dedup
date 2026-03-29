import { Context } from 'koishi'
import { calculateHashDistance } from './hash'

declare module 'koishi' {
  interface Tables {
    message_dedup: DedupRecord
  }
}

export interface DedupRecord {
  id?: number
  guildId: string
  userId: string
  username: string
  timestamp: number
  contentType: 'image' | 'link' | 'forward'
  contentHash: string
  originalMessageId: string
  originalContent: string  // 原消息内容摘要
  extraInfo: string
}

export function extendDatabase(ctx: Context) {
  ctx.model.extend('message_dedup', {
    id: 'unsigned',
    guildId: 'string',
    userId: 'string',
    username: 'string',
    timestamp: 'integer',
    contentType: 'string',
    contentHash: 'string',
    originalMessageId: 'string',
    originalContent: 'text',
    extraInfo: 'text'
  }, {
    primary: 'id',
    autoInc: true
  })
}

export async function findDuplicate(
  ctx: Context,
  guildId: string,
  contentType: 'image' | 'link' | 'forward',
  contentHash: string,
  imageThreshold?: number
): Promise<DedupRecord | null> {
  const records = await ctx.database.get('message_dedup', {
    guildId,
    contentType
  })

  if (contentType === 'image' && imageThreshold !== undefined) {
    // 图片需要计算汉明距离
    // compareHashes返回0-1，0表示相同
    // threshold是百分比阈值（如10表示10%）
    const thresholdRatio = imageThreshold / 100
    for (const record of records) {
      try {
        const distance = calculateHashDistance(contentHash, record.contentHash)
        if (distance <= thresholdRatio) {
          return record
        }
      } catch {
        // 哈希格式不匹配时跳过
        continue
      }
    }
  } else {
    // 链接和转发消息直接匹配哈希
    return records.find(r => r.contentHash === contentHash) || null
  }

  return null
}

export async function saveRecord(ctx: Context, record: DedupRecord): Promise<void> {
  await ctx.database.create('message_dedup', record)
}

export async function cleanupOldRecords(ctx: Context, retentionDays: number): Promise<void> {
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  await ctx.database.remove('message_dedup', {
    timestamp: { $lt: cutoffTime }
  })
}