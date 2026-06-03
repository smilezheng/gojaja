# gojaja v3.0.0 手测指南（中文）

> 适用：本仓库 `main` HEAD（tag `v3.0.0`，commit `61fe26a` 之后）
> 目标读者：项目所有者（CEO / 维护者）。
> 总用时：~15-20 分钟全跑一遍。

这份文档带你**手动**走一遍 v3 的关键改动。脚本化测试已经
进过 CI（530/530 通过），这里覆盖**人工感官检查**的部分：
迁移、文件落地、SYSTEM 闸门、shell 安全、worktree 隔离、
reset 软删除。

---

## 0. 准备（一次性）

```bash
# 1. 切到仓库
cd /Users/zhengpeiwei/Documents/Codex/2026-05-26/codex-agent

# 2. 拉最新代码 + 装依赖 + 构建
git fetch && git checkout main && git pull
npm install
npm run build

# 3. 把本仓库 link 到全局，让 `gojaja` 走当前 dist
npm link
gojaja --version
# 期望：3.0.0
```

> 如果 `npm link` 因为权限报错，备选方案：直接用
> `node /Users/zhengpeiwei/Documents/Codex/2026-05-26/codex-agent/bin/gojaja`
> 替换下面所有 `gojaja` 调用。

```bash
# 4. 隔离一个干净的工作区，避免污染你真实的 ~/.gojaja/
export GOJAJA_HOME=/tmp/gojaja-smoke/home
rm -rf /tmp/gojaja-smoke
mkdir -p "$GOJAJA_HOME"
```

`GOJAJA_HOME` 让本次测试的中央树落在 `/tmp/gojaja-smoke/home/`
而不是你真实的 `~/.gojaja/`。**测完直接 `rm -rf /tmp/gojaja-smoke`
就清干净，不会留垃圾**。

```bash
# 5. 兜底：清掉任何残留的 session env var
unset GOJAJA_SESSION
```

---

## 1. 全新 v3 init（最快烟测）

```bash
# 建个空 git 项目
mkdir -p /tmp/gojaja-smoke/fresh && cd /tmp/gojaja-smoke/fresh
git init -q && git commit -q --allow-empty -m "initial"

# 跑 v3 init
gojaja init
```

期望：

- 标准输出含 `Initialised gojaja layer (v3.0.0)`，列出
  **project id** 和 **central root** 两行，central root 路径
  落在 `/tmp/gojaja-smoke/home/projects/<ULID>/`。
- 退出码 0。

**手工核验文件落点**：

```bash
# 用户树（git tracked）
ls -1 .gojaja/
# 期望恰好：VERSION, config.yaml, project.json, .gitignore,
#          roles/, state/

cat .gojaja/project.json
# 期望: {"id":"01JZ...","name":"fresh","schema":"3.0.0"}

cat .gojaja/VERSION
# 期望: 3.0.0

# 用户树里不应该出现任何 runtime 文件
ls .gojaja/state/
# 期望恰好：project_state.md
# （task_board.yaml 不在这里！它在中央树）
ls .gojaja/comms/ 2>/dev/null || echo "OK: 没有 comms 目录"
ls .gojaja/rfcs/ 2>/dev/null || echo "OK: 没有 rfcs 目录"

# 中央树（永远不在 git）
PROJECT_ID=$(jq -r .id .gojaja/project.json)
ls -1 $GOJAJA_HOME/projects/$PROJECT_ID/
# 期望含：state/, comms/, rfcs/, worklog/, locks/

cat $GOJAJA_HOME/projects/$PROJECT_ID/state/task_board.yaml
# 期望: schemaVersion: 3.0.0, nextId: 0, tasks: {}
```

**手工核验 git status 干净**：

```bash
git add -A && git status --short
# 期望只看到 .gojaja/{VERSION,project.json,config.yaml,.gitignore,roles/,state/project_state.md}
# 绝对不能看到 task_board.yaml / events / sessions 等
```

✅ 通过的话，**v3 的两树切分在 init 路径已经成立**。

---

## 2. 从 v2 迁移到 v3

这是最关键的一段。模拟一个老用户的 v2 项目，跑 `gojaja migrate`。

### 2.1 造一个 v2 项目

```bash
mkdir -p /tmp/gojaja-smoke/legacy && cd /tmp/gojaja-smoke/legacy
git init -q && git commit -q --allow-empty -m "initial"

# 手工写一个 v2 layer（无 project.json，VERSION 写 v2）
mkdir -p .gojaja/{state,comms/events,comms/sessions,comms/cursors,roles,rfcs,worklog,locks}
echo "2.0.0-manifest-filter" > .gojaja/VERSION
cat > .gojaja/config.yaml <<'EOF'
schemaVersion: 2.0.0-manifest-filter
roles:
  PM:
    title: PM
    description: ""
    owns:
      - state/task_board.yaml
    reportsTo: []
    mustNotEdit: []
nextRfcId: 0
EOF
cat > .gojaja/state/task_board.yaml <<'EOF'
schemaVersion: 2.0.0-manifest-filter
nextId: 1
tasks:
  T-0001:
    id: T-0001
    title: legacy task
    status: Ready
    owner: PM
    priority: P2
    dependsOn: []
    acceptance: ""
    createdAt: "2026-06-01T00:00:00Z"
    updatedAt: "2026-06-01T00:00:00Z"
    parent: null
    creator: SYSTEM
    assets: []
    deliverables: []
    tags: []
    reviewers: []
EOF
echo "# Project state\n\n## Vision\nTBD." > .gojaja/state/project_state.md
echo "" > .gojaja/roles/PM.md
# 写一个 ULID 命名的 event（用 base32 凑一个）
echo '{"id":"01JZ0000000000000000000001","ts":"2026-06-01T00:00:00Z","type":"WORKLOG","from":"PM","to":"*","payload":{"message":"legacy"}}' > .gojaja/comms/events/01JZ0000000000000000000001.json
```

### 2.2 Dry-run 预览

```bash
gojaja migrate
# 期望输出含：
#   Dry-run: migrate .../legacy/.gojaja
#   v2.0.0-manifest-filter -> v3.0.0
#   project id (new): 01J...
#   central root: /tmp/gojaja-smoke/home/projects/01J.../
#   files to copy: N (... bytes)
```

dry-run **不应该**写任何文件：

```bash
ls $GOJAJA_HOME/projects/ 2>/dev/null || echo "OK: 中央目录还没创建"
# 期望: OK
cat .gojaja/VERSION   # 仍是 2.0.0-manifest-filter
```

### 2.3 真正执行

```bash
gojaja migrate --execute
# 期望输出含：
#   Migrated .../legacy/.gojaja
#   v2.0.0-manifest-filter -> v3.0.0
#   files copied: N
#   User tree files NOT removed (safety net). Re-run with --cleanup ...
```

**验证迁移结果**：

```bash
cat .gojaja/VERSION
# 期望: 3.0.0

cat .gojaja/project.json
# 期望: {"id":"01J...","name":"legacy","schema":"3.0.0"}

PROJECT_ID=$(jq -r .id .gojaja/project.json)

# 中央树有完整内容
cat $GOJAJA_HOME/projects/$PROJECT_ID/state/task_board.yaml | grep "T-0001"
# 期望: 看到 T-0001 那条任务

ls $GOJAJA_HOME/projects/$PROJECT_ID/comms/events/
# 期望: 01JZ0000000000000000000001.json

# 安全网：v2 文件还在用户树
ls .gojaja/state/task_board.yaml   # 还在
ls .gojaja/comms/events/           # 还在
```

### 2.4 验证已迁移的项目能正常用

```bash
# plan 应该走中央树
gojaja plan PM
# 期望: 看到 T-0001 在 manifest 里
```

### 2.5 Cleanup（清理用户树残留）

```bash
gojaja migrate --execute --cleanup
# 期望:
#   <project>/.gojaja is already on v3 ...
#   或第一次执行时合并 cleanup
#   cleaned up: N files removed from user tree

# 验证 v2 残留没了
ls .gojaja/state/task_board.yaml 2>/dev/null || echo "OK: task_board.yaml 已搬走"
ls .gojaja/comms 2>/dev/null || echo "OK: comms 已搬走"

# 用户树只剩契约
ls -1 .gojaja/
# 期望: VERSION, config.yaml, project.json, roles/, state/
ls -1 .gojaja/state/
# 期望: project_state.md
```

### 2.6 幂等性

```bash
gojaja migrate --execute
# 期望: 报 already on v3，不动任何文件
```

✅ 全部通过 → **迁移路径走通了**。

---

## 3. SYSTEM-1：`--as-system` 闸门

```bash
cd /tmp/gojaja-smoke/fresh
unset GOJAJA_SESSION

# 3.1 不带 --as-system，应被拒
gojaja report --to PM --message "from owner"
# 期望: USAGE 错误，提示 "claim a role first" 或 "use --as-system"
echo "exit=$?"   # 期望 2

# 3.2 带 --as-system，应成功（但 PM 还没建，这一步要先建 PM）
gojaja role create PM "Product Manager" --owns "state/task_board.yaml" --as-system
# 期望: Created role 'PM' ...

# 3.3 现在 report
gojaja report --to PM --message "from owner" --as-system
# 期望: Reported ... from SYSTEM to PM

# 3.4 同样的 SYSTEM-1 闸门也覆盖 state edit
gojaja state edit --file state/project_state.md --content "Updated by owner" --as-system
# 期望: Wrote state/project_state.md ...

# 3.5 反例：state edit 不带 --as-system，应拒
gojaja state edit --file state/project_state.md --content "x"
# 期望: USAGE
```

---

## 4. SYSTEM-2：取证元数据

```bash
cd /tmp/gojaja-smoke/fresh
PROJECT_ID=$(jq -r .id .gojaja/project.json)

# 找最新一个 REPORT 事件查看 actorMeta
ls -t $GOJAJA_HOME/projects/$PROJECT_ID/comms/events/*.json | head -1 | xargs cat | jq .
# 期望: 顶层有 "actorMeta": {"pid":<number>,"ppid":<number>,
#          "cwd":"...","hostname":"...","user":"...","tty":"..."}
# pid 应等于当前 shell 启动 gojaja 时的 node 进程 pid（已经退出了，不用对验）。
# user 应是你的用户名。
# tty 应是 "(local)" 或 "(non-tty)" 或类似 /dev/ttys00X。
```

**反向验证**：建一个 role 用 session 跑 report，事件不应该带 actorMeta：

```bash
# 用 PM 的会话发 report
eval "$(gojaja claim PM --eval)"
gojaja report --to PM --message "from PM session"
gojaja release   # 用完释放

# 看最新事件
ls -t $GOJAJA_HOME/projects/$PROJECT_ID/comms/events/*.json | head -1 | xargs cat | jq .
# 期望: from=PM，没有 actorMeta 字段
unset GOJAJA_SESSION
```

---

## 5. SYSTEM-3：`role create / delete` 闸门 + 委托

```bash
cd /tmp/gojaja-smoke/fresh

# 5.1 不带 --as-system 的 role create 应拒
gojaja role create Backend "Backend"
# 期望: USAGE

# 5.2 委托模式：让 PM 拿到 config.yaml 的所有权
# （刚才 5.1 失败了，这里直接用 --as-system 改 PM 的 owns）
# 这里偷个懒——直接给 PM 加一个 config.yaml owns
gojaja role delete PM --as-system   # 先删
gojaja role create PM "Product Manager" --owns "state/task_board.yaml,config.yaml" --as-system

# 5.3 PM 现在能不带 --as-system 建新角色
eval "$(gojaja claim PM --eval)"
gojaja role create Backend "Backend Engineer"
# 期望: Created role 'Backend' (无 USAGE 错)

# 5.4 PM 也能删
gojaja role delete Backend
# 期望: Deleted role 'Backend'

# 5.5 普通角色（无 config.yaml owns）不能建/删
gojaja role create Worker "Worker" --as-system
eval "$(gojaja claim Worker --eval)"
gojaja role create Spy "Sneak"
# 期望: FORBIDDEN（exit 9）
gojaja role delete Worker
# 期望: FORBIDDEN
unset GOJAJA_SESSION
```

---

## 6. PR8u：多行文本安全

shell-eval 那个事故的逆向验证——含反引号的 heredoc 应被当字面量。

```bash
cd /tmp/gojaja-smoke/fresh
unset GOJAJA_SESSION

# 6.1 反引号在 --message - + 'EOF' heredoc 里是字面量
gojaja report --to PM --message - --as-system <<'EOF'
代码示例：
   `git push origin foo`
$(echo INJECTED)
EOF
# 期望: Reported ... 成功，且没有任何 git/echo 被执行
#       （不能输出 INJECTED；当前目录的 git 状态不能变）

# 6.2 验证 message 内容确实被原样保存
PROJECT_ID=$(jq -r .id .gojaja/project.json)
ls -t $GOJAJA_HOME/projects/$PROJECT_ID/comms/events/*.json | head -1 | xargs cat | jq -r .payload.message
# 期望: 输出含 `git push origin foo` 和 $(echo INJECTED) 字面量
```

**反例（**不要**真的跑！只看错误信息**）：

```bash
# 这个 OLD 写法会让 zsh 执行反引号 — 别在重要项目里跑
# gojaja report --to PM --as-system --message "$(echo will-exec)"
# 我们已经规劝你别这样写；v3 也不会让默认无 session 的 report 通过
```

---

## 7. Git worktree 共享中央树（postmortem §8.3 的根本修复）

```bash
cd /tmp/gojaja-smoke/fresh
git add -A && git commit -q -m "v3 init"

# 7.1 建第二个 worktree（go-dev 分支）
git worktree add ../fresh-go-dev -b go-dev 2>/dev/null
cd ../fresh-go-dev

# 7.2 验证两个 worktree 的 project.json 是同一个 ULID
cat .gojaja/project.json
diff .gojaja/project.json ../fresh/.gojaja/project.json
echo "exit=$?"   # 期望 0：完全一致

# 7.3 在 go-dev 这个 worktree 里发个 worklog
# 先让 PM 有个 session
eval "$(gojaja claim PM --eval)"
gojaja worklog --message "hello from go-dev worktree"
gojaja release

# 7.4 切回主 worktree，看 plan
cd ../fresh
gojaja plan PM
# 期望: 看到刚才在 go-dev 那个 worktree 发的 worklog
#       两个 worktree 共享同一个中央根，事件流自动汇总
```

✅ 通过 → **两个 worktree 在 git 层独立（不同分支），在 gojaja 层共享（同一 ULID）**。这是 v3 最大的协作红利。

---

## 8. `reset` + trash + purge

```bash
cd /tmp/gojaja-smoke/fresh
git worktree remove ../fresh-go-dev --force

# 8.1 预览
gojaja reset
# 期望: Reset preview ... 列出三类要删的东西，含 [central-tree-trash]
# 期望: 末尾给 --confirm <basename> 提示

# 8.2 真删（默认 = 移到 trash）
gojaja reset --confirm fresh
# 期望:
#   Reset complete at ...
#   ... [central-tree-trash]  with movedTo=$GOJAJA_HOME/trash/<id>-<ts>/

# 8.3 验证 trash 真的有
ls $GOJAJA_HOME/trash/
# 期望: 01J...-2026-06-03T...Z/  (一个目录)

ls $GOJAJA_HOME/trash/*/state/task_board.yaml
# 期望: 还在，能从这里恢复

# 8.4 用户树也没了
ls -la .gojaja 2>/dev/null || echo "OK: 用户树清空"

# 8.5 --purge 直接硬删（用 legacy 那个项目演示）
cd /tmp/gojaja-smoke/legacy
gojaja reset --confirm legacy --purge
ls $GOJAJA_HOME/projects/ 2>/dev/null | wc -l
# 期望: 比之前少了一条（legacy 那个 id 没了，也不在 trash 里）
```

---

## 9. 收尾

测完一切干净：

```bash
unset GOJAJA_SESSION
unset GOJAJA_HOME
rm -rf /tmp/gojaja-smoke

# 如果你前面 npm link 了，撤回：
cd /Users/zhengpeiwei/Documents/Codex/2026-05-26/codex-agent
npm unlink -g gojaja || true
```

---

## 10. 出问题怎么办

| 现象 | 可能原因 | 解 |
|---|---|---|
| `gojaja: command not found` | 没 link 成功 | 用绝对路径 `node /Users/.../codex-agent/bin/gojaja ...` |
| `Initialised v3.0.0` 但 central root 在 `~/.gojaja/` 而非 `$GOJAJA_HOME` | 没 export `GOJAJA_HOME` 到当前 shell | `export GOJAJA_HOME=/tmp/gojaja-smoke/home`，重跑 |
| `USAGE: GOJAJA_SESSION is not set, and --as-system was not passed` | 这是 SYSTEM-1 闸门在工作 | 加 `--as-system`，这是预期行为 |
| `Refusing to init: ...has uncommitted git changes` | init 拒绝脏 git | `git add -A && git commit` 或加 `--force` |
| 某个 jq 命令报 "command not found" | macOS 默认没 jq | `brew install jq` 或忽略那一行，看 raw JSON |
| 中央树某个目录权限报错 | 上次跑残留的 root 用户文件 | `sudo rm -rf /tmp/gojaja-smoke` |

---

## 11. 期望全部通过后

如果上面 1-8 都没失败：

- ✅ v3 init 把状态正确切两树
- ✅ v2 → v3 迁移幂等可回退
- ✅ SYSTEM 三道闸门生效
- ✅ shell 注入不再可能
- ✅ 多 worktree 自然共享中央树
- ✅ reset 不再一刀切

发布到 npm 安全。问我 `npm publish` 即可（我现在没主动发，等你下令）。

发现任何与本文档预期不符的现象都告诉我，我立刻定位。
