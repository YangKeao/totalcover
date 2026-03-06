# AGENTS.md

totalcover 代理执行规范。

## 覆盖率阶段

1. 自动发现（默认）
- 从目标 TiDB 仓库读取 `Makefile`、`tools/check/ut.go`、skills/AGENTS 说明。
- 自动选择官方测试入口：
  - UT: `make gotest_in_verify_ci`
  - E2E: `make integrationtest`

2. 并发与资源控制
- UT 阶段通过 `coverage.utMaxProcs` 设置 `GOMAXPROCS`，限制 `tools/bin/ut` 并发，避免资源打满。
- 覆盖率命令按阶段顺序执行（先 UT 后 E2E）。

3. 覆盖率输入要求
- 只接受真实测试执行生成的 profile（`.out`/`coverage.dat`）。
- 禁止 mock 覆盖率结果。

## 生成验证阶段

- 使用 `@openai/codex-sdk` 生成测试。
- 生成后必须执行 `go test <pkg> -run <TestName>`。
- 失败时带 stderr 重试修复（最多 `generation.maxRetries`）。
- 若测试暴露出潜在真实缺陷，可一并产出最小源码修复。
- 若包含源码修复，测试中必须加入注释说明修复的问题（回归测试注释）。
- 成功后必须做覆盖确认，确保目标未覆盖行被命中。

## 断点恢复

- 默认启用 checkpoint，路径为 `<runReportFile>.checkpoint.json`（可由 `output.checkpointFile` 覆盖）。
- 若收到 `SIGTERM/SIGINT`，应停止分发新任务并保存当前进度。
- 重启时同配置需自动恢复：
  - 复用 coverage profile（跳过已完成 coverage 阶段）
  - 复用 `scoredTasksFile`（跳过已完成打分阶段）
  - 仅继续剩余生成任务

## 启动

```bash
pnpm install
pnpm boost
```
