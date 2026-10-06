# human-as-llm

**把一个真人伪装成一个 OpenAI 兼容的大模型。**

客户端那边看起来在跟模型说话 —— 但背后没有模型，只有你。请求会挂起、排队、弹到你的操作台上；
**你亲手打字回复、亲手挑工具调用**，网关再把你的输出按标准的 SSE chunk 吐回去。

```
harness ──POST /v1/chat/completions──▶ 网关挂起请求
                                        │
                                        ▼
                                   /admin 控制台  ◀── 你在这里打字
                                        │
harness ◀──── SSE chunk 流式吐出 ───────┘
```

**零依赖** —— 只用 Node 内置模块，不需要 `npm install`。

---

## 30 秒跑起来

需要 Node.js 18 以上。

```bash
node server.js
```

首次启动会自动生成 `config.json`（**随机 API Key + 随机管理密码**），并打印在终端：

```
  大肥狗AI 已启动 —— 现在你本人就是那个模型
  ──────────────────────────────────────────────────────────
  控制台（你回复的地方）: http://127.0.0.1:8787/admin
  管理密码              : hm-xxxxxxxxxxxxxxxx
  模型名                : fat-dog
  可用 API Key          :
    default      sk-me-xxxxxxxxxxxxxxxxxxxx
  ──────────────────────────────────────────────────────────
```

打开控制台、用管理密码登录，就完事了。

Windows 上想省事可以再跑一次 `python make_shortcut.py`（需要 `pip install pylnk3`），
它会在桌面和开始菜单放一个控制面板快捷方式 —— 里面的路径全部从脚本位置推导，换台机器也能跑。

## 控制台怎么用

**待回复列表**实时刷新，新请求进来有提示音 + 标题闪烁 + 系统通知。
选中一条能看到：system prompt、完整对话上下文、客户端声明的工具 schema。

### 回复正文

- 敲完点「**发送全部**」，服务端按打字机节奏吐给客户端；点「**结束回复**」结束本轮（`Ctrl+Enter`）。
- 也可以勾上「**打字即流式**」，边打边推。**默认关着是有原因的**：SSE 的正文增量在客户端
  **只往后接**，你退格改字的话对方已经收到的部分收不回来。勾上后一旦发生这种错位，
  输入框上方会弹黄色警告告诉你对方停在哪。
- 中文输入法组字期间（拼音 + 候选词编号）不会往外推，等候选词上屏才推 ——
  所以不会出现「打出来的字里混进 1、2、3」。

### 发图 / 收图

- **发图**：点「插入图片」，或者直接把截图 `Ctrl+V` 粘进输入框。图片上传到网关换回一个短链接，
  回复框里自动插入 `![文件名](https://…/att/xxxx.png)`。
  对方渲染 markdown 就直接看到图，不渲染也能点开链接。
- **收图**：对方发来的图片会**直接渲染出来**，点一下看原图。

> 两个性质：**附件是公网可访问的**（链接本身就是凭证）；**存在内存里，进程重启就没了**。
> 上限 10 MB。图片也不进历史归档（一张图几 MB，存进去文件会爆）。

### 工具调用

先搞清楚客户端用哪套协议，两套完全不同：

**A. XML 文本协议**（Cline、Roo Code 这类）—— 什么面板都不用点，直接在输入框里手写标签：

```
我需要先读一下这个文件。

<read_file>
<path>C:/proj/README.md</path>
</read_file>
```

**B. 标准 function calling**（dsh、Continue、各类 SDK）—— 请求里带 `tools` 数组，点开「工具调用」面板：

1. 顶部可按名字/描述**筛选**工具（agent 一次能带 27 个）
2. 下拉选一个 —— 会**记住你上次用的**，换任务切回来不用重找
3. 参数框按 JSON Schema 自动生成骨架
4. 两个按钮：「**发送并结束回合**」/「**先攒着，再发一个**」（一个回合里发多个 = parallel tool calls）
5. 参数框里 `Ctrl+Enter` 快捷发送

> 判断用哪套：看控制台显示「工具 · 0」还是「工具 · N」。

### 历史记录

右上角「**历史**」能翻看每一轮对话的完整内容：对方问的什么、你当时回了什么、调了哪些工具。
搜索框搜提问、你的回复、以及对话正文。

**自动保存三层：**

| 存在哪 | 内容 | 扛得住 |
|---|---|---|
| 项目目录的 `history.jsonl` | 全部对话，最多 1000 条 | 服务重启 |
| 浏览器的 `localStorage` | 最近 200 条 | **重新部署** |
| 浏览器的 `localStorage` | 最近 30 个任务的输入框草稿 | 刷新页面 |

> **为什么还要在浏览器存一份** —— 部署平台上 `history.jsonl` 同时也是部署产物，
> 重新发布会把远端存档换成你本机那份（通常更旧）。打开历史时会按 id 合并两边、
> 本地已有的全文优先，所以重发之后照样翻得到。

## 让别人调用你

控制台右上角「密钥」里，每把 Key 有两条件链接可以直接复制发给别人：

- **邀请链接（简短版）** `/quick?key=<key>` —— 一屏读完，地址已经填好
- **完整手册** `/guide?key=<key>` —— 多了排错对照表和原理说明

### 地址格式（最容易踩的坑）

```
https://<你的域名>/k/<API Key>/v1
```

**密钥必须写在 URL 路径里。** 很多部署平台的反代会**覆盖 `Authorization` 请求头**、
**剥掉 `x-api-key` 之类的自定义头** —— 只有 URL 路径不在改写范围内。

所以标准 OpenAI 客户端的 `Authorization: Bearer sk-...` 在反代后面可能永远过不了校验。
网关对此做了兼容，会依次尝试：
路径 `/k/<key>` → `Authorization` → `x-api-key` → `api-key` → 查询串 `?api_key=`。

> 实测（WorkBuddy Sites 的 TencentEdgeOne 网关）：它会塞进自己的 JWT 到 `Authorization`、
> 删掉 `x-api-key`，只有 `x-admin-token` 能透传。所以**路径带密钥是最稳的做法**，
> 换任何平台都不会错。

**别把教程页的地址填进客户端的「API 地址」** —— `/quick?key=…` 是给人看的网页，
填进去会报 `Stream ended without finish_reason`。网关检测到这种误用会直接回一条能看懂的 JSON。

## 部署到公网

任何能跑单个 HTTP 端口的地方都行。两个硬性要求：

1. **监听 `PORT` 环境变量**（网关已经支持，本机跑则用 `config.json` 里的 `port`）
2. **绑定 `0.0.0.0`**

```bash
PORT=3000 node server.js
```

部署完把域名填进 `config.json` 的 `publicUrl`，页面里的地址、控制面板的快捷方式都会自动用它。

> ⚠️ **重新部署会重启进程，内存里待回复的请求会全部丢失。** 发布前先看一眼控制台里有没有人在等。

## 客户端接入

各家的详细配置（dsh / Codex / Cline / Cherry Studio / Continue / curl）见 **[CLIENTS.md](CLIENTS.md)**。

## 配置项

`config.json`（首次启动自动生成；**不要提交进版本库**，里面有你的密钥）：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | `8787` / `0.0.0.0` | 监听地址 |
| `productName` | `human-as-llm` | 页面标题、品牌名 |
| `publicUrl` | 空 | 部署后的公网地址，如 `https://xxx.example.com` |
| `modelId` | `me-1` | 对外暴露的模型名，客户端要填这个 |
| `modelDisplayName` | `Me (human)` | 展示名 |
| `adminPassword` | 随机生成 | 控制台登录口令 |
| `apiKeys` | 随机生成一把 | 发给别人的调用密钥 |
| `rateLimitPerMinute` | `30` | 单 key 每分钟请求上限 |
| `maxPending` | `50` | 排队上限 |
| `requestTimeoutMinutes` | `30` | 一条请求等多久自动放弃 |
| `heartbeatSeconds` | `15` | SSE 心跳间隔 |
| `maxBodyMB` / `maxUploadMB` | `8` / `10` | 请求体 / 图片上传上限 |

## 安全清单（暴露到公网前）

- [ ] **换掉管理密码。** 控制台是公网可达的，而 API Key 就写在 URL 路径里 ——
      任何拿到 Key 的人都顺带知道了域名，可以直接去 `/admin` 试密码。
      首次启动生成的随机密码就够了，**别改成短词**。（启动时密码少于 8 位会警告。）
- [ ] 登录失败限流已内置：同一 IP 累计错 4 次封 1 分钟、6 次封 5 分钟、8 次封 30 分钟。
- [ ] 附件是公网可访问的，别上传敏感内容。
- [ ] `config.json` 和 `history.jsonl` 都不要提交（`.gitignore` 已经排除）。

## 已知限制

- **Codex CLI 用不了** —— 它 0.148.0 起移除了 Chat Completions 支持，只认 Responses API
  （`POST /v1/responses`），本网关没实现。
- **Anthropic Messages 协议（`POST /v1/messages`）没实现** —— 客户端如果选了
  「Anthropic」协议会 404。改用 OpenAI Chat Completions 那一档。
  同理 OpenAI Responses（`openai` / `xAI` 模板）也不支持。
- 非流式请求超过心跳间隔也不会挂（心跳只对流式生效），但**真人回复本来就要等**，
  客户端超时别设太短。
- 图片和待回复请求都在内存里，进程重启即失；历史对话会落盘。

## 目录结构

```
server.js            零依赖网关（HTTP + SSE + 控制台 API）
control.js           本机控制面板：启停服务 / 看 Key / 看日志
control.cmd          控制面板的 cmd 入口
start.cmd            前台启动（带日志窗口）
public/console.html  你的操作台
public/index.html    给外人看的说明页
public/quick.html    一屏版调用教程
public/guide.html    完整手册（含排错对照表）
test-client.js       模拟 harness 的测试客户端
make_icon.py         生成图标（需要 Pillow）
make_shortcut.py     生成桌面快捷方式（需要 pylnk3）
config.example.json  配置模板
history.jsonl        对话归档（运行期生成，不入库）
CLIENTS.md           各客户端接入配置
```

## 许可

MIT
