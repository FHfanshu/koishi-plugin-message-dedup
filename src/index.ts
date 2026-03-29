import { Context, Session, h } from 'koishi'
import { Config } from './config'
import { downloadAndHashImage, extractUrls, calculateStringHash, normalizeUrl } from './hash'
import { extendDatabase, findDuplicate, saveRecord, cleanupOldRecords, DedupRecord } from './database'
import * as fs from 'fs'
import * as path from 'path'

export const name = 'message-dedup'

export const inject = {
  required: ['database'],
  optional: ['http']
} as const

export { Config }

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('message-dedup')

  // 扩展数据库模型
  extendDatabase(ctx)

  // 定期清理过期数据
  const retentionDays = config.retentionDays ?? 7
  if (retentionDays > 0) {
    ctx.setInterval(() => {
      cleanupOldRecords(ctx, retentionDays).catch(err => {
        logger.error('清理过期数据失败:', err)
      })
    }, 24 * 60 * 60 * 1000)
  }

  // 中间件处理消息
  ctx.middleware(async (session, next) => {
    // 只处理群消息
    if (!session.guildId) return next()

    // 检查是否在排除列表
    if (config.excludedGuilds.includes(session.guildId)) return next()
    if (session.userId && config.excludedUsers.includes(session.userId)) return next()

    try {
      const result = await processMessage(session, config, ctx, logger)
      if (result) {
        await sendDuplicateWarning(session, result, config, ctx)
        return
      }
    } catch (err) {
      if (config.debug) {
        logger.error('处理消息失败:', err)
      }
    }

    return next()
  })

  if (config.debug) {
    logger.info('message-dedup 插件已加载（调试模式）')
  }
}

async function processMessage(
  session: Session,
  config: Config,
  ctx: Context,
  logger: any
): Promise<DedupRecord | null> {
  const elements = session.elements
  if (!elements || elements.length === 0) return null

  const username = session.author?.nickname || session.author?.username || session.username || '未知用户'
  const originalContent = session.content || extractTextFromElements(elements) || ''

  // 1. 检查图片
  if (config.enableImage) {
    for (const elem of elements) {
      if (elem.type === 'img' && elem.attrs?.src) {
        const duplicate = await processImage(
          elem.attrs.src, session, username, originalContent, config, ctx, logger
        )
        if (duplicate) return duplicate
      }
    }
  }

  // 2. 检查链接
  if (config.enableLink) {
    const text = extractTextFromElements(elements)
    const urls = extractUrls(text)
    for (const url of urls) {
      const duplicate = await processLink(
        url, session, username, originalContent, config, ctx, logger
      )
      if (duplicate) return duplicate
    }
  }

  // 3. 检查转发消息
  if (config.enableForward) {
    if (config.debug) {
      logger.info(`检查转发消息, elements types: ${elements.map(e => e.type).join(', ')}`)
    }
    for (const elem of elements) {
      if (elem.type === 'forward') {
        const duplicate = await processForward(
          elem, session, username, originalContent, config, ctx, logger
        )
        if (duplicate) return duplicate
      }
    }
  }

  return null
}

function extractTextFromElements(elements: h[]): string {
  return elements.map(elem => {
    if (elem.type === 'text') {
      return elem.attrs?.content || ''
    }
    if (elem.children && elem.children.length > 0) {
      return extractTextFromElements(elem.children)
    }
    return ''
  }).join('')
}

async function processImage(
  imageUrl: string,
  session: Session,
  username: string,
  originalContent: string,
  config: Config,
  ctx: Context,
  logger: any
): Promise<DedupRecord | null> {
  try {
    if (config.debug) {
      logger.info(`处理图片: ${imageUrl}`)
    }

    const hash = await downloadAndHashImage(imageUrl, ctx)
    if (!hash) {
      if (config.debug) {
        logger.info(`无法计算图片哈希`)
      }
      return null
    }

    if (config.debug) {
      logger.info(`图片哈希: ${hash}`)
    }

    const guildId = session.guildId!
    const duplicate = await findDuplicate(
      ctx, guildId, 'image', hash, config.imageSimilarityThreshold
    )

    if (duplicate) {
      if (config.debug) {
        logger.info(`发现重复图片`)
      }
      return duplicate
    }

    await saveRecord(ctx, {
      guildId: session.guildId!,
      userId: session.userId!,
      username,
      timestamp: Date.now(),
      contentType: 'image',
      contentHash: hash,
      originalMessageId: session.messageId!,
      originalContent,
      extraInfo: JSON.stringify({ url: imageUrl })
    })

    return null
  } catch (err) {
    if (config.debug) {
      logger.error('处理图片失败:', err)
    }
    return null
  }
}

async function processLink(
  url: string,
  session: Session,
  username: string,
  originalContent: string,
  config: Config,
  ctx: Context,
  logger: any
): Promise<DedupRecord | null> {
  try {
    const normalizedUrl = config.linkExactMatch ? url : normalizeUrl(url)
    const hash = calculateStringHash(normalizedUrl)

    if (config.debug) {
      logger.info(`链接哈希: ${hash} URL: ${url}`)
    }

    const guildId = session.guildId!
    const duplicate = await findDuplicate(ctx, guildId, 'link', hash)

    if (duplicate) {
      if (config.debug) {
        logger.info(`发现重复链接`)
      }
      return duplicate
    }

    await saveRecord(ctx, {
      guildId: session.guildId!,
      userId: session.userId!,
      username,
      timestamp: Date.now(),
      contentType: 'link',
      contentHash: hash,
      originalMessageId: session.messageId!,
      originalContent,
      extraInfo: JSON.stringify({ url })
    })

    return null
  } catch (err) {
    if (config.debug) {
      logger.error('处理链接失败:', err)
    }
    return null
  }
}

async function processForward(
  forwardElem: h,
  session: Session,
  username: string,
  originalContent: string,
  config: Config,
  ctx: Context,
  logger: any
): Promise<DedupRecord | null> {
  try {
    if (config.debug) {
      logger.info(`处理转发消息, elem: ${JSON.stringify(forwardElem, null, 2)}`)
    }

    // 直接通过OneBot API获取转发消息内容
    let content = ''
    if (forwardElem.attrs?.id && session.platform === 'onebot' && session.bot?.internal) {
      try {
        const forwardId = forwardElem.attrs.id
        if (config.debug) {
          logger.info(`调用get_forward_msg获取转发内容, id: ${forwardId}`)
        }

        // 使用与 chatluna-forward-msg 相同的 API 调用方式
        const internal = session.bot.internal
        let forwardData: any = null

        // 尝试多种 API 调用方式
        if (typeof internal._get === 'function') {
          forwardData = await internal._get('get_forward_msg', { message_id: forwardId })
        } else if (typeof internal.request === 'function') {
          forwardData = await internal.request('get_forward_msg', { message_id: forwardId })
        } else if (typeof internal.callAction === 'function') {
          forwardData = await internal.callAction('get_forward_msg', { message_id: forwardId })
        } else if (typeof internal.getForwardMsg === 'function') {
          forwardData = await internal.getForwardMsg(forwardId)
        }

        if (config.debug) {
          logger.info(`get_forward_msg原始返回: ${JSON.stringify(forwardData).slice(0, 500)}`)
        }

        // 从多种可能的数据结构中提取 messages 数组
        const messages = extractMessagesArray(forwardData)
        if (messages && Array.isArray(messages)) {
          content = messages.map((node: any) => {
            if (node.message) {
              return node.message
                .filter((m: any) => m.type === 'text')
                .map((m: any) => m.data?.text || '')
                .join('')
            }
            return ''
          }).join('\n')
        }

        if (config.debug) {
          logger.info(`get_forward_msg解析后内容: "${content.slice(0, 200)}"`)
        }
      } catch (err) {
        if (config.debug) {
          logger.warn(`获取转发消息内容失败:`, err)
        }
        return null
      }
    } else {
      // 非OneBot平台，尝试从元素中提取
      content = extractForwardContent(forwardElem)
    }

    if (!content) {
      return null
    }

    const truncated = content.slice(0, config.forwardContentMaxLength)
    const hash = calculateStringHash(truncated)

    if (config.debug) {
      logger.info(`转发消息哈希: ${hash}, 内容长度: ${content.length}`)
    }

    const guildId = session.guildId!
    const duplicate = await findDuplicate(ctx, guildId, 'forward', hash)

    if (duplicate) {
      if (config.debug) {
        logger.info(`发现重复转发消息`)
      }
      return duplicate
    }

    await saveRecord(ctx, {
      guildId: session.guildId!,
      userId: session.userId!,
      username,
      timestamp: Date.now(),
      contentType: 'forward',
      contentHash: hash,
      originalMessageId: session.messageId!,
      originalContent: truncated.slice(0, 100),
      extraInfo: JSON.stringify({ preview: truncated.slice(0, 100) })
    })

    return null
  } catch (err) {
    if (config.debug) {
      logger.error('处理转发消息失败:', err)
    }
    return null
  }
}

function extractForwardContent(elem: h): string {
  let content = ''

  if (elem.attrs?.content) {
    content += elem.attrs.content
  }

  if (elem.attrs?.text) {
    content += elem.attrs.text
  }

  if (elem.children && elem.children.length > 0) {
    for (const child of elem.children) {
      content += extractForwardContent(child)
    }
  }

  return content
}

/**
 * 从多种可能的数据结构中提取 messages 数组
 * 参考 chatluna-forward-msg 的实现
 */
function extractMessagesArray(data: any): any[] | null {
  const candidates = [
    data,
    data?.messages,
    data?.data,
    data?.result,
    data?.response,
    data?.data?.messages,
    data?.response?.messages,
    data?.envelope?.result?.messages,
  ]
  for (const item of candidates) {
    if (Array.isArray(item)) {
      return item
    }
  }
  return null
}

async function sendDuplicateWarning(
  session: Session,
  duplicate: DedupRecord,
  config: Config,
  ctx: Context
) {
  const date = new Date(duplicate.timestamp)
  const dateStr = date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })

  const message = `此条news已被其他群友发布过\n原消息：${dateStr}\n发送人：${duplicate.username}`

  // 随机选择表情包
  const stickerFile = getRandomSticker(ctx.baseDir, config.stickerDir)

  // 根据配置选择发送方式
  if (config.sendMethod === 'onebot' && session.platform === 'onebot' && session.bot?.internal) {
    const groupId = Number(session.guildId)
    try {
      // 使用 reply CQ码引用原消息
      const originalMsgId = duplicate.originalMessageId
      let cqMessage = `[CQ:reply,id=${originalMsgId}]${message}`

      // 添加表情包
      if (stickerFile) {
        const imageBase64 = fs.readFileSync(stickerFile).toString('base64')
        cqMessage += `[CQ:image,file=base64://${imageBase64}]`
      }

      await session.bot.internal.sendGroupMsg(groupId, cqMessage)
      return
    } catch (err) {
      // OneBot 发送失败，回退到 Koishi 方式
    }
  }

  // Koishi 通用方式，使用 quote 引用
  if (stickerFile) {
    const imageBase64 = fs.readFileSync(stickerFile).toString('base64')
    const ext = path.extname(stickerFile).slice(1).toLowerCase()
    const mimeType = ext === 'jpg' ? 'jpeg' : ext
    await session.send([
      h.quote(duplicate.originalMessageId),
      message,
      h.img(`data:image/${mimeType};base64,${imageBase64}`)
    ])
  } else {
    await session.send([h.quote(duplicate.originalMessageId), message])
  }
}

/**
 * 从表情包目录随机选择一张图片
 * 如果目录不存在或为空，使用插件内置默认表情包
 */
function getRandomSticker(baseDir: string, stickerDir: string): string | null {
  const supportedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

  // 尝试用户配置的目录
  const userDir = path.resolve(baseDir, stickerDir)
  if (fs.existsSync(userDir)) {
    const files = fs.readdirSync(userDir)
      .filter(f => supportedExtensions.some(ext => f.toLowerCase().endsWith(ext)))
    if (files.length > 0) {
      const randomFile = files[Math.floor(Math.random() * files.length)]
      return path.join(userDir, randomFile)
    }
  }

  // 尝试插件内置默认表情包目录
  const pluginAssetsDir = path.resolve(__dirname, '../assets')
  if (fs.existsSync(pluginAssetsDir)) {
    const files = fs.readdirSync(pluginAssetsDir)
      .filter(f => supportedExtensions.some(ext => f.toLowerCase().endsWith(ext)))
    if (files.length > 0) {
      const randomFile = files[Math.floor(Math.random() * files.length)]
      return path.join(pluginAssetsDir, randomFile)
    }
  }

  return null
}