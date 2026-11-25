# 压缩路由

为 DSH 的上下文压缩摘要单独指定模型。

## 它解决什么

DSH 用「会话当前的路由模型」写压缩摘要。换模型时，DSH 会先按**新**模型的上下文窗口判断要不要压缩，却仍然把摘要请求发给**旧**模型：

- 旧模型的上游返回 429、或 30 秒内不吐首包时，压缩失败；
- 换模型被拒绝，错误码 `MODEL_SWITCH_COMPACTION_FAILED`，旧模型保留、新选择仍待生效；
- 之后每个 step 都会重试同一个切换并再次失败。

DSH 自带的 `summarizationProvider` / `summarizationModel` 能覆盖这条规则，但内置预设都没设置它们，设置页也没有入口。本插件把它们变成可配置项，并加上回退链。

## 机制

**拦截点**：`llm/stream`（所有模型调用的 waterfall）。压缩摘要是少数手工构造的调用之一，带 `purpose: 'compaction'` 和 `sessionId`：

```js
const options = { provider, model, messages, maxTokens, sessionId, purpose: 'compaction', signal }
```

因此一个监听器就能覆盖全部触发路径——step 压力、上下文溢出、换模型检查、手动 `/compact`——无论压缩后端是谁提供的。

**触发分类**：读会话状态，比较「已落盘的请求路由」与「待生效的模型选择」，并用压缩事务的起点事件修正：

| 状态 | 归类 | 使用的链 |
|---|---|---|
| 当前事务是手动 `/compact`（`compaction/start` 带 `sourceCommandId`） | 自动压缩 | 省钱链 |
| 已落盘路由与待生效选择不同 | 换模型 | 兜底链（默认先试会话自己的模型） |
| 其余（含无待切换） | 自动压缩 | 省钱链 |

手动压缩优先，是因为「先选新模型、还没发消息就 `/compact`」在会话状态上与换模型完全同形，只能靠事务标记区分。

**尝试顺序**：

1. 取链（会话覆盖 > 工作区覆盖 > 全局）。
2. 用 `llm.resolveModelInfo` 读路线窗口，用 `tokenMeter` 估算将被重放的前缀（消息 + 工具 schema 的 JSON 密度 + 系统文本），判断 `前缀 + 输出上限 + 安全余量 ≤ 窗口`；装不下就跳过并记下具体数字。估算不可用时放行但让服务商裁决。
3. 发起调用并缓冲所有 chunk；终态是 `error` / `aborted` / `max-tokens` 时判定这次路线失败，失败前已产生的 usage 写进日志。
4. 失败即试下一条；成功则把整段 chunk 交回调用方，并把实际路线的服务商/模型写回该请求（这样 `compaction/summary` 记录的是真实模型；`maxTokens` 记录仍归压缩后端，插件在自己的日志里注明实际上限）。
5. 全链失败：写入冷却标记并抛出带各路线失败原因的错误；冷却期内同一会话直接失败，配置一变立即解除。

**与其它压缩后端共存**：被拦截的请求自己带 `provider/model`。若它不等于会话已提交路由，说明上游（surcharge-guard 的规则摘要模型、预设级摘要设置）已显式选过模型：

| 对方 provider vs 链首 provider | 行为 |
|---|---|
| 相同 | 对方的模型先跑（带它自己的推理等级），我们的链在其后兜底；每条尝试各用各自等级 |
| 不同 | 我们的链照旧接管（跨 provider 不假设一致，可靠性优先） |
| 请求路由 = 会话路由 | 无人显式选择，按两条链处理 |

**并发与隔离**：每次尝试有独立的 `AbortController`，外部取消会立刻传播；不会重放已经产出的部分输出（chunk 先缓冲，成功才交付）。

## 配置

| 字段 | 含义 |
|---|---|
| `enabled` | 总开关 |
| `purposes` | 允许接管的辅助调用类别，默认 `compaction` |
| `requireSession` | 无 `sessionId` 的调用不接管 |
| `pressureRoutes` | 省钱链：自动压力、上下文溢出、手动 `/compact` |
| `switchRoutes` | 兜底链：换模型时的那次压缩 |
| `switchSessionFirst` | 兜底链是否先试会话自己的模型 |
| `workspaces` | `{ path, enabled, switchRoutes, pressureRoutes, sessionFirst }`；路线为 `null` 表示继承全局 |
| `safetyMarginTokens` | 窗口安全余量，默认 8192 |
| `attemptTimeoutMs` | 单次尝试空闲超时，默认 120000 |
| `failureBackoffMs` | 全失败后的冷却，默认 60000 |
| `announceReroute` | 摘要改由别的模型写时，在会话里留一行提示（`form: 'notice'` 的 user message，进入模型上下文；默认关） |

会话级覆盖由命令写入会话日志（`plugin:dsh-compaction-router/selected`，`ignorable` 标记，随会话恢复）。

## 兼容性

- 需要 DSH `0.2.2-rc.1` 及以上；开发验证于 `0.2.2-rc.5`。
- 与其他压缩后端共存：只要摘要调用经由 `ctx.llm.stream` 且带 `compaction` 标记，插件都能接管。
- 可选依赖 BetterSidebar：存在时注册一个标签页，不存在时跳过。

## 已知限制

- 每次尝试都真实计费；链越长最坏成本越高。
- 不能修复上游网关自身的首包限制；只能换路线。
- 装不下的路线会被跳过而不是分段压缩；分段摘要尚未实现。
