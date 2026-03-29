import { Jimp, compareHashes } from 'jimp'
import type { Context } from 'koishi'

/**
 * 计算图片感知哈希(pHash)
 */
export async function calculateImageHash(buffer: Buffer): Promise<string> {
  const image = await Jimp.read(buffer)
  return image.pHash()
}

/**
 * 计算两个哈希的汉明距离（返回0-1，0表示相同）
 */
export function calculateHashDistance(hash1: string, hash2: string): number {
  return compareHashes(hash1, hash2)
}

/**
 * 从URL下载图片并计算哈希
 */
export async function downloadAndHashImage(
  imageUrl: string,
  ctx: Context
): Promise<string | null> {
  try {
    // 检查是否是data URI
    if (imageUrl.startsWith('data:')) {
      // data:image/png;base64,xxxxx
      const base64Match = imageUrl.match(/^data:image\/[^;]+;base64,(.+)$/)
      if (base64Match) {
        const buffer = Buffer.from(base64Match[1], 'base64')
        return await calculateImageHash(buffer)
      }
      return null
    }

    // 检查是否是file URI
    if (imageUrl.startsWith('file://')) {
      const filePath = imageUrl.slice(7)
      const fs = await import('fs')
      const buffer = fs.readFileSync(filePath)
      return await calculateImageHash(buffer)
    }

    // 使用http服务下载图片
    if (!ctx.http) {
      return null
    }

    const response = await ctx.http.get(imageUrl, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(response)
    return await calculateImageHash(buffer)
  } catch (err) {
    return null
  }
}

/**
 * 提取消息中的URL
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi
  return text.match(urlRegex) || []
}

/**
 * 计算字符串哈希（用于链接/转发消息）
 */
export function calculateStringHash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & 0xFFFFFFFF
  }
  return hash.toString(16)
}

/**
 * 标准化URL（去除跟踪参数等）
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from']
    trackingParams.forEach(p => urlObj.searchParams.delete(p))
    return urlObj.toString()
  } catch {
    return url
  }
}