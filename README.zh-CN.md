# multi-agent-coordination

**语言**：[English](./README.md) · 简体中文

> 一个本地 CLI 工具，让多个 AI agent 窗口在同一个项目里像团队一样协作——不需要服务器，不需要数据库，只用仓库里的文件。

---

## 它解决什么问题

你打开 Cursor 写前端，Claude Code 写后端，Codex 扮演 PM。它们都在看同一份代码，但它们互相不知道对方在做什么。结果就是：重复劳动、决策冲突，没有任何记录说明当初为什么这么做。

这个工具给每个 agent 分配一个**角色**（PM、技术 Leader、Backend、QA……），一个私有收件箱，和一块共享任务板。Agent 通过一个本地 CLI `agentctl` 相互通信。每一条消息、每一个决策、每一次状态变化，都以普通文件的形式保存下来，可以用 `git diff` 查看。

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Cursor     │  │  Claude     │  │  Codex      │  │  Cursor     │
│  角色: PM   │  │  角色: TL   │  │  角色: BE   │  │  角色: QA   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                                 ▼
              .multi-agent/   ← 纯文本，随项目提交到 git
              ├── state/        共享项目状态
              ├── comms/        agent 之间的消息和事件
              ├── rfcs/         提案和决策
              └── worklog/      每个 agent 的工作记录
```

---

## 适合谁用

满足下面任何一条就值得试试：

- 你在同一个项目里**开了两个以上的 AI agent 窗口**，它们会互相踩对方或重复工作。
- 你想保留一份**决策记录**——谁提的议、谁批准的、为什么——而且希望这份记录就是 git 里的普通文件。
- 你想让 agent 有**明确的角色分工**，跨角色的决策走正规流程，而不是各自为政。
- 你希望这一切**不依赖任何外部服务**——不需要 API key，不需要账号，不需要联网。

如果你只用一个 agent，或者你已经在用 LangGraph / AutoGen / CrewAI 这类托管的多 agent 平台，那这个工具解决的不是你的问题。

---

## 安装

需要 **Node.js 20 或更新版本**。

```bash
npm install -g multi-agent-coordination
```

alpha 阶段也可以直接 clone 仓库自己构建，见[本地开发](#本地开发)。

---

## 配置（每个项目做一次，总共四步）

配置完成后你只需要和 agent 正常聊天。下面的命令是你在自己终端里跑的，不是 agent 跑的。

### 第一步 — 初始化

```bash
cd /path/to/your/project
agentctl init
```

会在项目里创建一个 `.multi-agent/` 目录，存放所有协作状态。这个目录提交到 git 完全没问题。

### 第二步 — 创建角色

```bash
agentctl role create PM  "Product Manager"  --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL  "Tech Lead"        --owns "state/architecture.md"
agentctl role create Backend "Backend Engineer"
agentctl role create QA  "Quality Assurance"

agentctl role list
# PM       Product Manager
# TL       Tech Lead
# Backend  Backend Engineer
# QA       Quality Assurance
```

`--owns` 参数控制每个角色允许修改哪些文件。通过 `agentctl` 操作的 agent 无法写入它权限之外的内容。

### 第三步 — 为每种 agent 工具装一次运行时

**每种工具跑一次**。装出来的文件是角色无关的——同一个项目下的两个
Cursor 窗口、两个 Claude 会话，读的是同一份规则。

```bash
# 如果你用 Cursor：
agentctl prompt --target cursor --write
# 写入 .cursor/rules/multi-agent-runtime.mdc

# 如果你用 Claude Code：
agentctl prompt --target claude --write
# 在 CLAUDE.md 里 upsert 一个标记块

# 如果你用 Codex CLI：
agentctl prompt --target codex --write
# 写入 ~/.codex/skills/multi-agent-runtime/

# 其他任何能跑 shell 的 agent：
agentctl prompt --target generic
# 打印 runtime body 供你审阅；不必 --write（没有持久化位置）
```

### 第四步 — 每个窗口激活一个角色

角色绑定是**窗口级**的，绝不写进项目共享文件。每个你想要的角色开一个 agent
窗口，然后把 `activate` 打印的提示词粘到那个窗口的聊天里：

```bash
agentctl activate PM      --target cursor    # 粘到 PM 的 Cursor 窗口
agentctl activate TL      --target claude    # 粘到 TL 的 Claude 会话
agentctl activate Backend --target codex     # 粘到 Backend 的 Codex 终端
agentctl activate QA      --target cursor    # 再开一个 Cursor 窗口，给 QA
```

粘进去的内容会让那个窗口里的 agent 执行 `agentctl claim <role>`、export
`MA_SESSION`、然后进入运行循环。**同一种工具的两个窗口可以扮演不同角色，
互不干扰**。

到这里配置就全部完成了。之后你只需要和 agent 自然聊天。

---

## Agent 运行时在做什么

每个 agent 在每次回应开始时都会：

1. 检查收件箱里来自其他 agent 的新消息。
2. 从共享任务板上读取自己的活跃任务。
3. 读取需要它发表意见或做决定的提案（RFC）。
4. 做实际工作，然后发消息、更新任务状态、记录进展。
5. 进入低消耗的待机状态，等待下一条消息。

这一切都是 agent 用 `agentctl` 命令自动完成的，不需要你管。

### 手动跑一遍看看效果

你可以在自己终端里模拟这个流程，直观感受一下：

**窗口 A — 扮演 PM：**

```bash
agentctl claim PM
export MA_SESSION=<claim 打印出来的 session id>

# 创建一个任务并分配出去
agentctl task new --title "开发 /login 接口" --owner Backend --priority P1

# 给 TL 发消息
agentctl report --to TL --message "Auth 范围确认，Backend 可以开始了。"
```

**窗口 B — 扮演 Backend：**

```bash
agentctl claim Backend
export MA_SESSION=<session id>

# 查看所有等待处理的事项
agentctl plan

# 随着工作推进更新任务状态
agentctl task status T-0001 InProgress
# ... 真去写代码 ...
agentctl task status T-0001 Review
agentctl worklog --message "T-0001 完成，见 commit abc123"

# 确认已处理完这批事项
agentctl ack --token <plan 输出的 token>

# 进入待机
agentctl wait
```

---

## 跨角色决策怎么做（RFC）

当一个决定会影响多个角色——比如改架构、调整功能范围、在两个方案中选一个——agent 会发起一个 RFC（提案），而不是自己单方面决定。

```bash
# 任何 agent 都可以发起提案
agentctl rfc new switch-to-postgres \
  --title "把主数据库从 SQLite 换成 Postgres" \
  --options "A:立即迁移,B:维持现状" \
  --voters "Backend,DevOps" \
  --deciders "TL"

# 其他 agent 发表意见
agentctl rfc comment RFC-0001 --option A --rationale "迁移方案可行，风险可控。"

# 只有被指定为 decider 的角色才能关闭提案
agentctl rfc decide RFC-0001 --option A --rationale "同意，开始迁移。"
```

每个 agent 下一次调用 `agentctl plan` 时，会自动看到哪些提案需要它处理。不需要任何人手动追踪。

---

## 它做不了什么

- **不支持多台机器协作。** 所有内容在一台电脑上运行。多机支持在未来版本的规划里。
- **不调用 LLM。** 这是协作层，不是 AI 框架。AI 调用由你的工具（Cursor、Claude Code、Codex）负责。
- **没有后台常驻进程。** 每条 `agentctl` 命令都是即跑即退。
- **无法阻止直接编辑文件。** 通过 `agentctl` 操作的 agent 无法越权写文件，但有终端权限的人仍然可以直接用编辑器改状态文件，这个工具不是沙箱。
- **暂不支持 Windows。** 目前只支持 Linux 和 macOS。

---

## 进度

| 功能 | 状态 |
| --- | --- |
| 存储层、事件、会话、权限控制 | 已完成 |
| Agent 通信命令（`claim`、`plan`、`ack`、`report`、`worklog`、`wait`） | 已完成 |
| 角色配置和提示词生成（`role`、`prompt`） | 已完成 |
| 任务板（`task new/assign/status/list/show`） | 已完成 |
| 提案与决策（`rfc new/comment/decide/reject`） | 已完成 |
| 协作手册（内置的 agent 行为指引） | 已完成 |
| 升级和重置命令 | 即将开始 |
| 健康检查和历史查询（`doctor`、`history`） | 计划中 |
| 多机支持（HTTP 传输） | 未来版本 |

完整规划：[docs/ROADMAP.md](./docs/ROADMAP.md)

---

## 文档

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Agent 完整运行流程——每条命令是什么、什么时候用 |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | 行为判断指南——什么时候写 worklog、发 report、开 RFC、上报给用户 |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | `.multi-agent/` 下每个文件的内容格式 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 为什么这样设计 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本记录 |

---

## 本地开发

```bash
git clone <本仓库>
cd codex-agent
npm install
npm run build
npm test
./bin/agentctl --help
```

代码结构和贡献规范见 [AGENTS.md](./AGENTS.md)。

---

## License

MIT
