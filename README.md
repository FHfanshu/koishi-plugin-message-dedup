# koishi-plugin-message-dedup

Koishi 消息去重插件，检测群内重复的图片、链接、聊天记录。

![](assets/dup-1.jpg)

## 功能

- **链接去重**：检测重复发送的网页链接
- **转发消息去重**：检测重复的聊天记录转发
- **图片去重**：使用 pHash 感知哈希检测相似图片（默认关闭，可能误判表情包）

## 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| enableImage | 启用图片去重 | false |
| enableLink | 启用链接去重 | true |
| enableForward | 启用转发消息去重 | true |
| sendMethod | 图片发送方式 (koishi/onebot) | onebot |

## 安装

```bash
npm install koishi-plugin-message-dedup
```

## License

MIT