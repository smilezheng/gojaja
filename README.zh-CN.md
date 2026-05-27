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

**v2.0.0-alpha**。存储核心已经实现并通过测试。面向终端用户的命令
（`claim` / `plan` / `ack` / `report` / `wait` / `rfc …`）正在按 PR
逐个落地，详见 [docs/ROADMAP](./docs/ROADMAP.md)。今天能跑的内容在
下面 [快速上手](#快速上手) 中演示。

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

下面演示的是**当前 PR1（存储核心）已经实现的功能**。你会：

1. 在一个项目里初始化协作层。
2. 看一眼它创建了什么。
3. 检查 schema 版本。

### 1. 在项目里初始化

```bash
cd /path/to/your/project
agentctl init
```

输出：

```
Initialised multi-agent layer (v2.0.0) at /path/to/your/project/.multi-agent
```

这会创建 `.multi-agent/` 目录，**可以直接提交到 git**——里面全是纯文本
或 JSON，专门为代码 review 设计。

### 2. 看看创建了什么

```bash
ls .multi-agent
# VERSION  comms/  locks/  protocol/  rfcs/  roles/  state/  worklog/
```

| 路径 | 用途 |
| --- | --- |
| `roles/<role>.md` | 每个角色的契约（职责、可写域） |
| `state/` | 共享项目状态（目标、任务板、决策、风险） |
| `comms/events/` | 仅追加的事件流，一事件一个 JSON 文件 |
| `comms/inbox/<role>/` | 每个角色的收件队列 |
| `comms/cursors/<role>.json` | 每个角色"已读到哪里"的游标 |
| `comms/sessions/<role>.json` | 当前由哪个窗口占用某角色 |
| `rfcs/RFC-NNNN-<slug>/` | 每个跨角色决议一个目录 |
| `worklog/<role>/` | 每个角色的工作日志 |
| `locks/` | 短生命周期的文件锁（瞬时） |

完整 schema：[docs/SCHEMA.md](./docs/SCHEMA.md)。

### 3. 检查 schema 版本

```bash
agentctl version
# agentctl 2.0.0-alpha.0
# schema   2.0.0
```

所有命令都支持 `--json`，方便脚本和 LLM agent 解析：

```bash
agentctl version --json
# {"cli":"2.0.0-alpha.0","schema":"2.0.0"}
```

### 预览：完整的 agent 工作流（PR2 即将上线）

PR2 落地后，每个 agent 窗口的日常循环会是这样：

```bash
# 每个窗口启动时跑一次：
agentctl claim PM                       # 把这个窗口认领为 PM 角色
export MA_SESSION=<claim 返回的 session-id>

# 每一回合：
agentctl plan PM                        # JSON 输出：未读事件、收件、任务
# …agent 处理这些内容…
agentctl ack PM --token <ack-token>     # 安全推进游标

# 发送定向消息：
agentctl report --to TL --message "Goals locked in"

# 记录进展，全队可见：
agentctl worklog --message "Drafted acceptance criteria for T-0001"

# 不消耗 token 地保活，等下一轮：
agentctl wait PM --idle 10
```

完整的 wire-level 契约已经写在
[docs/PROTOCOL.md](./docs/PROTOCOL.md)，你可以现在就按它做对接。

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
- **RFC 是意见收集 + leader 拍板**。任何角色都能给 RFC 留意见，但
  只有在 RFC 的 `deciders` 列表里的角色才能把状态推到
  `accepted` / `rejected`。没有自动计票。

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
- **OS 级还没强制角色可写域**。契约已写在文档里，PR5 会引入
  `config.yaml` 做服务端校验；在那之前 agent 需要自觉遵守。
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
| PR1 | 存储核心：锁、事件、游标、会话 | **完成** |
| PR2 | `claim` / `plan` / `ack` / `report` / `worklog` | 即将开始 |
| PR3 | `wait`：无 token 消耗的保活 | 计划中 |
| PR4 | RFC 状态机（意见 + leader 决定） | 计划中 |
| PR5 | `config.yaml` 驱动的角色可写域强制 | 计划中 |
| PR6 | 安装器、`upgrade`、`reset`、AGENTS.md 注入 | 计划中 |
| PR7 | `agentctl doctor`、历史回放、事件归档 | 计划中 |
| PR8 | 混沌 / 并发压测套件 | 计划中 |
| v2.x | HTTP 传输、watcher daemon、Windows、NFS | 推迟 |

完整路线图：[docs/ROADMAP.md](./docs/ROADMAP.md)。

---

## 文档

| 文档 | 什么时候看 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 想理解**为什么**协作层做成这个样子 |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | 需要 `.multi-agent/` 下每个文件/JSON 的精确布局 |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | 你要让一个 agent 对接到 `agentctl` |
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
