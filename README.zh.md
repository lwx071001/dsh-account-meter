# account-balance — DSH 插件：余额 · token · 时长 · 速率 · 用量统计

[English](README.md) | **中文**

> **这是什么**：**DSH Harness Web UI** 的客户端插件（bundle 形态，MIT 许可）。需要你已经有一个
> 可用的 Harness —— 它不自带数据源，四个数字全部读自 Harness 自己的余额接口与 token 投影。

在 Harness Web UI **输入框下方那条统计带**里（内建 token 药丸右侧）显示四个实时数字，
并在**设置 → 账户与统计**里提供开关与一份用量台账（分时 / 每天 / 每月曲线，总 token、
平均每秒总 token、平均每秒输出 token、每百万与每千万 token 的金额；分时图可任选一天与时段）。

<img width="484" alt="输入框下方那条状态行：余额 ¥5.42 · 本对话 213.9M tok · 1h06m · 53.5K tok/s" src="https://github.com/user-attachments/assets/4285aa72-fb02-43f6-b146-4a1b78e07113" />

```
⚡ 12.3K tok/s · 缓存命中 88%        余额 ¥1,234.56 · 本对话 12.3K tok · 1m24s · 146 tok/s
└──────── 内建 stats（order 0）────┘ └──────────── 本插件（order 10）────────────┘
```

- **余额**：DeepSeek 账户可用金额（充值 + 赠送，按币种求和），点击刷新；
- **本对话 token 总量**：未命中输入 + 缓存命中 + 缓存写 + 输出；
- **运行时长**：对话运行时计时、空闲时暂停；
- **每秒 token**：token 总量 ÷ 运行时长。

**可安装产物是 [`plugin/`](plugin/README.md)**（安装、设置页与核对细节见那份文档）。

## 安装

**前提**：你已经在用 DSH Harness（Web UI）。这个插件离开它没有意义 —— 它读的是 Harness 自己的
余额接口与 token 投影，不自己去任何地方取数。

1. 克隆到任意目录：

   ```
   git clone https://github.com/lwx071001/dsh-account-meter.git
   ```

2. 让 agent 把这个目录下的 `plugin/` 作为 bundle 装进当前 profile —— `target` 换成**你自己的
   克隆路径**（仓库根目录的下一级就是 `plugin/`）：

   ```
   plugin_manager  action: install_bundle  target: <你的克隆路径>/plugin
   ```

   安装器负责 pnpm 安装、选入 `dsh.profile.bundles`、接入 bundle 自带的 patch 行 —— **不要**手写
   profile 的 `package.json` / `cordis.patch.yml`。也可以走侧边栏 **Plugins** 页面「添加」。

3. **刷新页面（F5）**。输入框下方那条统计带上会多出余额、本对话 token、运行时长与每秒 token；
   **设置 → 账户与统计**里出现开关与统计页。逐条核对清单见 [`plugin/README.md`](plugin/README.md)。

> **本机备注（不是通用步骤）**：这台机器的 profile `desktop` 已装好，而且是 **link** 安装 ——
> 改 `client.js` 后刷新页面即生效，不需要重装、不需要重启 Harness。浏览器半在页面启动时按
> `window.__DSH_BOOT__` 拉取注册，运行中的页面不会自己换代码。

## 目录

| 路径 | 作用 |
|---|---|
| [`plugin/`](plugin/README.md) | **可安装的 bundle**：`package.json` + `cordis.patch.yml` + `index.js`（宿主半）+ `client.js`（浏览器半）+ `icon.svg` + `locale/` |
| [`tools/check-bundle.mjs`](tools/check-bundle.mjs) | 离线自测（592 项断言）`node tools/check-bundle.mjs` |
| [`tools/asar.mjs`](tools/asar.mjs) | 读 Electron `app.asar` 的最小工具 —— 本次调研靠它读到随包发布的官方实现与文档 |

> **另有 4 个摘录文件只留在本机，不随仓库发布**（`.gitignore` 已排除）：`account-controller-README.md`、
> `usage-projection.js`、`session-stats-projection.js`、`host-runner-README.md`。它们是随 Harness 包一起
> 发布的官方账户控制器文档与两处投影实现的**摘录**，当初用来核对 token 口径与余额来源 —— 它们不是本项目
> 的代码，放进公开仓库等于转发他人代码，因此不发布。设计结论已全部写进本文，不依赖它们也能读懂。

## 关键设计决定

### 1. 四个数字都取自 Harness 已有的事实来源

| 数字 | 来源 | 为什么不是别的 |
|---|---|---|
| 余额 | `ctx.remote.account.getBalance(...)` → `@deepseek-ai/dsh-api-account-controller` → Host `ctx.deepseekAccount` | 该服务说明原文：*"only Host consumers can obtain a request credential"*。不拿 `DEEPSEEK_API_KEY` 去请求公开的 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) —— 那会另立一套授权判断，并在换 key / 登出后与真实登录态脱节 |
| token 总量 | 随包发布的 `tokenUsage` 投影（`@deepseek-ai/dsh-token-meter`） | 它已把每个 Assistant attempt 折成四个**互斥**桶，同 `(turn, step)` 替换而非累加，`llm/retry-started` 关闭替换槽让重试只算一次。自己再 fold 一份 = 同一数字的第二份定义 |
| 运行状态 | `useSessionStatus(state => state.get(sessionId)?.running)` | 已装包 Agent-Team 面板判断成员活动用的就是它 |
| 运行时长 | 客户端秒表，按 `running` 起停 | 见下 |
| 输出速率 | `sessionStats` 的 `decodeMs` / `decodeTokens`（同一个投影键，已装 chat 面板也在读） | 首字等待与工具执行不在这两项里，所以相除得到的是"写得多快"；见第 4 节 |

`tokenUsage` 的四个桶名就是互斥性的证明：输入侧 = `uncachedInputTokens + cacheReadTokens +
cacheWriteTokens`（内建 `StatsPills` 的 `billedInputTokens()` 正是这么算的），`reasoningTokens`
已含在 `outputTokens` 内，所以**总量 = 四者相加**。

### 2. 计时为什么是"秒表"而不是累加已完成耗时

最接近的现成数据是 `sessionStats` 的 `llmMs`（`step/start → assistant/message`）与 `toolMs`
（`tool/call → tool/result`）。它们**只在边界闭合时累加**，因此：

- 无法实时跳动 —— 一个长 step 跑 30 秒，这两个数纹丝不动；
- **被取消的 step 完全不进账**（源码注释明说：*A cancelled step assembles no message, so its
  partial stream time stays uncounted in every time figure*）。

用户要的是"对话运行时开始计时，结束时停止"，那就该直接观测会话的 `running`，而不是用两个只记
成功跨度的计数器去近似。

（同一份投影的 `decodeMs` / `decodeTokens` 反而被「输出速率」用上了 —— 见第 4 节：那里要的恰恰
就是"只记成功跨度"。同一个性质，对"跑了多久"是缺陷，对"写得多快"是前提。）

### 3. 用量台账：四列共用一个窗口

台账是三层汇总（小时 / 天 / 月）+ 全时段总额，存在 `localStorage`。四个关键决定：

**第一次看见某个会话，只建立基线，不记任何用量。** 这条是整份台账能成立的前提。
`tokenUsage` 与 `sessionStats` 都是**整份持久日志的累计值**；如果第一次读数就当成"新增"，**打开
一个旧会话的那一瞬间，它的全部历史会被记成"现在发生的"**。金额却永远只能来自安装之后观察到的
余额下降 —— 于是 token 列覆盖历史、金额列覆盖观察窗口。

这不是假想：这条记录里 `总 token` 显示 **149,622,412**、`记录时长` **51m59s**、`累计消耗金额`
**¥2.28**，于是「每百万 token」算出 **¥0.01** —— 比任何真实单价低两个数量级。三列其实是三个窗口：
token 是**整份历史**（我核对过磁盘上 24 个会话的投影，整份日志合计 393,441,551 token，台账里这
149.6M 就是其中被"第一次看见"过的那些），时长是**插件自己的秒表**（从第一次看见该会话才走），
金额是**观察到的余额下降**。所以「平均每秒总 token」和「每百万 token 的金额」都是"一个窗口除以
另一个窗口"，数值再自洽也毫无意义 —— 这正是当初报告"金额似乎有问题"的根因。

现在四列共用同一个窗口：**台账开始记录以来观察到的用量**，页面上直接写着这行说明。

**增量记账**。台账记住每个会话**已经记过多少**，只把增量记进当前时段。没有这份记忆，刷新页面
会把整段对话历史当成"刚刚发生"再记一遍。这份记忆也是"重设"能安全进行的原因 —— 有了它，
任何会话的历史都不可能被记第二次。

**读数变小时重新定基，而不是记负数**。会话计数器可能因 fork 或投影重置而回落；沿用旧高点会让
之后所有增长都被吞掉。所以**四个计数器各自独立**重新定基 —— token 回落不会丢掉同一读数里真实
新增的时长，解码段回落也不会吃掉另外三个。**读数缺失则保留原值**（不是当成 0）：把"投影还没发布"
读成"解码段归零"，下一次推送就会把整段解码重新记一遍；同理，**第一次读数缺失时存的是 `null`
（还不知道）而不是 0** —— 否则投影到达时又会把整段历史当成新增，把刚修好的 bug 原样放回来。
基线（增量为 0）也**不落空桶**，否则曲线上会凭空多出一个"那一小时消耗 0"的点。

**金额来自余额的减少量**。Harness 里不存在价格数据（*no consumer reports spend — so this is the
absence of a fact, not a configurable rate*），所以不猜单价：只观察账户余额，**降低**记为消耗，
**充值**只重设基线，**第一次读数只建立基线**。因此「每百万 token 的金额」是实测等效单价，
「每千万」是同一口径放大十倍。

**键升级到 `usage.v2`，旧文档只提取两样东西**：`seen`（每个会话"已经记过多少"）与余额基线；
其余归零。被丢掉的总数不是数据，而是一次**测量误差的撤回** —— 旧文档仍原样留在 `usage.v1` 上。
理由与「清空统计」完全一样：重设需要 `seen`，而它就在旧文档里。

**保留不限时，于是键形校验成了唯一的门**。以前靠"只留最新 N 个"顺手把垃圾一起裁掉；现在不裁剪，
改由 `BUCKET_PATTERN` 逐字段校验键的形状（`YYYY-MM-DDTHH` / `YYYY-MM-DD` / `YYYY-MM`）——
读进来的键必须能是 `bucketKey` 写出来的。三种键都零填充、定宽，所以**字符串排序就是时间排序**，
画图与日期选择器共用同一条规则，不需要解析日期。

**代价是文档会一直长，所以占用必须看得见**。设置页底部给出实测占用（台账 / 运行时长记录 / 旧版
台账 / 显示偏好各自的字节数与条数，加合计与配额占比）。三个刻意的选择：

- **实测，不是记账**：每次渲染直接枚举 `localStorage`。只有存储本身知道"每个会话一条的运行时长键"
  有多少条，推算出来的计数迟早和实际漂开 —— 两者由不同代码、在不同时刻写入。
- **按浏览器计费口径算**：`(键长 + 值长) × 2`。`localStorage` 存 UTF-16，配额也这么扣；本插件写进去的
  全是 ASCII，所以"内容字节数"恰好是这个数的一半。要回答的是"离配额还有多远"，就该用配额的口径。
- **写入被拒会顶掉这一行**：配额满了以后 `setItem` 抛异常，此前是**静默吞掉**的 —— 页面继续在内存里
  记账，一刷新全没。现在这一行变成橙色警告。这也是"不限时"的真实终局，不是假设。

### 4. 输出速率只除"输出时间"

「平均每秒输出 token」**不除以运行时长**，而是除以 provider 自己计时的那段**解码时长**：`sessionStats`
投影从**首个流式 token** 量到消息装配完成得到 `decodeMs`，同时给出这些 step 上报的 `decodeTokens`。
首字等待（prefill）、工具执行、以及任何非输出 token **都不在这两项里**。

**分子分母必须同源**。拿 `tokenUsage` 的输出总量去除以这个时长，会把从未被计时的 token 算进来；
拿这里的 token 去除以运行时长，等于让模型为它没在写的时间买单。所以两项都取自 `decodeMs` /
`decodeTokens` 这一对 —— 与已装 chat 面板读的是同一个投影键。

这不是自创口径：**内建 `StatsPills` 药丸算的就是这个式子**（`dsh-client-ui-chat/lib/client.js`：
`stats.decodeTokens / (stats.decodeMs / 1e3)`，同样的 `useProjection("sessionStats")`，
同样的 slot prop）。本插件的「平均每秒输出 token」是它的**台账级平均**：跨已记录的全部会话，
而不是当前这一段。

### 5. 缓存命中率照抄官方口径，不自己发明

内建药丸已经把定义写好了：

```js
// dsh-client-ui-chat/lib/client.js
const billedInputTokens = usage => usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
const cacheHitPercent = usage => formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))
```

**缓存命中 ÷ 提示词侧**，**输出 token 不计入**。输出必须排除：命中率描述的是"提示词被复用了多少"，
把输出算进分母会让它仅仅因为模型多写了几段话就下降。`tokenBuckets()` 的 `input` 字段正是
`billedInputTokens`，台账新增的 `inputTokens` / `cacheReadTokens` 就是这一对。

**分母为 0 时返回 null**（"没有可相除的提示词"），而不是一个自信的 0%。

**显示上照抄了那条不肯凑整到 100% 的规则**：99.6% 显示为 `99.6%`，只有恰好全命中才显示 `100%`。
因为"几乎全命中"和"全命中"是关于计费的两个不同事实，而混为一谈正好错在**会谎报一次没发生的
缓存命中**这个方向上。

这一对是后加的，旧 `seen` 记录里没有它们（读作 `null`，按"还不知道"处理而非 0）。所以缓存命中率的
统计窗口从升级那一刻开始，与总 token 有一段一次性偏差，随时间收敛；要一开始就完全对齐，按一次
「清空统计」即可 —— 它会保留 `seen` 与余额基线，所以不会把历史重记一遍。

### 6. 分时图的窗口交给用户

分时页多一组选择器：日期下拉（只列有记录的日期、最新在前、默认最新那天）+ 起 / 止两个小时下拉，
只画这一天的这一段，并在窗口右侧给出**该段自己的合计**。日期列表与时段过滤都是纯函数
（`hourDays` / `hourRangeEntries`），所以"能选什么"和"选了之后画什么"都能被断言。

每天 / 每月不加选择器，它们是总览；也正因如此，下方八项汇总**始终是全台账口径** —— 缩窄图表
不会悄悄改写下面的数字。窗口选空时给的是"这一段没有记录"而不是"还没有记录"，避免把读者引去
怀疑记数没在工作。

### 7. 曲线图手写 SVG，不引入图表库

纯 JS bundle 没有可用的图表库，也不该为此加依赖。几何计算抽成纯函数 `chartGeometry`，所以缩放
能被直接断言而不是靠眼睛看：最大值恰好落在上沿、单点居中、**全零系列不做除零**、折线点串正确。
颜色只用主题 token，每个数据点带原生 `<title>` 悬停提示。

### 8. 为什么偏好与台账放浏览器 `localStorage`

官方设置路径是：宿主半用 `@deepseek-ai/schemastery` 声明 `Config`，客户端 `ctx.configForms.get(命名空间)`
读写，值落进用户设置文档（`ui-conversation` 的「Composer Enter」就是这样）。本插件没走：

- `@deepseek-ai/schemastery` 在 `app.asar` 内，profile 的 `node_modules/@deepseek-ai` 是空的，
  纯 JS bundle 无法解析它；`ctx.configForms` 也不在客户端 Service 目录里，只能 `ctx.get()` 软取；
- 宿主半一旦有真实模块，改浏览器半就从"刷新页面"升级为"**重启 Harness**"。

所以这块状态放浏览器 `localStorage` —— 与同一 profile 里的 `theme-studio` 一致的选择。
设置页**本身**仍注册在官方位置 `settings.section`，观感与其他设置页统一。

### 9. 为什么用 Remote + 投影，而不是 `host.call` 或自建 HTTP 路由

| 通道 | 结论 |
|---|---|
| 浏览器半的 `host.call(method, args)` 内建 | ❌ **只属于动态 Cordis 包**。`dsh-cordis-client-runner` 原文：浏览器半拿到固定一组名字 `React, console, styles, host`，由动态包运行时提供；持久化 bundle 走 `window.__ModuleLoader__`，拿不到 |
| Host 自建 HTTP 路由（`ctx.webServer.register`）+ 前端 `fetch` | ❌ 可行但多余。Web 载体**带鉴权**（实测未授权请求返回 `401`），自建路由要么重复一套鉴权，要么绕开它 |
| **Remote 命名空间 + 标准 slot props** | ✅ 官方客户端插件正是这样用；`useProjection` / `useSessionStatus` 都是 composer dock 的标准 prop |

### 10. 实时性：三个推送，一个轮询

| 数字 | 机制 |
|---|---|
| token 总量 | 推送（投影注册表） |
| 运行状态 | 推送（会话状态 store） |
| 运行时长 | 运行中每秒 tick 一次；空闲不动 |
| 输出速率 | 推送（`sessionStats` 投影在消息装配时步进） |
| 余额 | 轮询：成功 60s、失败退避 15s；重新可见 / 获得焦点 / 点击时立即读；`document.hidden` 跳过 |
| 台账写入 | 只在台账真的变化时写，且每秒最多一次（依赖用秒级量化值，不是毫秒时钟） |

### 11. 配色：一套颜色家族，靠字重分主次

标签与分隔符用 `--dsw-alias-label-tertiary`，**四个数字共用** `--dsw-alias-label-secondary` +
`font-weight: 500`。状态色**只作用于余额那一格** —— 早期把 tone 类挂在根节点上，余额读取失败会把
token 数字一起染成琥珀色。现在类名由纯函数 `rowClasses(tone)` 计算，并有不变量断言锁住。
设置页里的下拉（`.ab-select`）沿用同一套边框与圆角 token，与药丸按钮同族。

**同排的邻居穿什么，这一行就穿什么。** profile 里的 `dsh-liquid-glass` 皮肤会给输入框下方那排指标
套一层玻璃胶囊，而它**按位置**取目标 —— `[data-slot='conversation.composer.dock'] > :first-child`，
命中的是内建 `stats`；它假定这个 dock 里只有一个 occupant，本插件注册的第二个就落在了外面。

本插件因此**镜像**那层胶囊，作用域与它同源（`body[data-dsh-liquid-glass]`）并读同一批 `--lg-*`
变量：皮肤关掉时规则不生效、两边都朴素，皮肤开着时两边同款；皮肤自己的模糊 / 着色 / 圆角一改，
两个胶囊一起动。刻意**不**镜像 `height` / `overflow` / `text-overflow` / `white-space` —— 皮肤用它们
截断一条不能换行的文字，而这一行是会**换行自己格子**的设计，把余额的尾数裁掉比多出一行更糟。

跨插件的声明复制一定会腐坏，所以自测里有一条断言：只要 `liquid-glass` 的源码在旁边，就把那 13 条
共享声明与本插件镜像的**逐条比对**。根因在该插件的选择器（"只有一项"的代理写法）；从源头修只需把
`> :first-child` 改成 `> *`，本插件的镜像即可删掉 —— 这里选择镜像，是为了不改别人的插件、也不让
那条规则去影响将来可能注册进这个 dock 的其它内容。

**同一排最右边那个上下文圈同理。** 官方把它渲染成 dock anchor 的**兄弟节点**而不是 occupant，所以
按位置找 occupant 的皮肤也够不到它；本插件用**兄弟关系 + 控件角色**（`~ * button[aria-haspopup]`）
定位，不碰官方模块里每次构建都会变的哈希类名。它是那一排里唯一会打开面板的胶囊，所以 hover 与展开
态被**额外还回去** —— 否则本条规则的高优先级会顶掉原生 hover 填色，交互反馈就没了。

### 12. 宿主半是空的，而且是设计结论

四个数字都已有 Host owner，而台账与偏好是纯呈现状态。本插件不注册 Service、不监听事件、不注册
投影、不加工具，停用整包时没有任何东西需要回收。但 plugin row 必须存在（bundle 的 patch 插入
entry，Loader 要解析对应的包），所以 `index.js` 只导出最小的插件出口。

## 设置页

**设置 → 账户与统计**（`settings.section`，`order: 13`，在 Models 10 与 Plugins 15 之间）：

- **显示内容**：总开关「显示状态行」+ 四个明细开关（余额 / token 总量 / 运行时长 / 每秒 token），
  明细开关在总开关关闭时置灰禁用；
- **用量统计**：分时 / 每天 / 每月页签 → 分时窗口选择器（日期 + 起 / 止时段）→ 曲线图 → 八项汇总
  （总 token、记录时长、平均每秒总 token、平均每秒输出 token、平均缓存命中率、累计消耗金额、
  每百万 token 金额、每千万 token 金额）→ 清空统计（两步确认，4 秒自动解除）；
- **存储占用**：台账 / 运行时长记录 / 旧版台账 / 显示偏好各自的实测大小与条数，加合计与配额占比；
  配额写满时会变成橙色警告。

<img width="620" alt="设置页的八项汇总：总 token 384,301,631 · 记录时长 2h21m · 平均每秒 45.3K tok/s · 平均每秒输出 261 tok/s · 缓存命中 99.6% · 累计 ¥18.21 · 每百万 ¥0.04 · 每千万 ¥0.47" src="https://github.com/user-attachments/assets/1fa7a8e2-95d7-4c8f-9892-7d6abe30b2f5" />

改动即时生效——状态行与设置页共用一个快照 store。清空后保留"已记过多少"的记忆与余额基线，
所以是"从现在重新计"，而不是把当前对话历史再记一遍。

## 可调项

| 位置 | 常量 | 默认 | 含义 |
|---|---|---|---|
| `plugin/client.js` | `REFRESH_MS` | `60000` | 余额成功后的轮询间隔（毫秒） |
| `plugin/client.js` | `RETRY_MS` | `15000` | 余额失败后的重试间隔（毫秒） |
| `plugin/client.js` | `PERSIST_EVERY_TICKS` | `5` | 运行中每多少秒回写一次计时 |
| `plugin/client.js` | `BUCKET_PATTERN` | 三种键形 | 不裁剪之后，唯一拦住畸形键的东西 |
| `plugin/client.js` | `STORAGE_QUOTA_BYTES` | `5 MiB` | 算占比用的配额估计，不强制、不影响记账 |
| `plugin/client.js` | `CHART_DOT_LIMIT` | `120` | 超过多少个点就不再画悬停圆点（折线一直在） |
| `plugin/client.js` | `DEFAULT_SETTINGS` | 全开 | 默认显示项 |
| `plugin/client.js` | `CSS` | — | 配色与排版 |

## 验证记录

```
node tools/check-bundle.mjs     # 592 项断言，全部通过
```

十三层：**执行**（含**整文件编译**，factory 内的语法错误也会在此失败）、**清单**、**金额运算**、
**时长/速率/偏好**、**缓存命中率**、**用量台账**、**v1→v2 迁移**、**存储占用**、**余额格子分支**、
**解码段**、**运行时长记录**、**分时窗口**、**曲线几何**、**配色不变量**、**词典**、**渲染冒烟**。

**渲染冒烟**是最后补上的，因为前面所有断言都只验证纯函数 —— 而用户**看到**的东西全部经过组件，
组件里崩掉只会让整页空白，离线断言一个字都不会说。做法是把插件 `apply` 到一个桩上下文以捕获它
注册的两个组件，用一个最小 React 替身（`createElement` 建树、hook 只取值不执行 effect）渲染一次，
再遍历文本断言：设置页与状态行都能渲染、出现预期标签、**出现预期数字**、空分组不出现、
缺少可选 hook prop 时降级而不是抛错。

这一层**验证过它有牙齿**：把 `StorageSection` 的 `labels` 键改错一个，它立刻报
`the rendered settings page shows "统计台账"`；把 entries 计数断言写成 2（实际每组 1 条）也立刻失败。

这套断言在开发中抓到过十二个真实缺陷：金额表示在 `parseMoney`（幅度）与 `addMoney`（带符号）
之间自相矛盾；负数分位截断与官方格式化器不一致；tone 类挂在根节点导致余额出错时 token 一起变色；
词典死键扫描漏掉 `t(v ? 'on' : 'off')` 这种三元用法；设置页行键与 `DEFAULT_SETTINGS` 的对应关系
需要显式锁定；**会话读数回落后没有重新定基**，会让台账在用量持续增长时纹丝不动；把"读数缺失"
（投影尚未发布）与"读数归零"混为一谈的写法 —— 那会在下一次推送时把整段解码重新记一遍；以及
**第一次看见会话就把它的整份日志记成"刚刚发生"**，让 token 列覆盖历史、金额列覆盖观察窗口，
`每百万 token 的金额` 因此低两个数量级。

最近一轮又抓到四个，都属于"某一个状态没人处理"：

1. **余额格子的判断链以 `else` 收尾，吞掉了"已登录但无可读钱包"**（钱包金额字符串解析失败会被
   丢弃，所以 `rows: []` 是真实结果）。它落到默认分支，于是**永久显示"读取中…"** —— 一个不会
   自行解析的标签。现在这个状态由纯函数 `balanceCase` 显式命名，六个分支全部可断言。
2. **以 prop 传入的 hook 被条件调用**：`useProjection` / `useSessionStatus` 是 hook，写成
   `typeof props.useX === 'function' ? props.useX(...) : ...` 会在判断翻转时改变 hook 数量，
   React 直接中止渲染（"Rendered fewer hooks than expected"），整个槽变空。现在改为**常量替身 +
   无条件调用**，缺 prop 时照常降级。
3. **`compactRate` 在 10–1000 区间复用了计数格式化器**：`compactTokens` 对整数计数直接 `String(v)`，
   用在**商**上就把 `16.67` 渲染成 `16.666666666666668 tok/s`。自测里该区间的取值**恰好都是整数**，
   所以一直没暴露。
4. **运行时长会在离开时丢掉正在跑的那一段，而且会倒退**。这条是**独立审查**发现的（见下）：
   `useRunningTime` 的 interval cleanup 只清定时器、不写回，写路径只剩"每 5 秒一次 tick"和
   "running 翻 false"。切换会话 / 关标签页 / 刷新时，最后一段直接丢；**标签页在后台时 `setInterval`
   被浏览器节流到约每分钟一次**，丢的量可达几分钟。表现是状态行显示 `1m24s`，切走再切回来变成
   `1m21s` —— 计时器往回走。

   修法两条：cleanup 里**按秒表状态现场算一次再写回**（而不是复用上次渲染算好的数字 —— 后台节流
   之后那个数字已经过期几分钟），以及把 `writeDuration` 变成**高水位线**（永不回退），这样排队中
   的 tick 也无法把更小的旧值盖回去。

前三条是我自己审查找到的；第 4 条来自一次**独立审查**（把纯数据层与 React 层分别交给两个不同
视角跑）。独立审查同时跑了差分 fuzz —— 用 BigInt 写 `parseMoney` 的参考实现对比 20000 个随机用例、
4000 步随机台账操作验证"总额 = 桶之和"、`normalizeLedger` 幂等性、`hourDays`/`hourRangeEntries`
对参考实现 —— **没有找到反例**，并在早期快照里独立发现了同一个 `balanceCase` 问题。

实时运行态（已实测）：

| 检查 | 结果 |
|---|---|
| `install_bundle` 返回 | `application: "applied"`，`warnings: []`（首版安装） |
| 组合树（`Config.listConfigs`，`name: "@local/account-balance"`） | `include:account-balance` 已存在 |
| `Slots.listSubTree` `root: "conversation.composer.dock"` | `stats`(order 0) + `{ id: "account-balance", order: 10, active: true }` ✅ |
| `Slots.listSubTree` `root: "settings.section"` | 含 `{ id: "account-balance", order: 13, active: true }`，正好在 Models(10) 与 Plugins(15) 之间 ✅ |
| 槽位标准 props | `conversation.composer.dock` 自己声明了 `useProjection` 与 `useSessionStatus` —— 本插件取数用的正是这两条官方通道 ✅ |
| 投影键可用性 | `@deepseek-ai/dsh-web-app/cordis.patch.yml` 组合了 `session-stats`；已装 `dsh-client-ui-chat` 的 `StatsPills` 就在同一个槽位用 `useProjection("sessionStats")` ✅ |

两侧槽位都已在**运行中的页面**里注册，说明上一次刷新已经把统计页带了上来。本轮改动（台账基线 +
v2 迁移）之后需要**再刷新一次**：浏览器半在页面启动时按 `window.__DSH_BOOT__` 拉取注册，运行中的
页面不会自己换代码。宿主半与清单未动（本轮只改了 `client.js`、`tools/check-bundle.mjs` 与两份
README），所以不需要重启 Harness，也不需要重新安装。

**刷新后统计页会清零**：那是 v2 迁移，不是数据丢失 —— 详见上面的迁移说明。

**未验证**：四个数字的渲染、计时行为、曲线绘制、分时窗口选择器与配色观感。这台会话没有浏览器
控制能力，而 Web 载体带鉴权（未授权请求 401，且不应去翻找认证令牌），所以需要你刷新后确认。

## 已知限制

- 余额是 Platform 钱包读数，**不是**按单价推算的账单；金额一律来自余额的实际减少量。无法解析的
  钱包金额会被丢弃，所以"已登录但一个可读钱包都没有"显示为「无可读余额」，而不是永远停在"读取中…"。
- token 总量是 provider 计数（四个互斥桶之和），**不含子代理 / 工作流**的 token。
- **台账只覆盖本浏览器开始记录以来的时段**：页面关着时对话在跑，那段的 token 与扣费都不会被记录。
  总额与曲线因此是"已观测"而非"账单全量"。（余额侧的追认是准的：基线会持久化，重新打开页面后
  第一次读数会把离开期间的整体下降一次记清。）
- **赠送额度到期会被记成一笔消耗**。赠送额度是下降、币种没变，代码不重设基线；而载荷里只有
  `{currency, balance}`，没有到期时间、没有授予 id，**无法把"到期消失"与"被用掉"区分开**。
  彻底解决只能改成只统计充值钱包的下降，那又会让"用赠送额度跑"的时段金额恒为 0 —— 两条路都不
  完美，所以先把已知误差写清楚，没有偷偷选一条。
- **登出后换账号、换币种**同理：币种没变时基线不重设，整个差额会被记成一笔消耗；币种变化时
  `spend` 只换基线不换算金额。实际发生这两种情况后，按一次「清空统计」即可。
- 台账挂载在会话输入框下方那条状态行上：**隐藏状态行不会停止记账**，但**切到非会话面板**期间的
  增量会在返回时并到当时的时段里 —— 影响时段分布，不影响总额。
- 运行时长、显示偏好与用量台账都在**当前浏览器**的 `localStorage`；清站点数据会丢。
- **输出速率只统计 provider 计到时的解码段**：被取消的 step 不装配消息，那段流式时间不进 `decodeMs`。
  它衡量的是"已完成输出的速度"，分子分母同源所以比值自洽，但不等于"已产出 token ÷ 全部生成时间"。
- **保留不限时，所以文档会一直长**：每次提交都整份 `JSON.stringify` 再写回，随时间线性变贵；配额
  写满后 `setItem` 会抛异常，设置页的「存储占用」会变成橙色警告说明"此后只在本页内存里记账"。
- **分时窗口不再有保留窗口限制**：日期下拉会列出所有曾经记录过的日期，随时间线性变长。
- **缓存命中率的口径比总 token 晚开始**：`inputTokens` / `cacheReadTokens` 是后加的计数器，旧
  `seen` 记录里读作"还不知道"，所以这一列的窗口从升级那一刻起算，随时间与其它列收敛。它与**自身**
  完全自洽（分子分母同时开始），只是与总 token 不是同一段。
- **v2 迁移会清空旧总数**（旧文档原样留在 `dsh.account-balance.usage.v1` 上）。
- 新会话尚未跑过请求时 token 显示 `—`；运行不足 1 秒不产生速率（避免首秒虚高），解码段不足 1 秒
  同样不产生输出速率。
- 渲染位 `conversation.composer.dock` 是 `scope: session`，无会话的页面不显示。

## 许可

[MIT](LICENSE) © 2026 lwx071001 —— 随便用、随便改、随便再发，保留这份声明即可，不担保任何东西。
