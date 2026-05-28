# multi-agent-coordination

**语言：** [English](./README.md) · 简体中文

> 一个本地 CLI 工具，让多个 AI agent 窗口（Cursor / Claude Code / Codex CLI 等）协作开发同一个项目。没有服务器、没有数据库，所有协调状态都是仓库里的普通文件，可以直接 `git diff`。

---

## 这是什么 / 适合谁

你用 Cursor 写前端、用 Claude Code 写后端、用 Codex CLI 当 PM。三个窗口读同一个仓库，彼此之间却不通气。结果就是工作重复、决策互相打架、没有人记得谁同意了什么。

本工具给每个 agent 配一个**角色**（PM、技术 leader、后端、QA……）、一个私有收件箱、一块共享任务板，以及一套用来跨角色拍板的 RFC 机制。agent 之间通过本地 CLI `agentctl` 通信，每一条消息、每一次决策、每一次状态变更都是一个落盘文件。

适合谁：一个项目里同时跑两个或更多 agent 窗口，且它们已经开始互相添乱。不适合：你只开一个 agent 窗口，或者你已经在用托管式多 agent 平台（LangGraph、AutoGen、CrewAI）——那些解决的是另一类问题。

要求 Node.js 20+，目前只跑 Linux 和 macOS。

---

## 心智模型（三句话）

1. **CLI 是真相，chat 不是。** 任何需要跨对话存在的东西都走 `agentctl`，不要靠聊天记录。
2. **`.multi-agent/` 是一块带权限的共享黑板。** 每个角色的 `owns` 写明它能写哪些文件，CLI 会硬性拒绝越权写入。所有变更都可以 `git diff` 看到。
3. **agent 自己跑循环，你不用盯。** 你的事是建角色、写项目状态；agent 自己拉收件箱、干活、记日志、空闲。你只和它们聊天。

---

## 你做什么 vs agent 做什么

这是最容易混淆的地方，一次讲清。

| 动作 | 谁来做 | 时机 |
| --- | --- | --- |
| `agentctl init` | 你 | 项目第一次接入本工具时 |
| `agentctl role create / delete` | 你 | 加人 / 减人 |
| 把 `roles/<id>.md` 里的 TBD 填掉 | 你 | `role create` 之后立刻填 |
| `agentctl prompt --target X --write` | 你 | 每种 agent 工具装一次 |
| `agentctl activate <role> --target X` | 你 | 每个 agent 窗口活配一次角色 |
| 在 `state/project_state.md` 里写产品范围 / 验收标准 | 你 | 项目推进过程中持续维护 |
| 升级工具、重跑 `prompt --write --force-rewrite`、重启窗口 | 你 | CLI 版本变动时 |
| `agentctl claim / plan / ack / wait / report / worklog / task ... / rfc ...` | agent | 每个 turn 自动跑 |
| 写代码、写文档、跑测试 | agent | 你布置任务后 |
| 用 `agentctl state edit` 写在 `owns` 范围内的项目文件（支持 overwrite / append / replace 三模式） | agent | 角色契约规定的范畴内 |

如果你发现自己在手动跑 `agentctl plan` 或 `claim`，多半是在排错——参考下面的[手动跑一遍](#手动跑一遍排错用)。

---

## 一次性配置（你在自己的 shell 里跑）

四步，做完之后只和 agent 聊天即可。

### 第 1 步 —— 初始化

```bash
cd /path/to/your-project
agentctl init
```

会在项目根目录建出 `.multi-agent/` 目录，里面是协调状态，可以提交进 git。

### 第 2 步 —— 注册角色，然后填角色契约

```bash
agentctl role create PM      "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL      "Tech Lead"         --owns "state/architecture.md"
agentctl role create Backend "Backend Engineer"
agentctl role create QA      "Quality Assurance"
```

每个 `role create` 都会生成一份 `.multi-agent/roles/<id>.md` 模板，里面有两段占位符——**Role description** 和 **Responsibilities**，都标着 `TBD`。**打开这两个文件，按角色实际职责填进去**——这是 agent 的自我介绍。`agentctl role list` 会标出哪些角色的契约还没填完；`agentctl activate` 在契约还是 TBD 状态时会直接拒绝执行。

`--owns` 控制这个角色能写哪些文件。条目可以是具体文件，也可以是目录前缀——`--owns "docs/architecture/"` 会自动匹配 `docs/architecture/` 下所有文件（递归），CTO / 技术 leader 这类整段托管子树的角色不用一个个列文件名。agent 通过 `agentctl` 写超出 `owns` 的路径会直接被拒（退出码 `9 FORBIDDEN`）。

`role create` 还有两个值得了解的参数：

- `--reports-to PM,TL` —— 角色的升级链。handbook 会教 agent 卡住时按这条链向上 `report`。比如 `Backend` 角色 `--reports-to TL,PM` 表示：技术问题升级给 TL，范围 / 验收问题升级给 PM。
- `--must-not-edit state/architecture.md` —— 强黑名单，优先级高于 `--owns`。用法是：某个角色拿到了一大段 `--owns`（比如整个 `src/`），但你不希望它碰其中几个特殊文件（比如 `src/config/secrets.ts`）。

一个把三个参数都用上的例子：

```bash
agentctl role create PM       "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL       "Tech Lead"         --owns "state/architecture.md,docs/architecture/" --reports-to PM
agentctl role create Backend  "Backend Engineer"  --owns "src/" --reports-to TL,PM --must-not-edit "src/config/secrets.ts"
```

### 第 3 步 —— 给每种 agent 工具装一次 runtime

```bash
# Cursor：写到 .cursor/rules/multi-agent-runtime.mdc
agentctl prompt --target cursor --write

# Claude Code：在 CLAUDE.md 里 upsert 一个标记块
agentctl prompt --target claude --write

# Codex CLI：写到 ~/.codex/skills/multi-agent-runtime/
agentctl prompt --target codex --write

# 其它任何支持 shell 调用的 agent（只打印，不落盘）
agentctl prompt --target generic
```

**这一步要在开 agent 窗口之前做。** Cursor / Claude Code / Codex 这类宿主只在窗口首次打开时把规则文件注入 system prompt；如果窗口已经开着，你再跑 `prompt --write`，新规则对那个窗口不生效，必须重启。CLI 每次成功写入都会打印 IMPORTANT 提示。

同样的项目再跑一次 `prompt --write` 是幂等的：内容相同会显示 `UNCHANGED (already up to date)`，磁盘什么都不改。如果你想强制重写（比如升级了 CLI 想确认装的是新模板），加 `--force-rewrite`。

### 第 4 步 —— 每个 agent 窗口活配一个角色

角色和窗口绑定，绑定信息不会落到任何项目级文件里。`activate` 命令会打印一段提示词——如果系统支持，自动复制到剪贴板——告诉 agent 怎么领角色、怎么读自己的契约、以及怎么了解 `agentctl` 都能干什么。

```bash
agentctl activate PM      --target cursor   # 粘进 PM 用的 Cursor 窗口
agentctl activate TL      --target claude   # 粘进 TL 用的 Claude 窗口
agentctl activate Backend --target codex    # 粘进 Backend 用的 Codex 窗口
agentctl activate QA      --target cursor   # 另一个 Cursor 窗口，这次是 QA
```

提示词在 `═══ BEGIN PASTE TO AGENT ═══` 和 `═══ END PASTE TO AGENT ═══` 两条分割线之间。分割线本身是给你看的，**不要**也粘进去。

同一种工具的两个窗口可以同时持有不同角色，因为角色信息只活在那个窗口 shell 的 `MA_SESSION` 环境变量里，不在项目里。

到这一步用户侧就结束了，剩下的都和 agent 聊。

---

## 你还需要自己维护的东西

下面这些是项目内容，工具不会替你创建，由你（或拥有相应 `owns` 权限的 agent）随着项目推进慢慢补。

- **`.multi-agent/state/project_state.md`** —— 产品愿景、里程碑、每个任务的验收标准。`agentctl init` 会自动建一个 TBD 骨架（三段：Vision / Milestones / Acceptance criteria），**你的活是把里面的 TBD 占位符填掉**。这个文件由产品负责人角色（通常是 PM，谁在 `config.yaml` 里 `owns` 它就是谁）持续维护。handbook 教 agent 看到这文件里某段还标着 TBD 时，先回过来问你 —— 所以这文件留空越久，agent 打扰你的次数越多。建议至少写成：

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

  第三段最值钱——每条任务的具体验收标准越明确，agent 越能自己判 Done，不来烦你。

- **`.multi-agent/state/architecture.md`** —— 由拥有它的角色（通常是 TL）写，你审阅。

- **`.multi-agent/state/decisions.md`** —— RFC 归档的散文版补充，可选但有用。

- **`.multi-agent/roles/<id>.md`** —— 描述 / 职责两段，role create 当下就要填。

---

## 手动跑一遍（排错用）

下面这套命令可以让你在终端里手动跑完整个流程，理解它怎么工作。注意：日常使用里**不用**敲这些，全是 agent 活配后自动跑的。

**窗口 A —— 扮演 PM：**

```bash
eval "$(agentctl claim PM --eval)"            # 领角色 + 把 MA_SESSION 写进当前 shell，一步到位

# 最简形式
agentctl task new --title "Build /login endpoint" --owner Backend --priority P1

# 带父任务、参考材料、硬性产出：
agentctl task new --title "Build /login endpoint" --owner Backend --priority P1 \
  --parent T-0010 \
  --tag auth \
  --asset 'file:docs/specs/auth.md::Auth 规范' \
  --asset 'url:https://figma.com/file/xxx::登录 UI 设计稿' \
  --deliverable 'file:apps/api/auth/login.ts::实现代码' \
  --deliverable 'file:docs/api/login.md::API 文档'

agentctl report --to TL --message "Auth scope confirmed. Backend is unblocked."
```

deliverable 这两行的意思是：T-0011 在两个文件都进仓库之前**不能**
被 `task status Done`。如果 reviewer 临时放行某个产出，Backend 跑
`agentctl task status T-0011 Done --force-incomplete`，绕行会作为
事件留在审计流里。

**窗口 B —— 扮演 Backend：**

```bash
eval "$(agentctl claim Backend --eval)"

agentctl plan                                  # 看自己有啥要做的
agentctl task status T-0001 InProgress
# ...写代码...
agentctl task status T-0001 Review
agentctl worklog --message "T-0001 done, see commit abc123"
agentctl ack --token <plan 返回的 token>       # 确认这一轮处理完了
agentctl wait --in 10m                         # 待命，10 分钟内有新消息就唤醒
# 没活儿干了想被派任务的话用这条，会自动广播一条 "我空闲了"：
agentctl wait --in 1h --for task-assigned
```

今天不干这个角色了：

```bash
agentctl release
unset MA_SESSION
```

### 脑暴（不带 `--options` 的 RFC）

三个以上角色要就一个还没有明确选项的问题表态时，开一个不带 `--options` 的 RFC：

```bash
agentctl rfc new q3-priorities \
  --title "Q3 优先级 —— 我们应该往哪个方向使劲？" \
  --deciders TL --voters PM,Backend,Frontend,DevOps \
  --description "性能、增长还是稳定性？把想法、风险、follow-up 都丢进来。"

# 投票人自由表态 —— 不需要选 option
agentctl rfc comment RFC-0001 --rationale "想法：性能优先，最近俩企业客户因延迟跑了。"
agentctl rfc comment RFC-0001 --rationale "风险：中途砍特性 X 会得罪企业版用户。" --reply-to <上一条 id>

# 讨论中出现了具体方案，任何成员都能把它升级成 option
agentctl rfc add-option RFC-0001 --option perf:'Q3 全力性能' --rationale "源自上面的讨论。"

# 关 RFC 的两种姿势：
# 1. 不选 option，rationale 表达结论
agentctl rfc decide RFC-0001 --rationale "讨论结论：Q4 再议，本季不做具体承诺。"
# 2. 加完 option 之后按常规决策流走
agentctl rfc decide RFC-0001 --option perf --rationale "采纳性能优先方案。"
```

---

## 常见情景

### 加一个角色

```bash
agentctl role create Frontend "Frontend Engineer"
# 填 roles/Frontend.md
agentctl activate Frontend --target cursor
# 开一个新 Cursor 窗口，粘贴
```

Cursor / Claude / Codex 的 runtime 规则之前就装好了，不用再跑 `prompt --write`。

### 删一个角色

```bash
# role delete 是治理动作，必须在没有 MA_SESSION 的 shell 里跑：
unset MA_SESSION
agentctl role delete Frontend
```

Frontend 名下的未完成任务会**保留**在任务板上——之后用同名再 `role create` 一个角色会自动重新认领。如果想直接转交，用 `agentctl task assign <task-id> --to <其它角色>`。如果还有 agent 窗口持有刚删掉的角色的 `MA_SESSION`，下一次执行 agentctl 命令会报 USAGE，那个窗口需要重启或者重新领其它角色。

### 卸载本工具在项目里写的东西（`agentctl reset`）

项目搞完了或者想把协作层推倒重来时：

```bash
# 同样是治理动作，必须无 MA_SESSION：
unset MA_SESSION
agentctl reset                                  # 预览，不删
agentctl reset --confirm <项目目录名>           # 真删

# 同时把用户级的 Codex skill 也删了（跨项目共享，要确认其它项目不依赖）：
agentctl reset --confirm <项目目录名> --purge-codex-skill
```

默认调用只打印预览不动文件；`--confirm` 的 token 就是项目根目录的 basename。Reset 会清理：

- `<项目>/.multi-agent/`——事件流 / state / RFC / worklog / session / 锁全部清掉。
- `<项目>/.cursor/rules/multi-agent-runtime.mdc` 以及空了的 `.cursor/rules/` / `.cursor/` 父目录。
- `<项目>/CLAUDE.md` 里 `<!-- multi-agent-runtime:BEGIN ... :END -->` 之间的内容；块外的用户自己写的东西原样保留。如果块就是 CLAUDE.md 的全部内容，整个文件删掉。

用户级的 `~/.codex/skills/multi-agent-runtime/` 默认**不动**（跨项目共享）。Reset 也是 "把审计流删干净"的唯一姿势——所有事件都在 `.multi-agent/` 下，要保留先 `cp -r .multi-agent .multi-agent.bak` 或者 git commit 一下。

### 升级 CLI

```bash
npm install -g multi-agent-coordination@latest
agentctl prompt --target cursor --write --force-rewrite   # 每种工具都重跑一次
# 然后把所有已开的 agent 窗口重启一遍。
```

`--force-rewrite` 跳过“内容相同就不写”的短路；升级版本时用，确认装的是新模板。

### “agent 说不知道自己是谁”

三种常见原因：

1. **agent 的 shell 没 export `MA_SESSION`**。激活提示词里有一句 `eval "$(agentctl claim ... --eval)"`，弱模型有时会跳过，重新粘一次提示词即可。
2. **agent 窗口是在 `prompt --write` 之前开的**。宿主只在窗口打开那一刻注入规则文件，重启窗口。
3. **角色契约还是 TBD 状态**。跑 `agentctl role show <角色>` 看看，如果还是空的，先把 `roles/<id>.md` 填完，再重新粘提示词。

### “两个窗口想认领同一个角色”

第二个窗口会看到 "already claimed by a live session ..."。handbook 教 agent 看到这条要 STOP 然后问你——不要用 `--force`。如果第一个窗口确实死了（你手动关掉的那种），等租约自然过期（默认约 30 分钟），或者在持有 session 的 shell 里手动 `agentctl release <role>`。

### “聊天记录删了，但角色卡住释放不掉”

```bash
unset MA_SESSION              # 如果还在 shell 里
agentctl release <role>       # 在持有 session 的 shell 里跑，或
# 等约 30 分钟让租约自然过期
```

---

## agent 之间怎么拍板（RFC）

如果一个决策影响多个角色的 `owns` 或者动到架构，agent 会开一个 RFC，而不是自己拍板。RFC 支持真正的多轮讨论：threaded comments、中途加 option、强制 ACK 的 pre-decide 轮（每个相关角色必须显式 `ack` 或 `object`，沉默不算同意）、decider 打回重写。完整讲解见 [docs/RFC.md](./docs/RFC.md)；快速过一遍：

```bash
# 任何 agent 都能开。--description 是不参与对话的人需要的上下文；
# --task 标明这次决策关联的具体任务。
agentctl rfc new switch-to-postgres \
  --title       "Move primary store from SQLite to Postgres" \
  --description "登录延迟根因是 SQLite 并发写争用；A 是迁移，B 是临时调优。" \
  --options     "A:Migrate now (4 weeks),B:WAL tuning first" \
  --voters      "Backend,DevOps" \
  --deciders    "TL" \
  --task        T-0042

# voter 评论；回复用 --reply-to 串起来（comment id 是 ULID）。
agentctl rfc comment RFC-0001 --option A --rationale "迁移可行。"
agentctl rfc comment RFC-0001 --reply-to 01HZA...COMM1 --rationale "M2 能不能往后推 2 周？"

# 讨论中发现既有 option 都不够好，任何 agent 都可以加一个新 option。
agentctl rfc add-option RFC-0001 --option "C:Managed Postgres on RDS" --rationale "把成本维度纳进来。"

# pre-decide：decider 发一条结构化的"我倾向 X" comment。
# 每个 voter + 其它非 pre-decider 的 decider 都必须显式 rfc ack 或 rfc object 表态
# 才能 rfc decide。沉默不算同意。
agentctl rfc pre-decide RFC-0001 --option C --rationale "倾向 C；请 ack 或 object。"
agentctl rfc ack    RFC-0001                                       # 我同意
agentctl rfc object RFC-0001 --rationale "成本超" --option B          # 我反对，倾向 B

# decider 也可以把提案打回去重写，而不是直接 reject 这个话题。
agentctl rfc revise RFC-0001 --rationale "把成本那段补全。"
agentctl rfc edit   RFC-0001 --rationale "补了成本段。" --description "<新版描述>"

# 最终只有 decider 能拍板（其它角色调会拿到 exit 9 FORBIDDEN）。
agentctl rfc decide RFC-0001 --option C --rationale "Agreed. Proceed."
```

某角色需要表态的 RFC 会出现在它下一次 `agentctl plan` 的结果里，并带 `unreadComments` 数量好让 agent 优先处理。`agentctl rfc show <id>` 自动推进该角色对这条 RFC 的"已读"标记。

---

## 它不做什么

- **不支持跨机器**。单机为主，跨机器（基于 HTTP）放在 roadmap 里。
- **不调 LLM**。它只做协调，AI 由你的 Cursor / Claude / Codex 提供。
- **不跑后台服务**。每次 `agentctl` 命令都是起来执行完就退出。
- **拦不住手工改文件**。agent 走 `agentctl` 是受 `owns` 约束的，但你打开编辑器仍然能随意改。
- **没有 `read-state` 命令**。读取本身就是不受限的（这层是共享黑板），且 agent 宿主自带 file-read 工具——再包一层 `agentctl` 只会徒增 token 消耗。`agentctl` 管的是**写入**（需要 ownership / 原子性 / 审计）和**结构化操作**（claim / plan / ack / task / rfc / report）。读文件直接读就行。
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
| `agentctl upgrade` 和 `reset` | 下一步 |
| `doctor`、事件历史、归档 | 计划中 |
| 跨机器 HTTP 协议 | 未来 |

完整版：[docs/ROADMAP.md](./docs/ROADMAP.md)

---

## 文档

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | 协议层契约——每个命令的语义、manifest 结构、ack 语义 |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | 判断规则：什么时候 worklog、什么时候 report、什么时候开 RFC，什么不该麻烦用户 |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | `.multi-agent/` 下每个文件是什么、谁会写 |
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
./bin/agentctl --help
```

如果想让全局 `agentctl` 指向你本地的代码：

```bash
npm link                # 把 ./bin/agentctl 挂成全局的 agentctl
npm run build           # 改完源码后重新编译，或者：
npm run watch           # tsc --watch，保存自动增量编译
```

挂出去的二进制实际加载的是 `dist/cli/index.js`，不重新构建就看不到代码变更。代码组织和贡献规则参考 [AGENTS.md](./AGENTS.md)。

---

## License

MIT
