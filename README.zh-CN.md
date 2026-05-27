# multi-agent-coordination

**语言**：[English](./README.md) · 简体中文

> 让多个 LLM agent 窗口（Codex / Claude Code / Cursor / 任何能跑 shell
> 的 agent）以**团队的方式协作完成同一个项目**——不需要服务器，只用文件。

你打开四个 IDE 窗口，让它们都指向同一个 git 仓库，再告诉每个窗口扮演的
角色：

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex      │  │  Claude     │  │  Cursor     │  │  Cursor     │
│  role: PM   │  │  role: TL   │  │  role: BE   │  │  role: QA   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────┬───────┴────────┬───────┴────────────────┘
                ▼                ▼
           ┌──────────────────────────────────────┐
           │  .multi-agent/   （随项目提交到 git）  │
           │    events  │  inbox  │  rfcs         │
           │    state   │  worklog │  sessions    │
           └──────────────────────────────────────┘
```

PM agent 发起一个 RFC，TL agent 评论，决策落地后 Backend agent 开始
实现，QA agent 读 worklog 并起 defect 报告。每一次跨窗口的消息都经过
一个本地 CLI——`agentctl`——它保证原子写、事件有序、不丢消息，并在 git
里留下一份可 diff 的决策与协作记录。

---

## 什么时候该用它

你符合下面任何一条就值得看：

- 你已经在同一个项目里**开了多个 LLM agent 窗口**，它们互相踩对方、
  或者重复做同样的事。
- 你想要一份**可审计的过程档案**——谁提议的、谁拍板的、为什么——而且
  希望它就是 git 里的普通文件。
- 你希望 agent **角色化**（PM、技术 leader、Backend、QA……），并且让
  跨角色决策按正常流程走。
- 你想要这套机制**不依赖服务器、不需要 API key、不要数据库**——只用
  仓库里的文件。

如果你只跑一个 agent，或者你的 agent 已经在用 LangGraph / AutoGen /
CrewAI 之类托管的多 agent 框架，那本项目解决的不是你的问题。本项目针
对的是：**只能用 shell + 文件交流的 agent，怎么安全地拼在一起**。

---

## 当前状态

**v2.0.0-alpha.7**。已经实现并由 121 个测试覆盖：

- 存储核心（事件、游标、会话、per-resource 锁）。
- 每回合 agent 循环：`claim` / `plan` / `ack` / `report` / `worklog` /
  `release` / `wait`。每次 `plan` 返回的 manifest 都自带一个精简的
  `roleReminder`——上下文被压缩的 agent 只要再跑一次 `plan` 就能找回
  完整身份。
- 配置 CLI：`role create / list / show`、`prompt --target codex|claude|cursor|generic --write`。
- 任务板：`task new / assign / status / list / show`；manifest 自动
  携带这个角色的活跃任务。
- RFC：`rfc new / comment / decide / reject / list / show`。状态机
  `open -> accepted | rejected`；只有 `deciders` 名单里的角色能 decide
  /reject；不做自动计票。Manifest 自动携带需要本角色处理的开放 RFC。
- 可写域强制：`config.yaml:roles[<role>].owns` / `mustNotEdit` 已经是
  写入运行时的强制门，agentctl 拒绝越权写。新增 `agentctl write-state`
  统一写入入口。
- 协作 handbook：每条 `agentctl prompt --write` 出来的提示词工件里都
  自带一份精简的"策略层"——告诉 agent **什么时候**该用哪个工具
  （worklog / report / RFC / 升级 / 抛给用户）。详见
  [docs/HANDBOOK.md](./docs/HANDBOOK.md)。用 `--no-handbook` 关掉。

还在排队的：安装器/升级、`doctor`——详见
[docs/ROADMAP](./docs/ROADMAP.md)。

跟进进度请关注 `v2` 分支。

---

## 安装

需要 Node.js 20 或更新版本。

```bash
# 全局安装，提供 agentctl 命令：
npm install -g multi-agent-coordination

# 或者用 npx 按需运行：
npx multi-agent-coordination --help
```

alpha 阶段你也可以直接 clone 本仓库，见
[本地开发](#本地开发)。

---

## 快速上手

用户**只做 1-4 这四步**，全部是一次性的。之后你只需要打开 agent
窗口、粘上激活提示词；剩下的命令 agent 自己每回合调。

### 1. 在项目里初始化

```bash
cd /path/to/your/project
agentctl init
# Initialised multi-agent layer (v2.0.0) at /path/to/your/project/.multi-agent
```

`.multi-agent/` 全是纯文本 + JSON，**可以直接提交到 git**。完整
schema：[docs/SCHEMA.md](./docs/SCHEMA.md)。

### 2. 创建你需要的角色

```bash
# owns 从 PR7 起是写入时的强制门——给 PM/TL 设好它们需要的可写域。
agentctl role create PM "Product Manager" \
                   --description "Owns scope and acceptance" \
                   --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL "Tech Lead" \
                   --description "Owns architecture and integration order" \
                   --owns "state/architecture.md"
agentctl role create Backend "Backend Engineer"
agentctl role create QA "Quality Assurance"

agentctl role list
# PM           Product Manager
# TL           Tech Lead
# Backend      Backend Engineer
# QA           Quality Assurance
```

每条 `role create` 同时写 `.multi-agent/config.yaml`（机器源）和
`.multi-agent/roles/<id>.md`（人看的契约）。编辑 `config.yaml` 来
设置 `owns` / `reportsTo` / `mustNotEdit`。

### 3. 为每种 agent host 安装一次 runtime 工件

对你**要用的每种 host**跑一次 `prompt --write` 就够了。工件是角色无
关的，不用按角色重复跑。

```bash
# 如果你用 Cursor：
agentctl prompt PM --target cursor --write
# → 写出 .cursor/rules/multi-agent-runtime.mdc（alwaysApply: true）

# 如果你用 Claude Code：
agentctl prompt PM --target claude --write
# → 在 CLAUDE.md 里 upsert 一个标记块

# 如果你用 Codex CLI：
agentctl prompt PM --target codex --write
# → 写出 ~/.codex/skills/multi-agent-runtime/{SKILL.md, agents/openai.yaml}

# 任何能跑 shell 的其它 agent：
agentctl prompt PM --target generic
# → 打印完整提示词，你手动粘
```

`prompt` 还会在最后打印一段**激活提示词**。把它粘到对应 agent
窗口的聊天里，agent 就会绑定到这个角色。

### 4. 一个角色一个 agent 窗口

举例：PM 用 Cursor，Backend 用 Codex：

- 在该项目里开一个 Cursor 窗口。runtime rule 已经自动加载。把
  `agentctl prompt PM --target cursor` 打印的激活提示词粘到聊天
  里。Agent 会自动跑 `agentctl claim PM`、export `MA_SESSION`、
  然后进入运行循环。
- 在该项目里开一个 Codex shell。粘
  `agentctl prompt Backend --target codex` 的激活提示词。Agent 触发
  `$multi-agent-runtime` skill 做同样的事。

到这里全部安装完了。从这一刻起**用户只需要和 agent 自然聊天**；
agentctl 是它们的工具。

### Agent 每个回合自己跑什么

详见 [docs/PROTOCOL.md](./docs/PROTOCOL.md)。简版：

```bash
agentctl plan                          # JSON：未读工作 + ackToken
                                       # 还带 roleReminder（id/title/owns/...）
                                       # 和 tasks（这个角色的活跃任务）
# ... agent 处理完事件 / 任务，可能调：
agentctl report      --to <role> --message "<text>"
agentctl worklog     --message "<text>"
agentctl task status <task-id> InProgress
# ... 然后：
agentctl ack  --token <ackToken>       # 把游标精确推到 manifest 当时快照
agentctl wait                          # 阻塞睡眠（不烧 token）
```

### 额外：手动跑一遍完整 demo

可以在两个 shell 里手动驱动整个流程，更直观。

**Shell A（PM）：**

```bash
agentctl claim PM
export MA_SESSION=<粘 claim 返回的 session id>
agentctl task new --title "Implement /login API" --owner Backend --priority P1 \
                  --acceptance "POST /login returns JWT, rate-limited 10/min"
agentctl report  --to TL --message "Goals locked in for Q3"
agentctl worklog --message "Drafted acceptance for T-0001"
```

**Shell B（Backend）：**

```bash
agentctl claim Backend
export MA_SESSION=<粘 session id>
agentctl plan                              # 看到 PM 的事件 + tasks=[T-0001]
agentctl task status T-0001 InProgress     # 广播 TASK_STATUS_CHANGED
# ... 真去仓库里写代码 ...
agentctl task status T-0001 Review
agentctl worklog --message "T-0001 ready for review, see commit abc123"
agentctl ack --token <plan 输出的 ackToken>
agentctl wait --idle 1                     # 1 分钟后返回 IDLE
```

---

## 60 秒理解核心理念

- **角色是永久的，agent 不是**。`PM` 这种角色长期存在于仓库里。任何
  LLM 窗口都可以临时**租用（claim）**一个角色去扮演它。
- **所有写入都过 CLI**。Agent 永远不用 `cat`/`sed`/`echo` 直接动
  `.multi-agent/`。它们调用 `agentctl`，由 CLI 原子写 JSON、发事件。
  这是多窗口并发安全的关键。
- **事件是不可变 JSON 文件**。一条事件 = 一个文件，文件名是按时间
  排序的 ULID。没有共享日志文件，就没有撕裂读、没有转义 bug、没有
  全局互斥锁。
- **游标只能凭 token 推进**。每个 agent 先用 `plan` 拿到"未读清单"
  和一个 token，处理完再用 `ack --token` 推进游标。游标永远不会
  跨过它没见过的事件——彻底解决经典的"ack 撞上并发写"丢消息问题。
- **RFC 是意见收集 + leader 拍板**。任何角色都可以给 RFC 留意见，
  但只有在 RFC 的 `deciders` 列表里的角色能调 `rfc decide` /
  `rfc reject` 推进状态。没有自动计票。下一次 `plan` 自动把这条
  RFC 列在 `manifest.rfcs` 里，并标明本角色是 `voter` 还是 `decider`。

完整架构论证：[docs/DESIGN.md](./docs/DESIGN.md)。

---

## 能力边界

明确"做什么"和"不做什么"。

**它做这些：**

- 在**单机、单个 git 仓库**里协调任意数量的 agent 窗口。
- 中途崩溃可恢复：角色被另一个窗口接管后，能确定地拿到上一次未确认
  的 manifest 继续处理。
- 每一类错误都有稳定退出码——脚本和 agent 可以按 `2`（用法错误）、
  `3`（未初始化）、`6`（锁超时）等分支处理。
- 适配**任何能跑 shell 命令并读 JSON 的 agent runtime**。核心代码里
  没有任何 Codex/Cursor 特有逻辑。

**它暂时不做这些：**

- **不跨机器**。锁和 rename 语义假设单主机。放在 NFS / Dropbox /
  iCloud 上会让 stale 锁检测静默失效。HTTP 传输层在 v2.x 路线图里。
- **不调 LLM**。这是协作层，不是 agent 框架。LLM 调用由你的现有
  工具（Codex / Claude Code / Cursor）负责。
- **不跑守护进程**。每条命令都是短生命周期进程。（可选的
  `agentctl watch` 用于清理过期 session，在 v2.x。）
- **没法防住所有手工绕过**。`config.yaml:owns` 在 `agentctl` 写命令里
  强制（PR7），所以 agent 通过 CLI 不会越权。但拥有 shell 权限的人仍
  能直接 `vim` 修改 state 文件；本框架不是沙箱。
- **暂不支持 Windows**。代码依赖 POSIX 语义（rename onto open file、
  `process.kill(pid, 0)`）。Windows 在 v2.x 路线图里。
- **不替代 git**。审计就以纯文件形式躺在仓库里，靠 git 做 review 和
  回滚。

如果上面有项是 deal-breaker，请看
[docs/ROADMAP.md](./docs/ROADMAP.md)——大部分已经在排期。

---

## 路线图概览

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| PR1  | 存储核心：锁、事件、游标、会话 | **完成** |
| PR2  | `claim` / `plan` / `ack` / `report` / `worklog` | **完成** |
| PR3  | `role create / list / show`、`prompt --target … --write`、`wait` | **完成** |
| PR4  | manifest 里的 `roleReminder`，让被压缩上下文的 agent 重新锚定身份 | **完成** |
| PR5  | 任务板（`state/task_board.yaml`、`agentctl task *`） | **完成** |
| PR6  | RFC 状态机（意见 + leader 决定） | **完成** |
| PR7  | `config.yaml` 驱动的角色可写域强制 | **完成** |
| PR8  | 安装器、`upgrade`、`reset`、AGENTS.md 注入 | 即将开始 |
| PR9  | `agentctl doctor`、历史回放、事件归档 | 计划中 |
| PR10 | 混沌 / 并发压测套件 | 计划中 |
| v2.x | HTTP 传输、watcher daemon、Windows、NFS | 推迟 |

完整路线图：[docs/ROADMAP.md](./docs/ROADMAP.md)。

---

## 文档

| 文档 | 什么时候看 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 想理解**为什么**协作层做成这个样子 |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | 需要 `.multi-agent/` 下每个文件/JSON 的精确布局 |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | 你要让一个 agent 对接到 `agentctl` |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | 想看协作策略（worklog / report / RFC / 升级规则） |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 想知道下一步要发什么 |
| [CHANGELOG.md](./CHANGELOG.md) | 想看 release notes |
| [AGENTS.md](./AGENTS.md) | 你正在编辑本仓库（人或 agent） |

---

## 本地开发

```bash
git clone <本仓库>
cd codex-agent
npm install
npm run build
npm test                # 19 个 vitest 用例，约 1.3 秒
./bin/agentctl --help
```

代码组织、约定、"不要把 v0.1 加回来"的护栏在
[AGENTS.md](./AGENTS.md)。

---

## License

MIT.
