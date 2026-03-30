import { Context, Session, h } from 'koishi'
import { Config } from './config'
import { downloadAndHashImage, extractUrls, calculateStringHash, normalizeUrl } from './hash'
import { extendDatabase, findDuplicate, saveRecord, cleanupOldRecords, DedupRecord, compareForwardMessages, ForwardExtraInfo } from './database'
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

  // 1. 检查图片（排除表情包：subType=1）
  if (config.enableImage) {
    for (const elem of elements) {
      if (elem.type === 'img' && elem.attrs?.src) {
        // 表情包 subType 为 1，跳过
        const subType = elem.attrs['sub-type'] ?? elem.attrs.subType
        if (subType === 1 || subType === '1') {
          if (config.debug) {
            logger.info('跳过表情包')
          }
          continue
        }
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

    // 检测异常哈希（如全0或几乎全0），跳过处理避免误判
    if (isAbnormalHash(hash)) {
      if (config.debug) {
        logger.warn(`异常图片哈希，跳过: ${hash}`)
      }
      return null
    }

    if (config.debug) {
      logger.info(`图片哈希: ${hash}`)
    }

    const guildId = session.guildId!
    const currentTime = Date.now()
    const duplicate = await findDuplicate(
      ctx, guildId, 'image', hash, config.imageSimilarityThreshold,
      session.userId, currentTime
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
    const currentTime = Date.now()
    const duplicate = await findDuplicate(ctx, guildId, 'link', hash,
      undefined, session.userId, currentTime)

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
      logger.info(`处理转发消息, elem: ${JSON.stringify(forwardElem.attrs, null, 2)}`)
    }

    // 获取转发消息 ID
    const forwardId = forwardElem.attrs?.id
    if (!forwardId) {
      return null
    }

    // 转发消息内容
    let textParts: string[] = []
    let images: Array<{ url: string; hash: string | null }> = []
    let apiSuccess = false

    // 先尝试通过 OneBot API 获取转发消息内容
    if (session.platform === 'onebot' && session.bot?.internal) {
      const internal = session.bot.internal

      // 尝试多种 payload 格式
      const payloads = [
        { message_id: forwardId },
        { id: forwardId },
      ]

      // 尝试多种 API 调用方式
      const callApi = async (action: string, params: any): Promise<any> => {
        if (typeof internal._get === 'function') {
          return await internal._get(action, params)
        }
        if (typeof internal.request === 'function') {
          return await internal.request(action, params)
        }
        if (typeof internal.callAction === 'function') {
          return await internal.callAction(action, params)
        }
        return null
      }

      for (const payload of payloads) {
        try {
          const forwardData = await callApi('get_forward_msg', payload)
          if (forwardData) {
            const messages = extractMessagesArray(forwardData)
            if (messages && Array.isArray(messages) && messages.length > 0) {
              apiSuccess = true
              if (config.debug) {
                logger.info(`转发消息节点数量: ${messages.length}`)
              }

              // 提取文本和图片
              for (const node of messages) {
                const msgArray = node.message || node.content || node.data
                if (Array.isArray(msgArray)) {
                  for (const m of msgArray) {
                    if (m.type === 'text') {
                      textParts.push(m.data?.text || m.text || '')
                    }
                    if (m.type === 'image') {
                      const url = m.data?.url || m.data?.file || m.url || m.file || ''
                      if (url) {
                        // 下载图片并计算哈希
                        let hash: string | null = null
                        try {
                          hash = await downloadAndHashImage(url, ctx)
                          if (hash && isAbnormalHash(hash)) {
                            if (config.debug) {
                              logger.warn(`转发消息图片哈希异常，跳过: ${hash}`)
                            }
                            hash = null
                          }
                        } catch (err) {
                          if (config.debug) {
                            logger.warn(`转发消息图片下载失败: ${url.slice(0, 50)}...`)
                          }
                        }
                        images.push({ url, hash })
                      }
                    }
                  }
                }
                // 兼容字符串格式
                if (typeof node.content === 'string') {
                  textParts.push(node.content)
                }
                if (typeof node.text === 'string') {
                  textParts.push(node.text)
                }
              }
              break
            }
          }
        } catch (err) {
          // API 调用失败，继续尝试
        }
      }
    }

    // 提取有效图片哈希列表
    const imageHashes = images.filter(img => img.hash !== null).map(img => img.hash!)
    const failedImages = images.filter(img => img.hash === null).length

    // 计算文本哈希
    const textContent = textParts.join('\n').trim()
    const textToHash = textContent.slice(0, config.forwardContentMaxLength)
    const textHash = textContent ? calculateStringHash(textToHash) : calculateStringHash(forwardId)

    if (config.debug) {
      logger.info(`转发消息: 文本长度=${textToHash.length}, 图片=${imageHashes.length}, 失败=${failedImages}, API成功=${apiSuccess}`)
    }

    const guildId = session.guildId!
    const currentTime = Date.now()

    // 使用新的比较函数查询重复消息
    const duplicate = await compareForwardMessages(
      ctx, guildId,
      textHash, imageHashes,
      config.forwardImageMatchMode,
      config.forwardImageSimilarityThreshold,
      session.userId, currentTime
    )

    if (duplicate) {
      if (config.debug) {
        logger.info(`发现重复转发消息`)
      }
      return duplicate
    }

    // 保存记录
    const extraInfo: ForwardExtraInfo = {
      forwardId,
      preview: textToHash.slice(0, 100),
      textHash,
      imageHashes,
      imageCount: images.length,
      failedImages
    }

    await saveRecord(ctx, {
      guildId: session.guildId!,
      userId: session.userId!,
      username,
      timestamp: Date.now(),
      contentType: 'forward',
      contentHash: textHash,
      originalMessageId: session.messageId!,
      originalContent: textToHash.slice(0, 100),
      extraInfo: JSON.stringify(extraInfo)
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

/**
 * 检测哈希是否异常（如几乎全0或全1）
 * 异常哈希会导致误判，应跳过处理
 */
function isAbnormalHash(hash: string): boolean {
  // pHash 通常是64位十六进制或二进制
  // 统计0和1的比例，如果比例极端则认为异常

  // 如果是二进制格式（64位）
  if (hash.length === 64 && /^[01]+$/.test(hash)) {
    const zeros = hash.split('0').length - 1
    const ones = hash.split('1').length - 1
    // 如果超过90%是同一个值，认为异常
    if (zeros >= 58 || ones >= 58) {
      return true
    }
  }

  // 如果是十六进制格式
  if (/^[0-9a-fA-F]+$/.test(hash)) {
    // 检查是否几乎全是0或几乎全是f
    const nonZeroCount = hash.replace(/0/gi, '').length
    const nonFCount = hash.replace(/f/gi, '').length
    // 如果超过90%是同一个值
    if (nonZeroCount <= hash.length * 0.1 || nonFCount <= hash.length * 0.1) {
      return true
    }
  }

  return false
}