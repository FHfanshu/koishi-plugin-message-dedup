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

/**
 * 转发消息额外信息结构
 */
export interface ForwardExtraInfo {
  forwardId: string
  preview: string        // 文本预览（前100字符）
  textHash: string       // 文本内容的哈希
  imageHashes: string[]  // 图片哈希列表（按顺序）
  imageCount: number     // 图片总数
  failedImages: number   // 下载失败的图片数量
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

/**
 * 同一用户自身重复的时间窗口（毫秒）
 * 在此时间窗口内，同一用户的重复消息不会被判定为重复
 */
const SELF_DUPE_WINDOW_MS = 5 * 60 * 1000 // 5分钟

export async function findDuplicate(
  ctx: Context,
  guildId: string,
  contentType: 'image' | 'link' | 'forward',
  contentHash: string,
  imageThreshold?: number,
  currentUserId?: string,
  currentTime?: number
): Promise<DedupRecord | null> {
  let records = await ctx.database.get('message_dedup', {
    guildId,
    contentType
  })

  // 按时间戳升序排序，确保返回最早匹配的记录（原消息）
  records = records.sort((a, b) => a.timestamp - b.timestamp)

  if (contentType === 'image' && imageThreshold !== undefined) {
    // 图片需要计算汉明距离
    // compareHashes返回0-1，0表示相同
    // threshold是百分比阈值（如10表示10%）
    const thresholdRatio = imageThreshold / 100
    for (const record of records) {
      // 同一用户 5 分钟内的重复不算重复
      if (currentUserId && currentTime &&
          record.userId === currentUserId &&
          currentTime - record.timestamp <= SELF_DUPE_WINDOW_MS) {
        continue
      }
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
    return records.find(r => {
      // 同一用户 5 分钟内的重复不算重复
      if (currentUserId && currentTime &&
          r.userId === currentUserId &&
          currentTime - r.timestamp <= SELF_DUPE_WINDOW_MS) {
        return false
      }
      return r.contentHash === contentHash
    }) || null
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

/**
 * 比较转发消息是否重复
 * 使用文本哈希 + 图片哈希组合匹配
 */
export async function compareForwardMessages(
  ctx: Context,
  guildId: string,
  newTextHash: string,
  newImageHashes: string[],
  imageMatchMode: 'all' | 'majority',
  imageThreshold: number,
  currentUserId?: string,
  currentTime?: number
): Promise<DedupRecord | null> {
  const records = await ctx.database.get('message_dedup', {
    guildId,
    contentType: 'forward'
  })

  // 按时间戳升序排序，确保返回最早匹配的记录（原消息）
  const sortedRecords = records.sort((a, b) => a.timestamp - b.timestamp)

  const thresholdRatio = imageThreshold / 100

  for (const record of sortedRecords) {
    // 同一用户 5 分钟内的重复不算重复
    if (currentUserId && currentTime &&
        record.userId === currentUserId &&
        currentTime - record.timestamp <= SELF_DUPE_WINDOW_MS) {
      continue
    }

    let extra: ForwardExtraInfo
    try {
      extra = JSON.parse(record.extraInfo)
    } catch {
      // 兼容旧记录格式，跳过
      continue
    }

    // 1. 文本哈希必须匹配
    if (extra.textHash !== newTextHash) continue

    const newCount = newImageHashes.length
    const oldCount = extra.imageHashes?.length || 0

    // 2. 无图片情况：纯文本匹配
    if (newCount === 0 && oldCount === 0) {
      return record
    }

    // 3. 单边无图片：不匹配
    if (newCount === 0 || oldCount === 0) {
      continue
    }

    // 4. 全部匹配模式：数量必须相同
    if (imageMatchMode === 'all' && newCount !== oldCount) {
      continue
    }

    // 5. 计算图片匹配数
    const matchedCount = countImageMatches(newImageHashes, extra.imageHashes, thresholdRatio)
    const totalCount = Math.max(newCount, oldCount)

    // 6. 根据模式判断是否匹配
    if (imageMatchMode === 'all') {
      if (matchedCount === newCount && newCount === oldCount) {
        return record
      }
    } else { // majority
      if (matchedCount > totalCount / 2) {
        return record
      }
    }
  }

  return null
}

/**
 * 计算两个图片哈希列表的匹配数量
 * 使用贪心算法：每个新图片找最相似的未匹配旧图片
 */
function countImageMatches(
  hashes1: string[],
  hashes2: string[],
  threshold: number  // 0-1 之间的阈值
): number {
  let matchCount = 0
  const used = new Set<number>()

  for (const h1 of hashes1) {
    for (let i = 0; i < hashes2.length; i++) {
      if (used.has(i)) continue

      try {
        const distance = calculateHashDistance(h1, hashes2[i])
        if (distance <= threshold) {
          matchCount++
          used.add(i)
          break
        }
      } catch {
        // 哈希格式错误，跳过
        continue
      }
    }
  }

  return matchCount
}