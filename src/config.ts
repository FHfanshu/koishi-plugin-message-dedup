import { Schema } from 'koishi'

export interface Config {
  enableImage: boolean
  enableLink: boolean
  enableForward: boolean
  imageSimilarityThreshold: number
  linkExactMatch: boolean
  forwardContentMaxLength: number
  forwardImageMatchMode: 'all' | 'majority'
  forwardImageSimilarityThreshold: number
  retentionDays: number
  stickerDir: string
  sendMethod: 'koishi' | 'onebot'
  excludedGuilds: string[]
  excludedUsers: string[]
  debug: boolean
}

export const Config: Schema<Config> = Schema.object({
  enableImage: Schema.boolean()
    .default(true)
    .description('启用图片去重（自动排除表情包）'),
  enableLink: Schema.boolean()
    .default(true)
    .description('启用链接去重'),
  enableForward: Schema.boolean()
    .default(true)
    .description('启用转发消息去重'),
  imageSimilarityThreshold: Schema.number()
    .default(10)
    .min(0)
    .max(32)
    .description('图片相似度阈值'),
  linkExactMatch: Schema.boolean()
    .default(true)
    .description('链接是否要求完全匹配'),
  forwardContentMaxLength: Schema.number()
    .default(500)
    .min(100)
    .max(2000)
    .description('转发消息内容摘要最大长度'),
  forwardImageMatchMode: Schema.union([
    Schema.const('all').description('全部匹配'),
    Schema.const('majority').description('过半匹配')
  ])
    .default('all')
    .description('转发消息图片匹配模式：全部匹配要求所有图片相同，过半匹配只需超半数图片相同'),
  forwardImageSimilarityThreshold: Schema.number()
    .default(10)
    .min(0)
    .max(32)
    .description('转发消息图片相似度阈值（百分比，0为完全相同）'),
  retentionDays: Schema.number()
    .default(7)
    .min(1)
    .max(30)
    .description('数据保留天数'),
  stickerDir: Schema.string()
    .default('data/emojiluna/dup')
    .description('表情包目录路径'),
  sendMethod: Schema.union([
    Schema.const('koishi').description('Koishi通用方式'),
    Schema.const('onebot').description('OneBot API直接发送')
  ])
    .default('onebot')
    .description('图片发送方式'),
  excludedGuilds: Schema.array(String)
    .default([])
    .description('排除检测的群ID列表'),
  excludedUsers: Schema.array(String)
    .default([])
    .description('排除检测的用户ID列表'),
  debug: Schema.boolean()
    .default(false)
    .description('调试模式')
})