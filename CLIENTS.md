# 接入各个 CLI 客户端

## 零、先记住两条

**1. 模型名填你自己的。** 下面出现的 `<模型名>` 换成 `config.json` 里的 `modelId`
（默认是 `me-1`，本项目作者用的是 `fat-dog`）。填错客户端会报 `model not found`。

**2. 公网必须把 key 写进路径。**

| 你连的是 | API 地址怎么写 | 密钥栏 |
|---|---|---|
| **公网** `<你的域名>` | `https://<你的域名>/k/<你的API Key>/v1` | 随便填 |
| **本机** `127.0.0.1:8787` | `http://127.0.0.1:8787/v1` | 填 `sk-me-...` |

因为发布平台的边缘网关会覆盖 `Authorization` 头、剥掉 `x-api-key`，只有 URL 路径能原样带过去。
详见 README「让别人调用你」一节。

---

## 一、dsh（DeepSeek Harness）— ✅ 已实测通过

本机版本 `0.1.5-rc.2`。它说 OpenAI Chat Completions，正好对得上。

### 方式 A：Web UI（最省事）

`npx @deepseek-ai/dsh web` → `Settings → Models → 添加自定义提供方`：

| 字段 | 填什么 |
|---|---|
| Provider ID | `DOGLLM`（**大小写敏感**，保存后**永久不可改**） |
| 显示名称 | `我自己` |
| 基础 URL | `https://<你的域名>/k/<你的API Key>/v1` |
| API 协议 | `OpenAI Chat Completions` |
| API Key | 随便填（真正生效的是 URL 里那段） |
| 模型列表 | 手动填 `<模型名>` |

### 方式 B：`$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）

```yaml
llm-pi-ai:
  providers:
    DOGLLM:
      apiKeyEnv: DOGLLM_API_KEY
      api: openai-completions
      baseURL: https://<你的域名>/k/<你的API Key>/v1
      models:
        - id: <模型名>
          name: <模型名>
          contextWindow: 200000
          maxTokens: 8192
agent-default-model:
  provider: DOGLLM
  model: <模型名>
```

```bash
export DOGLLM_API_KEY=dummy      # 必须非空，否则报 MISSING_CREDENTIAL
dsh web
```

`apiKeyEnv` 只是让 dsh 别抱怨缺凭据，它的值不重要 —— 真正的鉴权在 URL 里。

### 方式 C：desktop profile 的 `cordis.patch.yml`

本机 `~/.dsh/profiles/desktop/cordis.patch.yml` 用的是 patch 层，往数组里加一项：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      DOGLLM:
        apiKeyEnv: DOGLLM_API_KEY
        api: openai-completions
        baseURL: https://<你的域名>/k/<你的API Key>/v1
        models:
          - id: <模型名>
            name: <模型名>
            contextWindow: 200000
            maxTokens: 8192
```

⚠️ 这个文件里**已经有一项 `llm-pi-ai`**（挂着你的 `zai` 和 `openrouter`）。
不要新加一项同 id 的，而是把 `DOGLLM` 追加进**现有的 `providers` 下面**，
否则会把 ZAI / openrouter 覆盖掉。

### 实测记录

```
$ DSH_HOME=... dsh --profile headless "请只回复四个字：公网收到"
  [1] 代答任务 req_5dbb922099758da396c48573
  [2] 代答任务 req_35d2c4456d4786797ed8bc8b
公网收到
EXIT=0
```

**dsh 是个 agent，第一发请求就带 25 个工具定义**：

```
create_goal  edit  exit_plan_mode  get_goal  glob  grep  interrupt_agent
job_kill  job_list  job_output  list_agents  pwsh  ralph  read  read_image
send_message  skill  subagent  subagent_fork  todo_write  update_goal
web_fetch  web_search  workflow  write
```

走的是标准 OpenAI function calling（不是 Claude 那种 XML 协议），所以中控台的
「工具调用 ▾」面板是能用的：选工具 → 参数框自动按 JSON Schema 生成骨架 → 发送。

**但它不会只问你一次。** dsh 拿到回复后可能继续发下一轮（它要读文件、跑命令才能推进任务），
所以一次任务通常要你回好几轮。上面那个测试就回了 2 次。

---

## 二、Codex CLI — ❌ 当前接不上

本机版本 `codex-cli 0.148.0`。实测：

```bash
$ codex exec -c model_providers.DOGLLM.wire_api="chat" ...
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
in `model_providers.DOGLLM.wire_api`
```

**Codex 已经彻底移除 Chat Completions 协议，现在只认 OpenAI 的 Responses API**
（`POST /v1/responses`）。而 大肥狗AI 实现的是 `/v1/chat/completions`。

顺带说明：Codex 的 `base_url` 是**追加** `/responses`，不是 `/chat/completions`，
所以就算把 key 塞进路径也没用 —— 路径对了，端点和协议还是不对。

### 想让它能用的唯一办法

给 大肥狗AI 加一层 **Responses API 适配**，具体要写：

1. `POST /v1/responses` 路由，接受 `input` 数组（`{type:"message", role, content:[{type:"input_text",text}]}`）
   和 `instructions`，而不是 chat 的 `messages`
2. 工具定义另一种扁平结构（`{type:"function", name, description, parameters}`，没有 `function` 包一层）
3. SSE 事件流是**带类型的事件**而不是纯 delta：
   `response.created` → `response.output_item.added` → `response.content_part.added`
   → `response.output_text.delta`（若干）→ `response.output_text.done`
   → `response.content_part.done` → `response.output_item.done` → `response.completed`
4. 工具调用走 `function_call` output item + `response.function_call_arguments.delta`
5. 中控台要能按 Responses 的结构回复

工作量大概是现有中控台工具面板的一倍。**做不做等你一句话。**

---

## 三、Cline / Roo Code — ✅ 理论上可用，未实测

API Provider 选 **OpenAI Compatible**：

| 字段 | 值 |
|---|---|
| Base URL | 公网：`https://.../k/<你的API Key>/v1`；本机：`http://127.0.0.1:8787/v1` |
| API Key | 随便填 / `sk-me-...` |
| Model ID | `<模型名>` |
| Context Window | `200000` |

⚠️ 两件事：**把请求超时调到 10 分钟以上**（默认 60 秒，你打字慢了会被判超时），
以及 **Cline / Roo 用的是 XML 文本工具协议**（直接在正文里写 `<read_file><path>…</path></read_file>`），
不是 function calling —— 所以别去点中控台的工具面板，直接在输入框手打标签。

---

## 四、Cherry Studio / NextChat / LobeChat — ✅

纯聊天客户端，不涉及工具协议，最省事。加一个 OpenAI 提供商，
Base URL 按上面表格填，模型名 `<模型名>`。

---

## 五、curl

```bash
# 公网
curl -N https://<你的域名>/k/<你的API Key>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","stream":true,"messages":[{"role":"user","content":"在吗"}]}'

# 本机
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-me-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","stream":true,"messages":[{"role":"user","content":"在吗"}]}'
```
