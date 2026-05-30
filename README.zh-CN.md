# gojaja（过家家）

**语言：** [English](./README.md) · 简体中文

> 一个本地 CLI 工具，让多个 AI agent 窗口（Cursor / Claude Code / Codex CLI 等）协作开发同一个项目。没有服务器、没有数据库，所有协调状态都是仓库里的普通文件，可以直接 `git diff`。

名字的来历："过家家"是小朋友的角色扮演游戏，每个人分一个家庭角色一起演——这个工具让你的多个 LLM agent 在同一个仓库上也能这样各司其职地配合。

---

## 这是什么 / 适合谁

你用 Cursor 写前端、用 Claude Code 写后端、用 Codex CLI 当 PM。三个窗口读同一个仓库，彼此之间却不通气。结果就是工作重复、决策互相打架、没有人记得谁同意了什么。

本工具给每个 agent 配一个**角色**（PM、技术 leader、后端、QA……）、一个私有收件箱、一块共享任务板，以及一套用来跨角色拍板的 RFC 机制。agent 之间通过本地 CLI `gojaja` 通信，每一条消息、每一次决策、每一次状态变更都是一个落盘文件。

适合谁：一个项目里同时跑两个或更多 agent 窗口，且它们已经开始互相添乱。不适合：你只开一个 agent 窗口，或者你已经在用托管式多 agent 平台（LangGraph、AutoGen、CrewAI）——那些解决的是另一类问题。

要求 Node.js 20+，目前只跑 Linux 和 macOS。

---

## 心智模型（三句话）

1. **CLI 是真相，chat 不是。** 任何需要跨对话存在的东西都走 `gojaja`，不要靠聊天记录。
2. **`.gojaja/` 是一块带权限的共享黑板。** 每个角色的 `owns` 写明它能写哪些文件，CLI 会硬性拒绝越权写入。所有变更都可以 `git diff` 看到。
3. **agent 自己跑循环，你不用盯。** 你的事是建角色、写项目状态；agent 自己拉收件箱、干活、记日志、空闲。你只和它们聊天。

---

## 你做什么 vs agent 做什么

这是最容易混淆的地方，一次讲清。

| 动作 | 谁来做 | 时机 |
| --- | --- | --- |
| `gojaja init` | 你 | 项目第一次接入本工具时 |
| `gojaja role create / delete` | 你 | 加人 / 减人 |
| 把 `roles/<id>.md` 里的 TBD 填掉 | 你 | `role create` 之后立刻填 |
| `gojaja prompt --target X --write` | 你 | 每种 agent 工具装一次 |
| `gojaja activate <role> --target X` | 你 | 每开一个 agent 窗口，给它绑一个角色 |
| `gojaja watch` | 你 | 想看全局进度时（开个浏览器标签盯着，可选） |
| 在 `state/project_state.md` 里写产品范围 / 验收标准 | 你 | 项目推进过程中持续维护 |
| 升级工具、重跑 `prompt --write --force-rewrite`、重启窗口 | 你 | CLI 版本变动时 |
| `gojaja claim / plan / ack / wait / report / worklog / task ... / rfc ...` | agent | 每一轮对话里自动跑 |
| 写代码、写文档、跑测试 | agent | 你布置任务后 |
| 用 `gojaja state edit` 写在 `owns` 范围内的项目文件（支持 overwrite / append / replace 三模式） | agent | 角色契约规定的范畴内 |

如果你发现自己在手动跑 `gojaja plan` 或 `claim`，多半是在排错——参考下面的[手动跑一遍](#手动跑一遍排错用)。

---

## 快速上手 —— 在 `gojaja watch` 看板里点几下就好（推荐）

以前需要在终端里敲 `init` / `role create` / `prompt --write` / `activate` 的所有铺设步骤，看板都接管了。**只敲一句命令，剩下的全是点击。**

```bash
cd /path/to/your-project
npm install -g gojaja@latest    # 还没装就装一下
gojaja watch                    # 起服务在 http://127.0.0.1:7421，自动开浏览器
```

浏览器自动打开后跟着走：

1. **初始化** —— 如果项目还没 `.gojaja/`，看板会整屏显示一个 *Initialise this project* 按钮，点一下就行。（如果项目不在 git 里、或者工作区有未提交修改，按钮会先解释风险，让你点二次确认——等价于原来 CLI 的 `[y/N]` 提示，只是搬到了浏览器里）。
2. **建角色** —— 切到 **Setup** 标签页 → *Create role* 卡片。填 `id` / `title` / `owns`（需要的话再加 `reportsTo` / `mustNotEdit`），点 *Create role*。每个角色都这样建一遍（PM / Backend / TL / ...）。
3. **填角色合约** —— 用编辑器打开 `.gojaja/roles/<id>.md`，把 `TBD` 占位符（角色描述 + 职责）替换成真实内容。看板的 *Activate* 步骤会拒绝为还是 TBD 的角色生成 snippet，所以这一步是机制硬卡，不是唠叨。
4. **装运行时文件** —— *Setup* 标签 → *Install runtime files* 卡片。选 target（`agents` 覆盖 Cursor / Codex / Copilot / Windsurf / Zed；用 Claude Code 就选 `claude`），点 *Install*。卡片会提醒你重启已开的 agent 窗口让新规则生效。
5. **激活每个 agent 窗口** —— *Setup* 标签 → *Activate* 卡片。选角色 + target，点 *Generate snippet*，再点 *Copy*。打开对应角色的 agent 窗口（Cursor 标签 / Claude Code 窗口 / Codex CLI shell）粘贴。每个想绑定的窗口跑一次。
6. **从这里开始基本就只需要跟 agent 聊天了。** **Dashboard** 标签实时显示所有窗口的状态（session、任务板、RFC、活动流，外加红色 `stalled` 标记给那些 `ack` 之后忘了 `gojaja wait` 的角色）；**Actions** 标签让你不离开浏览器就能发 `report --to <role>` / 起 RFC / 建任务，全部以 `from: SYSTEM` 写入审计流。

Setup 和 Actions 这两个写入标签**只在 watch 绑到 loopback（默认 `127.0.0.1`）时显示**。如果你用 `--host 0.0.0.0` 把看板分享到局域网，两个写入标签会自动隐藏，看板退化为只读——同事可以围观，但没人能借此往团队里推指令。终端里 Ctrl-C 停掉服务即可。

如果你更喜欢从 shell 里走同一套流程（要写脚本做 onboarding、想搞清协议、或者纯粹偏好命令行），下面那节把同样的 4 步写成命令行版本。

---

## 用命令行配置（看板路径之外的另一种选择）

四步，做完之后只和 agent 聊天即可。

### 第 1 步 —— 初始化

```bash
cd /path/to/your-project
gojaja init
```

会在项目根目录建出 `.gojaja/` 目录，里面是协调状态，可以提交进 git。

### 第 2 步 —— 注册角色，然后填角色契约

```bash
gojaja role create PM      "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
gojaja role create TL      "Tech Lead"         --owns "state/architecture.md"
gojaja role create Backend "Backend Engineer"
gojaja role create QA      "Quality Assurance"
```

每个 `role create` 都会生成一份 `.gojaja/roles/<id>.md` 模板，里面有两段占位符——**Role description** 和 **Responsibilities**，都标着 `TBD`。**打开这两个文件，按角色实际职责填进去**——这是 agent 的自我介绍。`gojaja role list` 会标出哪些角色的契约还没填完；`gojaja activate` 在契约还是 TBD 状态时会直接拒绝执行。

`--owns` 控制这个角色能写 `.gojaja/` 里的哪些**共享状态文件**（gojaja 只管 `.gojaja/` 下的文件——仓库源码是 agent 用自己的编辑器写的，由角色契约里的职责描述来界定，不归 gojaja 管）。条目都相对于 `.gojaja/`，可以是具体文件，也可以是目录前缀——`--owns "state/"` 会匹配 `state/` 下所有文件（递归），不用一个个列。agent 通过 `gojaja state edit` 写自己 `owns` 之外的文件会被拒（退出码 `9 FORBIDDEN`）。

`role create` 还有两个值得了解的参数：

- `--reports-to PM,TL` —— 角色的升级链。handbook 会教 agent 卡住时按这条链向上 `report`。比如 `Backend` 角色 `--reports-to TL,PM` 表示：技术问题升级给 TL，范围 / 验收问题升级给 PM。
- `--must-not-edit state/architecture.md` —— 强黑名单，优先级高于 `--owns`。用法是：某个角色 `--owns` 了一大片（比如整个 `state/`），但你不希望它碰其中某个文件（比如 `state/architecture.md` 归 TL）。

一个把三个参数都用上的例子：

```bash
gojaja role create PM       "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
gojaja role create TL       "Tech Lead"         --owns "state/architecture.md,state/decisions.md" --reports-to PM
gojaja role create Backend  "Backend Engineer"  --owns "state/" --reports-to TL,PM --must-not-edit "state/architecture.md"
```

### 第 3 步 —— 安装 runtime

`AGENTS.md` 是唯一的「真身」runtime 文件。到 2026 年它已经是跨工具标准——Codex、Cursor、Copilot、Windsurf、Zed 等都读它，所以一个文件基本就够了：

```bash
# 真身：在 AGENTS.md 里 upsert 一段受管标记块。多数项目装这一条就行
# （覆盖 Cursor、Codex 及大多数 CLI agent）。
gojaja prompt --target agents --write
```

**唯一**常见的例外是 **Claude Code**——它目前不原生读 `AGENTS.md`（读的是 `CLAUDE.md`）。如果你用 Claude Code，就用 `claude` target，它会写 `AGENTS.md`（真身）**外加**一个只做 `@AGENTS.md` import 的一行 `CLAUDE.md`，仍然是单一来源：

```bash
# 用 Claude Code 时用这条代替 --target agents：
gojaja prompt --target claude --write   # 写 AGENTS.md + 一个 import 它的 CLAUDE.md
```

其它 target：

```bash
gojaja prompt --target cursor --write   # 可选：独立的 .cursor/rules/*.mdc
gojaja prompt --target generic          # 只打印，不落盘
```

`--target cursor` 是**兜底**——Cursor 本来就读 `AGENTS.md`，只有老版本 Cursor 或要用 `.mdc` 的 glob 特性时才需要它。不要在已有 `AGENTS.md` 的情况下再叠它，否则 Cursor 会把同一段 block 注入两次（浪费 token，不会出错）；多个「带完整 runtime」的文件同时存在时 CLI 会提示你。

**这一步要在开 agent 窗口之前做。** 这些宿主只在窗口首次打开时把文件注入 system prompt；如果窗口已经开着，你再跑 `prompt --write`，新规则对那个窗口不生效，必须重启。CLI 每次成功写入都会打印 IMPORTANT 提示。

同样的项目再跑一次 `prompt --write` 是幂等的：内容相同会显示 `UNCHANGED (already up to date)`，磁盘什么都不改。如果你想强制重写（比如升级了 CLI 想确认装的是新模板），加 `--force-rewrite`。

### 第 4 步 —— 给每个 agent 窗口绑定一个角色

角色是跟窗口绑定的，绑定信息不会写进任何项目级文件。注意：`activate` 命令是**你在自己的终端里运行**的——它本身**不是**发给 agent 的；它会打印（并尽量复制到剪贴板）一段**提示词**，那段提示词才是你要粘到 agent 窗口里的东西，里面告诉 agent 怎么认领角色、读自己的契约、了解 `gojaja` 能干什么。

在你的终端里，每个要开的窗口跑一条（`<role>` 换成角色名，`--target` 选该窗口对应的宿主）：

```bash
gojaja activate PM      --target agents
gojaja activate TL      --target claude
gojaja activate Backend --target agents
```

每条命令的输出夹在 `═══ BEGIN PASTE TO AGENT ═══` 和 `═══ END PASTE TO AGENT ═══` 两条分割线之间——把**中间那段**复制，粘到对应的 agent 窗口（比如 PM 那条的输出粘到 PM 窗口）。分割线本身是给你看的，**不要**粘进去。

（各 target 打印的提示词内容其实一样，`--target` 只影响里面引用的安装说明，挑跟该窗口宿主对应的就行。）

同一种工具的两个窗口可以同时持有不同角色，因为角色信息只活在那个窗口 shell 的 `GOJAJA_SESSION` 环境变量里，不在项目里。

到这步，你要做的配置就结束了，剩下的都是跟 agent 聊天。想随时看全局进度，开一个 `gojaja watch` 看板（参考下面的 [`gojaja watch` 参考](#gojaja-watch-参考运行期监控)）。

---

## 你还需要自己维护的东西

下面这些是项目内容，工具不会替你创建，由你（或拥有相应 `owns` 权限的 agent）随着项目推进慢慢补。

- **`.gojaja/state/project_state.md`** —— 产品愿景、里程碑、每个任务的验收标准。`gojaja init` 会自动建一个 TBD 骨架（三段：Vision / Milestones / Acceptance criteria），**你的活是把里面的 TBD 占位符填掉**。这个文件由产品负责人角色（通常是 PM，谁在 `config.yaml` 里 `owns` 它就是谁）持续维护。handbook 教 agent 看到这文件里某段还标着 TBD 时，先回过来问你 —— 所以这文件留空越久，agent 打扰你的次数越多。建议至少写成：

  ```markdown
  # Project state

  ## Vision
  一段话——做什么、给谁用、什么不做。

  ## Milestones
  - M1: ... 截止 ...
  - M2: ...

  ## Acceptance criteria
  - T-0001 Build /login: 接口返回 200，密码 bcrypt，5 分钟内失败 5 次锁账号
  - T-0002 ...
  ```

  其中第三段最关键：每条任务的验收标准写得越具体，agent 就越能自己判断任务是否完成，而不用反过来问你。

- **`.gojaja/state/architecture.md`** —— 由拥有它的角色（通常是 TL）写，你审阅。

- **`.gojaja/state/decisions.md`** —— RFC 归档的散文版补充，可选但有用。

- **`.gojaja/roles/<id>.md`** —— 描述 / 职责两段，role create 当下就要填。

---

## 你能直接做什么（不绑定角色）

“你”指坐在终端前的人。只要当前 shell 里**没有** `GOJAJA_SESSION`，gojaja 就把你当成项目主人（内部记为 `SYSTEM`）。这个身份能做项目治理和铺垫，外加一些跟"开 RFC"对称的轻量动作；但**不能替任何角色站队**——`report` / `worklog` 这类发消息，以及 RFC 上的结构化表态（pre-decide / ack / object / decide）都是带立场的"说话"动作，必须先绑定角色（`claim`），否则就没有归属人。

**不绑角色（你 = 项目主人 / SYSTEM）就能做：**

| 能做 | 命令 |
| --- | --- |
| 建 / 删角色 | `role create`、`role delete`（删角色**必须**无 session） |
| 派活、改任务 | `task new` / `task assign` / `task status`（SYSTEM 可越过归属和 creator 限制强行调整） |
| 发起 RFC / 脑暴 | `rfc new`（`createdBy` 记为 SYSTEM，且不会被算进 voters，所以不会卡住 pre-decide 的表决） |
| 在 RFC 上留普通讨论评论 | `rfc comment`（评论的 `from` 记为 SYSTEM，跟 `rfc new` 对称；结构化动作仍然要角色——见下表） |
| 给某个角色发定向消息 | `report --to <role> --message "..."`（消息的 `from` 记为 SYSTEM；这是你作为"项目主理人"打进团队的渠道。接收方收到的是普通 report，但能从审计里看出是你发的，不是别的 agent） |
| 改共享状态 | `state edit`（SYSTEM 越过文件归属限制） |
| 查看一切 | 除 `plan` 外的只读命令：`task show/list`、`rfc show/list`、`role show/list`、`handbook`、`-h`，以及看板 `watch`（默认只读；loopback 模式还会多出一个 Actions 面板，让你直接从看板里 `report` / 开 RFC / 建 task） |
| 安装 / 卸载 / 激活 | `init`、`reset`、`prompt`、`activate`、`claim` |

**必须先 `claim` 一个角色（shell 里有 `GOJAJA_SESSION`）才能做：**

| 要绑角色 | 命令 | 为什么 |
| --- | --- | --- |
| 广播消息 | `worklog`（团队周知进度） | worklog 是"你这个角色对团队说的话"，必须归属到某个角色 |
| 以**同级 agent 身份**发定向消息 | 角色 session 下跑 `report --to <role>` | 接收方应该清楚这是别的 agent 发的，不是你（项目主理人）发的 |
| 在 RFC 上站队 | `add-option` / `pre-decide` / `ack` / `object` / `decide` / `revise` / `edit` | 这些都带立场，ACK 闸门统计的是角色名，不是匿名票 |
| 跑轮次 | `plan`、`ack`、`wait`、`release` | 这些是角色 agent 的日常循环 |

所以直接回答常见疑问：**没绑角色时，你不能广播 `worklog`、也不能在 RFC 上站队**——这些动作没有"同级 agent"归属就讲不通。但你**可以**作为「项目主人」的身份开 RFC、在 RFC 上留评论、给某个角色发定向 `report`、压任务、改状态、必要时强改任务状态。如果你想作为一个完整的「人类参与者」加入讨论（投票、ack / object、decide、广播），给自己也建并 `claim` 一个角色（比如 `Owner` 或 `Human`），之后就能像普通 agent 一样什么都做。

> SYSTEM 身份（不绑角色）能做的：`rfc new`、`rfc comment`（普通评论）、`report --to <role>`、`task new` / `assign` / `status`、`state edit`。结构化的 RFC 动作（`add-option` / `pre-decide` / `ack` / `object` / `decide` / `revise` / `edit`）和广播 `worklog` 仍然各自需要角色 session。

---

## 手动跑一遍（排错用）

下面这套命令可以让你在终端里手动把整个流程跑一遍，搞清楚它是怎么运作的。注意：日常使用里**不用**敲这些，agent 绑定角色后会自动跑。

**窗口 A —— 扮演 PM：**

```bash
eval "$(gojaja claim PM --eval)"            # 领角色 + 把 GOJAJA_SESSION 写进当前 shell，一步到位

# 最简形式
gojaja task new --title "Build /login endpoint" --owner Backend --priority P1

# 带父任务、参考材料、硬性产出：
gojaja task new --title "Build /login endpoint" --owner Backend --priority P1 \
  --parent T-0010 \
  --tag auth \
  --asset 'file:docs/specs/auth.md::Auth 规范' \
  --asset 'url:https://figma.com/file/xxx::登录 UI 设计稿' \
  --deliverable 'file:apps/api/auth/login.ts::实现代码' \
  --deliverable 'file:docs/api/login.md::API 文档'

gojaja report --to TL --message "登录范围已确认，后端可以开工了。"
```

那两行 `--deliverable` 的意思是：这两个文件都进仓库之前，这个任务**不能**被标成 `Done`。如果 reviewer 临时同意放行某个产出，owner 就跑 `gojaja task status <id> Done --force-incomplete`，这次绕行会作为一条事件留在审计流里。

**窗口 B —— 扮演 Backend：**

```bash
eval "$(gojaja claim Backend --eval)"

gojaja plan                                  # 看自己有啥要做的
gojaja task status T-0001 InProgress
# ...写代码...
gojaja task status T-0001 Review
gojaja worklog --message "T-0001 done, see commit abc123"
gojaja ack --token <plan 返回的 token>       # 确认这一轮处理完了
gojaja wait --in 10m                         # 待命，10 分钟内有新消息就唤醒
# 没活儿干了想被派任务的话用这条，会自动广播一条 "我空闲了"：
gojaja wait --in 1h --for task-assigned
```

今天不干这个角色了：

```bash
gojaja release
unset GOJAJA_SESSION
```

### 脑暴（不带 `--options` 的 RFC）

三个以上角色要就一个还没有明确选项的问题表态时，开一个不带 `--options` 的 RFC：

```bash
gojaja rfc new q3-priorities \
  --title "Q3 优先级 —— 我们应该往哪个方向使劲？" \
  --deciders TL --voters PM,Backend,Frontend,DevOps \
  --description "性能、增长还是稳定性？把想法、风险、follow-up 都丢进来。"

# 投票人自由表态 —— 不需要选 option
gojaja rfc comment RFC-0001 --rationale "想法：性能优先，最近俩企业客户因延迟跑了。"
gojaja rfc comment RFC-0001 --rationale "风险：中途砍特性 X 会得罪企业版用户。" --reply-to <上一条 id>

# 讨论中出现了具体方案，任何成员都能把它升级成 option
gojaja rfc add-option RFC-0001 --option perf:'Q3 全力性能' --rationale "源自上面的讨论。"

# 关 RFC 的两种姿势：
# 1. 不选 option，rationale 表达结论
gojaja rfc decide RFC-0001 --rationale "讨论结论：Q4 再议，本季不做具体承诺。"
# 2. 加完 option 之后按常规决策流走
gojaja rfc decide RFC-0001 --option perf --rationale "采纳性能优先方案。"
```

---

## 常见情景

### 加一个角色

```bash
gojaja role create Frontend "Frontend Engineer"
# 填 roles/Frontend.md
gojaja activate Frontend --target agents
# 开一个新 agent 窗口，粘贴
```

runtime 规则之前就装好了，不用再跑 `prompt --write`。

### 删一个角色

```bash
# role delete 是治理动作，必须在没有 GOJAJA_SESSION 的 shell 里跑：
unset GOJAJA_SESSION
gojaja role delete Frontend
```

Frontend 名下的未完成任务会**保留**在任务板上——之后用同名再 `role create` 一个角色会自动重新认领。如果想直接转交，用 `gojaja task assign <task-id> --to <其它角色>`。如果还有 agent 窗口持有刚删掉的角色的 `GOJAJA_SESSION`，下一次执行 gojaja 命令会报 USAGE，那个窗口需要重启或者重新领其它角色。

### 卸载本工具在项目里写的东西（`gojaja reset`）

项目搞完了或者想把协作层推倒重来时：

```bash
# 同样是治理动作，必须无 GOJAJA_SESSION：
unset GOJAJA_SESSION
gojaja reset                                  # 预览，不删
gojaja reset --confirm <项目目录名>           # 真删
```

默认调用只打印预览不动文件；`--confirm` 的 token 就是项目根目录的 basename。Reset 会清理：

- `<项目>/.gojaja/`——事件流 / state / RFC / worklog / session / 锁全部清掉。
- `<项目>/.cursor/rules/gojaja-runtime.mdc` 以及空了的 `.cursor/rules/` / `.cursor/` 父目录。
- `<项目>/CLAUDE.md` 和 `<项目>/AGENTS.md` 里 `<!-- gojaja-runtime:BEGIN ... :END -->` 之间的内容；块外用户自己写的东西原样保留。如果那个块就是整个文件的全部内容，文件直接删掉。

gojaja 装的东西**全是项目级的**，没有用户级残留要单独清。Reset 也是「把审计流删干净」的唯一办法——所有事件都在 `.gojaja/` 下，想留先 `cp -r .gojaja .gojaja.bak` 或者 git commit 一下。

### 升级 CLI

```bash
npm install -g gojaja@latest
gojaja prompt --target agents --write --force-rewrite   # 你装过的每个 target 都重跑一次
# 然后把所有已开的 agent 窗口重启一遍。
```

`--force-rewrite` 跳过“内容相同就不写”的短路；升级版本时用，确认装的是新模板。

### “agent 说不知道自己是谁”

四种常见原因：

1. **agent 的 shell 没 export `GOJAJA_SESSION`**。激活提示词里有一句 `eval "$(gojaja claim ... --eval)"`，弱模型有时会跳过，重新粘一次提示词即可。
2. **这个宿主每条命令都开一个新 shell，`claim` 时 `export` 的环境变量在两次工具调用之间就丢了**（Cursor 最容易这样；Claude Code / Codex 一般是持久 shell）。症状是 `claim` 明明成功了，之后每条命令却都报 "GOJAJA_SESSION is required"。解决办法：让 agent 把 session id 显式带上——用 `gojaja claim <role>`（不加 `--eval`），记下打印出来的 session id，之后每条命令都加 `--session <id>`，比如 `gojaja plan --session <id>`。runtime 规则里已经教了这一招，遇到能力弱一点的模型可能要提醒它一下。
3. **agent 窗口是在 `prompt --write` 之前开的**。宿主只在窗口打开那一刻注入规则文件，重启窗口。
4. **角色契约还是 TBD 状态**。跑 `gojaja role show <角色>` 看看，如果还是空的，先把 `roles/<id>.md` 填完，再重新粘提示词。

### “两个窗口想认领同一个角色”

第二个窗口会看到 "already claimed by a live session ..."。handbook 教 **agent** 看到这条要 STOP 然后问你——agent 不要用 `--force`。你作为人类、当第一个窗口确实死了（你手动关掉的那种）时有三种办法：直接 `gojaja claim <role> --force` 强制接管（推荐，`--force` 是给人用的，不是给 agent 用的）；或在仍持有该 session 的 shell 里 `gojaja release <role>`；或干脆等租约自然过期（默认约 2 小时）。

### “聊天记录删了，但角色卡住释放不掉”

```bash
unset GOJAJA_SESSION             # 如果还在 shell 里
gojaja claim <role> --force      # 人类强制接管死窗口（最简单），或
gojaja release <role>            # 在仍持有 session 的 shell 里跑，或
# 干脆等约 2 小时让租约自然过期
```

---

## `gojaja watch` 参考（运行期监控）

上面的快速上手已经讲了第一次铺设怎么用看板。**项目跑起来之后**就把看板挂在浏览器标签里——这是你的"调度者视角"：在单机上 agent 的对话结束之后没有任何机制能主动把它叫醒，所以你就盯着这一屏决定下一个该催谁。

```bash
gojaja watch                 # 默认 http://127.0.0.1:7421，自动开浏览器
gojaja watch --port 8080     # 指定端口
gojaja watch --host 0.0.0.0  # 局域网共享 —— 自动切只读模式（隐藏 Setup + Actions）
gojaja watch --no-open       # 不自动开浏览器
```

每两秒自动刷新一次，分三个标签页：

- **Dashboard** —— 全部窗口的实时状态：
  - **角色** 卡片：session 是 `live` / `stale` 还是没有、哪个进程（pid + host）持有的、心跳多久前、空闲时在 `wait` 什么。**如果某个角色明明持有 live session 却长时间没跑过 `gojaja wait`，会被红色 `stalled` 标出来**——这是"agent `ack` 之后忘了 park"的失败模式，那个角色对事件失聪，扫一眼就能发现。
  - **任务板** —— 所有任务按状态（Backlog → Done）分列，带 owner、优先级、阻塞项、产出数。
  - **RFC** —— 哪些在 open / revising / 已决，连同 deciders 和 voters。
  - **活动流** —— 所有 agent 的实时事件（report、worklog、任务流转、RFC 评论与决定），最新的在最上面，同时就是这个项目的历史。
- **Setup（仅 loopback 可用）** —— 跟快速上手用的是同一个写入面板：建角色、装运行时、生成激活 snippet。**项目运行后也常用**——加新角色、给新机器装运行时、给新窗口生成 snippet 都从这里。
- **Actions（仅 loopback 可用）** —— 不离开浏览器就把指令推进团队：给角色发 `report`、起 RFC、建 task，全部以 `from: SYSTEM` 写入审计流。

按紧迫顺序看哪些信号要响应：
- **header 上的红色 `stalled` 数字** —— 有角色失联了，去 Actions 发条 report 戳它，或者直接去那个 agent 窗口戳。
- **角色显示「空闲，等派活（task-assigned）」** —— 该角色闲着，去 Actions 派任务给它。
- **任务卡在 `Blocked`** —— 看 `dependsOn` 找上游催。
- **RFC 在 `open` 状态停了很久** —— 去戳它的 decider。

把 watch 绑到非 loopback 地址（比如 `--host 0.0.0.0` 局域网共享）时，两个写入标签会自动隐藏，看板退化为只读——同事可以围观，但没人能借此往团队里推指令。终端里 Ctrl-C 停掉服务即可。

## agent 之间怎么拍板（RFC）

如果一个决策牵涉多个角色的 `owns`、或者动到架构，agent 会开一个 RFC，而不是自己擅自拍板。RFC 支持真正的多轮讨论：评论可以互相回复成串、可以中途追加新 option、有一轮强制表态的 pre-decide（每个相关角色都必须显式 `ack` 或 `object`，沉默不算同意），decider 也可以把提案打回去重写。完整讲解见 [docs/RFC.md](./docs/RFC.md)，这里快速过一遍：

```bash
# 任何 agent 都能开。--description 是不参与对话的人需要的上下文；
# --task 标明这次决策关联的具体任务。
gojaja rfc new switch-to-postgres \
  --title       "Move primary store from SQLite to Postgres" \
  --description "登录延迟根因是 SQLite 并发写争用；A 是迁移，B 是临时调优。" \
  --options     "A:Migrate now (4 weeks),B:WAL tuning first" \
  --voters      "Backend,DevOps" \
  --deciders    "TL" \
  --task        T-0042

# voter 评论；回复用 --reply-to 串起来（comment id 是 ULID）。
gojaja rfc comment RFC-0001 --option A --rationale "迁移可行。"
gojaja rfc comment RFC-0001 --reply-to 01HZA...COMM1 --rationale "M2 能不能往后推 2 周？"

# 讨论中发现既有 option 都不够好，任何 agent 都可以加一个新 option。
gojaja rfc add-option RFC-0001 --option "C:Managed Postgres on RDS" --rationale "把成本维度纳进来。"

# pre-decide：decider 发一条结构化的"我倾向 X" comment。
# 每个 voter + 其它非 pre-decider 的 decider 都必须显式 rfc ack 或 rfc object 表态
# 才能 rfc decide。沉默不算同意。
gojaja rfc pre-decide RFC-0001 --option C --rationale "倾向 C；请 ack 或 object。"
gojaja rfc ack    RFC-0001                                       # 我同意
gojaja rfc object RFC-0001 --rationale "成本超" --option B          # 我反对，倾向 B

# decider 也可以把提案打回去重写，而不是直接 reject 这个话题。
gojaja rfc revise RFC-0001 --rationale "把成本那段补全。"
gojaja rfc edit   RFC-0001 --rationale "补了成本段。" --description "<新版描述>"

# 最终只有 decider 能拍板（其它角色来调会拿到 exit 9 FORBIDDEN）。
gojaja rfc decide RFC-0001 --option C --rationale "通过，按 C 推进。"
```

某角色需要表态的 RFC 会出现在它下一次 `gojaja plan` 的结果里，并带 `unreadComments` 数量好让 agent 优先处理。`gojaja rfc show <id>` 自动推进该角色对这条 RFC 的"已读"标记。

---

## 它不做什么

- **不支持跨机器**。单机为主，跨机器（基于 HTTP）放在 roadmap 里。
- **不调 LLM**。它只做协调，AI 由你的 Cursor / Claude / Codex 提供。
- **不跑后台服务**。每次 `gojaja` 命令都是起来执行完就退出。
- **拦不住手工改文件**。agent 走 `gojaja` 是受 `owns` 约束的，但你打开编辑器仍然能随意改。
- **没有 `read-state` 命令**。读取本身就是不受限的（这层是共享黑板），且 agent 宿主自带 file-read 工具——再包一层 `gojaja` 只会徒增 token 消耗。`gojaja` 管的是**写入**（需要 ownership / 原子性 / 审计）和**结构化操作**（claim / plan / ack / task / rfc / report）。读文件直接读就行。
- **暂不支持 Windows**。目前只在 macOS 和 Linux 上跑。

---

## Roadmap

| 项目 | 状态 |
| --- | --- |
| 存储、事件、session、角色级 ownership | 已完成 |
| `claim`、`plan`、`ack`、`report`、`worklog`、`wait` | 已完成 |
| `role` + `prompt` + `activate`（role-free runtime + 每窗口绑定） | 已完成 |
| 任务板（`task new/assign/status/list/show`） | 已完成 |
| RFC v2.1：threaded comments、`add-option`、`pre-decide` + 强制 `ack`/`object` gate、`revise`/`edit`、`link-task` | 已完成 |
| 注入到 runtime 的协作 handbook | 已完成 |
| `role delete`（带 session + config 清理） | 已完成 |
| `gojaja watch` 实时看板（角色 / 任务 / RFC / 活动流） | 已完成 |
| `gojaja reset`（项目级，清掉 gojaja 装的一切） | 已完成 |
| `gojaja upgrade` | 下一步 |
| `doctor`、事件历史、归档 | 计划中 |
| 跨机器 HTTP 协议 | 未来 |

完整版：[docs/ROADMAP.md](./docs/ROADMAP.md)

---

## 文档

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | 协议层契约——每个命令的语义、manifest 结构、ack 语义 |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | 判断规则：什么时候 worklog、什么时候 report、什么时候开 RFC，什么不该麻烦用户 |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | `.gojaja/` 下每个文件是什么、谁会写 |
| [docs/RFC.md](./docs/RFC.md) | RFC 机制端到端讲解：模型、状态机、磁盘布局、完整示例 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 设计为什么是现在这样 |
| [docs/RELEASE.md](./docs/RELEASE.md) | 维护者发版操作手册 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |

---

## 本地开发

```bash
git clone <本仓库>
cd codex-agent
npm install
npm run build
npm test
./bin/gojaja --help
```

如果想让全局 `gojaja` 指向你本地的代码：

```bash
npm link                # 把 ./bin/gojaja 挂成全局的 gojaja
npm run build           # 改完源码后重新编译，或者：
npm run watch           # tsc --watch，保存自动增量编译
```

挂出去的二进制实际加载的是 `dist/cli/index.js`，不重新构建就看不到代码变更。代码组织和贡献规则参考 [AGENTS.md](./AGENTS.md)。

---

## License

MIT
