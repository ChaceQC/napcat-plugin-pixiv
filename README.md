# NapCat Pixiv 插件

基于 NapCat 的 Pixiv 插画搜索与推荐插件，支持合并转发消息发送。

## ✨ 功能

- **关键词搜索** — `#p站 关键词`，搜索 Pixiv 插画并返回 3 张结果
- **随机推荐** — `#p站`，获取 Pixiv 个性化推荐的 3 张插画
- **合并转发** — 搜索结果以合并转发消息发送，包含图片、标题、作者和 ID
- **R-18 过滤** — 可配置是否允许 R-18 内容
- **同群冷却** — 同一群内所有命令共享冷却时间，防止刷屏
- **WebUI 管理** — 内置 Web 控制面板，支持在线配置和群管理

## 📋 命令列表

| 命令 | 说明 |
|------|------|
| `#p站` | 随机推荐 Pixiv 插画 |
| `#p站 关键词` | 搜索关键词并返回插画 |

> 命令前缀 `#` 可在 WebUI 中自定义。
> 支持群聊和私聊使用，私聊不受冷却时间限制。

## ⚙️ 配置

### 必要配置

| 配置项 | 说明 |
|--------|------|
| Pixiv Refresh Token | Pixiv API 认证令牌（必填） |

### 可选配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用插件 | `true` | 全局开关 |
| 调试模式 | `false` | 输出详细日志 |
| 命令前缀 | `#` | 触发命令的前缀 |
| 冷却时间 | `60` 秒 | 同群命令冷却，0 表示不限制 |
| R-18 | `false` | 是否允许 R-18 内容 |
| 搜索匹配模式 | 标签模糊匹配 | 支持标签模糊/精确匹配、标题和简介 |
| 搜索排序方式 | 最新发布 | 按热度排序需要 Pixiv Premium 会员 |
| 返回图片数量 | `3` | 每次返回的图片数（1-10） |

所有配置均可在 WebUI 仪表盘中修改，修改后立即生效。

## 🚀 安装

### 方式一：从 Release 安装

1. 从 [GitHub Releases](https://github.com/ChaceQC/napcat-plugin-pixiv/releases) 下载最新版本的 zip 包
2. 解压到 NapCat 的 `plugins` 目录
3. 重新加载 NapCat 或重启

### 方式二：手动构建

```bash
# 安装依赖
npm install

# 构建
npm run build
```

构建产物在 `dist/` 目录下，将其复制到 NapCat 的插件目录即可。

## 🔧 获取 Pixiv Refresh Token

可以参考 [pixiv-auth](https://github.com/eggplants/get-pixivpy-token) 等工具获取 Pixiv Refresh Token。或使用以下方法：


**1. 安装工具**
确保你已经安装了 Python。在终端中运行以下命令：
```bash
pip install gallery-dl
```

**2. 运行 Pixiv 专属授权命令**
在终端输入并执行：
```bash
gallery-dl oauth:pixiv
```

**3. 按提示完成操作**
1. 终端会输出一个很长的 Pixiv 官方登录 URL，并提示你用浏览器打开。
2. 在浏览器（建议用电脑端 Chrome/Edge）中打开该链接，按下 `F12` 打开开发者工具，切换到 **Network（网络）** 面板。
3. 正常完成登录和人机验证。
4. 登录完成后，页面可能会变白或报错（属于正常现象）。在网络面板里找到最后一个名为 `callback?state=...` 的请求。
5. 复制该请求的 `code` 参数的值（一串很长的字符）。
6. 将这个 `code` 粘贴回刚才的终端命令行并回车，`gallery-dl` 就会自动为你结算出最新的 Refresh Token。

## 📁 项目结构

```
napcat-plugin-pixiv/
├── src/
│   ├── index.ts              # 插件入口
│   ├── config.ts             # 配置定义
│   ├── types.ts              # TypeScript 类型
│   ├── core/
│   │   └── state.ts          # 全局状态管理
│   ├── handlers/
│   │   ├── message-handler.ts # 消息处理（命令解析、冷却、工具）
│   │   └── pixiv-handler.ts   # Pixiv 命令处理（搜索、推荐、转发）
│   ├── lib/
│   │   └── pixiv-client.ts    # Pixiv API 客户端
│   ├── services/
│   │   ├── api-service.ts     # WebUI API 路由
│   │   └── pixiv.service.ts   # Pixiv 业务逻辑
│   └── webui/                 # React WebUI 前端
├── package.json
├── vite.config.ts
└── README.md
```

## 📄 许可证

MIT License
