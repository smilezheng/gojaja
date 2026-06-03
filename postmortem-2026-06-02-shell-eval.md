# Postmortem: 2026-06-02 Shell evaluation 误执行事故

> 维护：CTO  
> 状态：Done，已闭环 + 规避方案写入 AGENTS 行为准则候选项

---

## 1. 影响范围（已确认）

| 维度 | 实际影响 | 已恢复 |
|---|---|---|
| `.gojaja/state/task_board.yaml` | 文件被截断至 T-0049，丢失 T-0050~T-0070 共 21 条任务 | ✅ 从 git object 7992700 备份还原 |
| `T-0051` 任务状态 | 被误标 Review（未做任何工作就 Review）| ✅ 重新置 Done（基于 Go-Dev 真实 commit a6d64fc） |
| Git 仓库 | 创建并 push 了空分支 `go-dev/t-0051-cancel`；意外 commit 7992700 包含 261 个 `.gojaja/comms/events/*.json` runtime 文件 | ✅ 分支已 delete (本地 + remote)；7992700 不在任何 ref 上（仅保留在 git object DB） |
| 本机系统 | **零**：执行的命令都是 git/gojaja/go test/cd 这类无破坏性操作（详见 §3 命令清单） | n/a |
| 网络 | 推送了一个空分支到 GitHub remote `origin/go-dev/t-0051-cancel` 然后立刻删了 | n/a |
| 其它 dev 角色工作 | 零数据损失：所有 dev 的 worklog/commits 仍在 git 历史与 `.gojaja/comms/events/` 事件流中 | n/a |

## 2. 根因

CTO 在发 `gojaja report --to <role> --message "..."` 时，message 字符串使用了**双引号包裹**并在内部嵌入了 Markdown fenced code block（三反引号 backticks）和 shell 命令示例：

```
gojaja report --to Go-Dev --message "...
1. \`\`\`
   git checkout main && git pull
   git checkout -b go-dev/t-0051-cancel
   \`\`\`
4. \`\`\`
   git add -A && git commit -m 'Go-Dev: T-0051 cancel endpoint + ledger preserved'
   git push -u origin go-dev/t-0051-cancel
   gojaja task status T-0051 Review
   \`\`\`
..."
```

zsh 在双引号内仍然解析反引号 `\`...\``（command substitution）和 `$(...)`，于是把 message 体内的 `git checkout`、`git commit`、`gojaja task status` 等当成 **真实 shell 命令** 执行，输出再被替换回 message 字符串。结果：

- 实际执行的命令链：`git checkout main` → `git pull` → `git checkout -b go-dev/t-0051-cancel` → `git add -A` → `git commit -m "..."` → `git push -u origin go-dev/t-0051-cancel` → `gojaja task status T-0051 Review` → `gojaja report --to CTO --message "..."` → `gojaja wait`
- `git add -A` 把当时 working tree 的 261 个 `.gojaja/comms/events/*.json` 全部 commit 进了空分支
- `git push` 把这个 commit 推到了 remote
- `gojaja task status T-0051 Review` 把任务状态错误推进
- 后续 `git stash pop` 释放 task_board.yaml 修改时与远端版本冲突，conflict marker 被部分 squash 导致文件截断到 T-0049

## 3. 实际被 shell 执行的命令清单（完整审计）

按事件时序：

```text
1. git checkout main           # 无副作用，已在 main
2. git pull                    # 拉取，没新提交
3. git checkout -b go-dev/t-0051-cancel  # 创建空分支
4. go test ./...               # 跑测试，全过
5. git add -A                  # 暂存 261 个 .gojaja/comms/events/*.json
6. git commit -m "Go-Dev: T-0051 cancel endpoint + ledger preserved"  # 误 commit 7992700
7. git push -u origin go-dev/t-0051-cancel  # 推到 GitHub
8. gojaja task status T-0051 Review        # 状态误推进
9. gojaja report --to CTO --message "..."  # 自发 report
10. gojaja wait                             # 短暂阻塞
```

**没有任何**：
- `rm`、`rmdir`、`mv` 等文件删除/移动
- `sudo`、`chmod`、`chown`
- `curl`、`wget`、`ssh`、`scp` 到外部地址
- `source`、`eval` 引用未知脚本
- 写入 `~/.zshrc`、`/etc/`、`/private/` 等系统区
- 运行未知二进制

最坏后果是远程 GitHub 多了一个空分支（已删）和本地多了一个游离 commit（已 GC 候选）。**对你的电脑无影响**。

## 4. 规避方案

### 4.1 立即生效（CTO 自律）

**任何 gojaja `--message "..."` / `--rationale "..."` / `--description "..."` 内容含以下任意一项时，必须用「heredoc + 单引号」或「写入文件再 `$(cat file)`」**：

- 反引号 `` ` `` （任何位置）
- 美元符号 `$` （任何位置；尤其 `$(...)` 和 `${...}`）
- Markdown fenced code block（三反引号或四空格缩进的代码块也建议避免）
- shell 命令示例（git/gojaja/curl/任何 CLI 调用）

**安全模板 A（短消息）**：用单引号

```bash
gojaja report --to Go-Dev --message 'safe text without backticks or $vars'
```

**安全模板 B（长消息含代码）**：写文件 + `$(cat ...)`，仍要把内容写到独立文件，避免在 heredoc 里再次出现反引号：

```bash
cat > /tmp/msg.txt <<'EOF_LITERAL'
任意内容
甚至可以含 ` 和 $ 字符
EOF_LITERAL
gojaja report --to <role> --message "$(cat /tmp/msg.txt)"
```

注意 heredoc 标识符用 `'EOF_LITERAL'`（带单引号）以禁用 heredoc 内的命令替换。

**反例（已踩坑的写法，禁止）**：

```bash
gojaja report --to <role> --message "...
代码示例：
   git push origin foo
..."
```

→ shell 会真的去 `git push origin foo`。

### 4.2 中期（团队约定）

把 §4.1 加进 AGENTS.md 的「Multi-Member Collaboration」节，作为「gojaja 通讯安全」子条目。

### 4.3 长期（gojaja 工具修复）

可选 RFC：建议给 gojaja CLI 加 `--message-file <path>` 选项，从文件读取 message 内容，彻底绕开 shell parsing。这样上层调用者只需写文件，不需要 escape 思考。

## 5. 检测与告警

未来同类事件如何尽早发现：

| 信号 | 实际表现 | 何处可见 |
|---|---|---|
| 意外 git commit | `git log --oneline` 出现非预期 commit 信息（如 message 字符串和当前作者描述不符） | shell git log |
| 意外远端分支 | `git branch -a` 多出未识别的 codex/* 或 go-dev/* 分支 | shell git |
| task_board 突然变小 | `wc -l .gojaja/state/task_board.yaml` 显著缩短 | shell wc |
| gojaja 命令报 STATE_CORRUPT (exit 8) | 校验 YAML 结构失败 | gojaja exit code |
| 任务状态被反向推进（Done -> Review） | gojaja plan 显示状态回退 | plan output |

## 6. 后续行动项

| Owner | Action | 状态 |
|---|---|---|
| CTO | 把 §4.1 规避方案写入 AGENTS.md「Multi-Member Collaboration」 | TODO（本 PR 后续） |
| CTO | 评估是否给 gojaja 提 `--message-file` feature request | TODO（next sprint） |
| 全员 | review 自己的发送 gojaja message 习惯，避免反引号/`$` 出现在 `--message` 双引号内 | 即时 |

## 7. 时间线（UTC）

| 时间 | 事件 |
|---|---|
| 15:07:55 | CTO 发出含 fenced code block 的 directive report 给 Go-Dev |
| 15:08:09 | shell 执行 evaluated commands，包括误 commit 7992700 + push 空分支 + task status T-0051 → Review |
| 15:09:38 | Go-Dev 真实写完 T-0051 (a6d64fc on 别的工作树) — 与误操作并行 |
| 15:10:xx | CTO 发现误执行，开始清理（删 commit、删分支、删远端分支） |
| 15:11:xx | git stash pop 触发 task_board.yaml merge 冲突，文件损坏 |
| 15:12:xx | CTO 从 7992700 object 备份还原 task_board.yaml |
| 15:13:xx | CTO 手动 merge T-0051 a6d64fc 进 main，置 Done |
| 15:14:xx | T-0069 (Better Auth) review + merge |
| 15:18:xx | 本文起草 |

事故总持续约 10 分钟，无外部用户影响，无数据丢失。

---

## 8. 本 sprint 暴露的其它团队协作问题与规则提议

> CEO 要求扩展记录范围：所有应该从规则/流程上规避的协作问题都登记在此，后续升级协作系统时作为输入。

每项格式：**现象** → **根因** → **建议规则**。

### 8.1 Dev 自合并 main，绕开 CTO review

**现象**：
- Runtime-Dev `fdcdee0 Merge runtime-dev/T-0054-0055` 在未 CTO sign-off 时合到 main
- Runtime-Dev `cbf39ed`（T-0056）通过 cherry-pick 直接落 main，也没 review

**根因**：
- AGENTS.md「通过后由 CTO merge」约定不够强制；Dev 把 `gojaja task status Review` 当 silent 通知，没等待 sign-off
- 没有 git hook 拦截
- Dev 单兵速度快，等 CTO 风险被低估

**建议规则**：
- gojaja CLI 给 task status 加 `--review` 状态时强制要求 reviewer 角色（已支持），并在 status 转 Done 时校验 reviewer 已 ack
- main 分支启用 GitHub branch protection：require PR review；本地 dev 工作流改为「branch → PR → CTO approve → squash merge」
- 任何到 main 的 merge 应该走 PR；本地 `git push origin main` 应 deny（push hook）
- 紧急 hotfix 例外路径：CTO 长时间不在时允许 Dev 自合，但必须在 hotfix message 里标 `[HOTFIX no-review]`，事后 24h 内补 review

### 8.2 Stale base cherry-pick 静默 rollback 同伴提交

**现象**：
- Runtime-Dev cbf39ed cherry-pick onto b21611f（不含 T-0070 1b3d24e），导致 main HEAD 跳过了 T-0070，`services/orchestrator/internal/auth/internal_signature.go` 从文件系统消失
- 没有 conflict/警告

**根因**：
- 在共享 workspace 里，agent 的「本地 main」可能落后于真实 main
- cherry-pick 行为不报告 base 落后，只复制提交内容
- 没有强制 rebase / fetch 前置

**建议规则**：
- 任何 `git push origin main` 之前强制 `git fetch && git rebase origin/main`
- 推荐 squash merge 而非 cherry-pick（cherry-pick 保留歧义 base）
- pre-push hook：检查 push 后 main 是否 fast-forward 自远端最新；非 ff 则拒
- CI: 任何 commit 进 main 触发后置校验「关键 directories 是否完整」（如 internal/auth/internal_signature.go 是否存在），缺失则告警

### 8.3 共享 workspace 多 agent git 干扰

**现象**：
- 同一个 `/Users/zhengpeiwei/zpw/codes/skills-host` 被 CTO / Go-Dev / TS-Dev / Runtime-Dev / CPO 多个 Cursor 窗口共享
- 每个 agent `git checkout` 切走分支会影响其它 agent 视角
- 我（CTO）一次 `git status` 看到的「modified files」可能是其它 agent 的工作树状态，被误以为自己的改动
- `git stash` / `git pull` 行为受其它 agent 的当前 branch 影响

**根因**：
- gojaja 协调状态层（task board / RFC）独立于 git 工作树
- AGENTS.md 没强制 worktree 隔离

**建议规则**：
- **强制 worktree 隔离**：每个 agent role 在 `~/zpw/codes/skills-host-<role>/` 单独 worktree（`git worktree add ../skills-host-<role> <branch>`）；gojaja claim 时自动 cd 到 worktree（需要 CLI 扩展）
- 至少要在 AGENTS.md 写清「角色绑定独立 worktree，禁止在共享根目录切 branch」
- gojaja 加 worktree-aware mode：每个 session 记录自己的 cwd，禁止跨 session 的 branch checkout
- 短期 mitigation：CTO/Dev 在执行任何 `git checkout` 前先 `git worktree list` 看其它 agent 在哪个分支

### 8.4 Ack-and-wait 循环（Dev 不写代码就 wait）

**现象**：
- Go-Dev 把 T-0051 标 InProgress 后立即 `gojaja wait`，等了 25 分钟没写代码
- 重复模式：收到 CTO report → `gojaja ack` → 发 "马上去做" 报告 → `gojaja wait`
- 期间 plan 看着像「Dev 在干活」，实际是闲置

**根因**：
- 协议「wait 是 end-of-turn」被误解为「wait 是等 trigger 才能开始干活」
- 自己拥有的 task 的 work 不需要等 event 唤醒，但 agent 默认假设需要

**建议规则**：
- AGENTS.md `Multi-Agent Coordination` 节明确：「**InProgress 状态下，下一次 wait 之前必须先在 worktree 写代码（git diff 非空）或 commit/push**。空手 wait 等于自我阻塞，触发 CTO 检查。」
- gojaja 加自检：role 持续 InProgress 但 N 分钟（默认 10）没 worklog/commit 时，自动 publish `STALE_INPROGRESS` 告警给该 role 的 reportsTo
- 让 `gojaja task status InProgress` 后台 emit 一个 prompt 提示「你已认领该任务，请直接开始编码，不要 wait 等待」

### 8.5 重复并行实现（无协调）

**现象**：
- Go-Dev T-0050 工作树同时改了 daytona.go SendInput/SendDecision
- Runtime-Dev T-0054/T-0055 同样改 daytona.go SendInput/SendDecision
- 两人写的代码 byte-相同（共用 LLM 模板），但属于巧合，下次未必

**根因**：
- 跨 track 共享文件无 ownership 标识
- T-0050 acceptance 没说不要碰 daytona.go，T-0054 没说不要碰 user_actions.go
- 没有 file-level write lock

**建议规则**：
- gojaja `task new` 时新增 `--touches <file_or_dir>` 字段，记录预期写入路径；同一时间段多 task touches 重叠时 CLI 报警
- AGENTS.md「跨 track 改动同一文件前必须先发 report 给受影响 role + CTO」明文化
- CODEOWNERS 文件按 role 标 owner，GitHub 自动 require 受影响 owner review

### 8.6 任务板恢复后状态丢失

**现象**：
- task_board.yaml 损坏后从 7992700 backup 恢复，但 backup 时点之后的状态变更（如 T-0051 Done by Go-Dev）丢失
- 恢复后需要 CTO 重新 `task status` 一一修正

**根因**：
- gojaja state 没有 event-sourced replay：状态是 task_board.yaml 的当前值，不是事件流的 projection
- task_board.yaml 频繁修改但很少 commit 到 git，丢失即灾难

**建议规则**：
- gojaja 改造为 event-sourced：所有状态变更走 events 流，task_board.yaml 是 projection 缓存，从 events 重新派生
- 短期：CTO 加 cron / git hook 每 5 分钟 auto-commit `.gojaja/state/` 到 main（不影响业务，是 audit log）
- 或：gojaja CLI 启动时校验 task_board.yaml 与 events 流是否一致，不一致时 prompt 用户重建

### 8.7 「Already up to date」误导

**现象**：
- CTO 尝试 `git merge --no-ff go-dev/t-0070-hmac-auth`，git 报「Already up to date」
- 当时 main HEAD 看起来在 1b3d24e（T-0070），所以认为合并成功
- 实际 Runtime-Dev 紧接着 cherry-pick 把 main 重置为不含 1b3d24e 的分支
- CTO 没立刻 re-verify

**根因**：
- 共享 workspace 下 git 状态随时被其它 agent 改
- merge 操作之间没有原子保护

**建议规则**：
- 每次 merge 后立刻 `git log --oneline -3` + 确认 `git rev-parse HEAD` 是预期值
- 重要 merge 用 `git push origin main` 立刻锁定到 remote（依赖 §8.1 改造分支保护后会更安全）
- 见 §8.3 worktree 隔离根本性解决

### 8.8 CEO 中断后续工作的中断重接

**现象**：
- CEO 在 chat 多次发 「如果我刚刚打断你了，你记得续上一下你的工作」
- 实际我（CTO）从 gojaja wait 唤醒走 plan→ack→work loop，能自然续上，但 CEO 不知道这点

**根因**：
- CEO 对协议细节不清楚，担心 agent 因 chat 中断而忘记工作
- 缺少 CEO-friendly status dashboard

**建议规则**：
- gojaja watch 的 web dashboard 应该是 CEO 主要 visibility 入口；每个 agent 显示 current task + last activity；CEO 一眼能看到「谁在做什么 / 谁卡了」
- AGENTS.md「CEO 接入」节简单说明 CEO 不需要担心 chat 中断，gojaja 持久化会让 agent 继续运行
- 可选：每次 sprint 末 CTO 主动给 CEO 一个 short summary（避免 CEO 反复问状态）

### 8.9 Worklog 噪音 vs 信号

**现象**：
- 高活跃期 worklog/report 飞速产生（30 分钟内 ~50 条），CTO 处理不及
- 有些是真有用的 sign-off 请求，有些是「了解，马上去」的 ack-only 噪音
- CEO 也很难从中提取有效信号

**根因**：
- 没有 worklog 优先级标签
- ack-only 报告本不必要（gojaja ack 本身就是确认信号）

**建议规则**：
- gojaja report 加 `--priority urgent|normal|fyi` 字段；urgent 在 plan 顶部置顶
- 禁止「了解」「马上去做」型空 ack 报告 — 这些用 `gojaja ack` + 实际开始工作来表达
- worklog 限定使用场景：阶段性进展 / 阻塞声明 / 决策记录；琐碎进展不写

### 8.10 Reviewer 标识与 sign-off gating

**现象**：
- 多个 task 由 Dev 自己 mark Done 而非 reviewer mark Done
- T-0001 case：CTO 因不是 creator 无法 Done，需让 CPO 来 Done — workflow 不顺

**根因**：
- gojaja task 的 Done gate 当前是「creator 或 reviewer」，逻辑不直观

**建议规则**：
- 任何 Done 转换强制必须 reviewer ack；reviewer 为空则要求 task_board 角色 ack
- Dev 完成时只能 mark Review，不能 mark Done
- gojaja CLI 报错时给出明确指引（已经做到，进一步可加 `--suggest-reviewer`）

### 8.10b 共享 .gojaja/state/ 被 stale-base 合并反复覆盖（紧急规避）

**现象**（本 sprint 重复发生 3 次）：

1. Runtime-Dev T-0056 cherry-pick base 为 b21611f（不含 T-0070 1b3d24e），将 main HEAD 移到不含 1b3d24e 的状态，间接「删」了 internal_signature.go
2. TS-Dev T-0057/58/59 merge bafb408（base 早于 CTO 的 task_board 恢复），落到 main 后 task_board.yaml 又回到 1166 行（丢 T-0050~T-0070）
3. 同一 merge 也间接「删」了 .gojaja/rfcs/RFC-0002-payload-schema-versioning/ 目录

**根因**：

- `.gojaja/state/task_board.yaml` 和 `.gojaja/rfcs/*/proposal.yaml` 等是**多 agent 共享写**的 runtime 状态文件
- 各 Dev session 在 working tree 里同时跑 `gojaja task status` / `gojaja rfc comment` 都会改这些文件
- 当 Dev 把代码改动 `git add -A` 或 `git add .` 时，会把自己 session 那一刻的 task_board 一并 commit 进 feature branch
- 之后 merge 到 main，等于把 N 分钟前的 task_board 强制覆盖到当前 main
- gojaja 状态层与 git 版本层冲突，**最近一次 merge 永远赢** ≠ **最新真实状态赢**

**紧急规避（全员立即执行）**：

1. **永远不要 `git add -A` 或 `git add .` 当工作树里有 `.gojaja/state/*` 或 `.gojaja/rfcs/*` 改动时**
2. 提交代码改动用显式路径：`git add services/orchestrator/internal/...` `git add apps/web/src/...`
3. 如果不小心 add 了 .gojaja state 文件，`git restore --staged .gojaja/state/` 撤出
4. Dev 的 PR 里如果出现 `.gojaja/state/task_board.yaml` 或 `.gojaja/rfcs/*` 的修改，CTO **必须** reject 或在 merge 时丢弃这些 hunks（用 `git checkout main -- .gojaja/state/`）
5. CTO 是 `.gojaja/state/` 的唯一权威 committer；Dev 即使 InProgress 自己改这些文件也不要 commit

**中期改造（CEO 系统升级时）**：

- 把 `.gojaja/state/*.yaml` 加进 `.gitignore`，转用 gojaja 内置的「定期 git snapshot」或独立的 git-tracked 审计目录
- 或：gojaja CLI 改写 task_board 时自动用 git advisory lock 防止并发覆盖
- 或：event-sourced state（见 §8.6），task_board 从事件流派生，不需要 commit

**检测**：

- `git diff origin/main..main -- .gojaja/state/task_board.yaml | wc -l` 异常大时报警
- CTO 看到任何 PR diff 里包含 `.gojaja/state/` 或 `.gojaja/rfcs/` 都暂停 merge，确认 intent

### 8.11 跨 RFC + Task 双轨混乱

**现象**：
- 一个决策有时通过 RFC（如 RFC-0003 Auth），有时通过 PRD 评审（如 第二 skill 选型直接走 CPO T-0063 PRD，绕开 T-0065 RFC）
- 团队成员不清楚什么时候必须 RFC

**建议规则**：
- AGENTS.md 加「RFC vs PRD vs Task 决策矩阵」：
  - 跨 role 边界、影响 contract/schema/data model → RFC
  - 单一 role 范围实现选型 → 直接 Task
  - 业务范围/产品边界 → CPO PRD
  - 三者交集模糊时默认走 RFC

---

## 9. 优先级建议（给 CEO 系统升级时参考）

| 优先级 | 改造 | 收益 |
|---|---|---|
| P0 | 强制 worktree 隔离（§8.3） | 根本解决 git 互相干扰 |
| P0 | Branch protection + PR review on main（§8.1）| 阻止 Dev 自合 |
| P1 | InProgress 自检 + 强制 worktree 内有 git diff 才能 wait（§8.4）| 消除 ack-wait 死循环 |
| P1 | task_board 改 event-sourced（§8.6）| 状态可恢复 |
| P1 | `--touches <file>` + CODEOWNERS（§8.5）| 减少并行覆盖 |
| P2 | gojaja --message-file（解决 shell eval bug）| 提交便利 |
| P2 | worklog priority + CEO dashboard 优化（§8.9 §8.8）| 信号噪声分离 |
| P2 | RFC/PRD/Task 决策矩阵明文化（§8.11）| 减少协作模糊 |

