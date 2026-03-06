@YangKeao: 这个项目的代码由 codex 自己生成，与 YangKeao 完全无关。使用这一项目的正确方式是指挥 codex（或任何 agent）尝试理解并运行该项目，而非人工运行。

以下部分 README 也由 codex 完成。

---

# totalcover

基于 `@openai/codex-sdk` 的 TiDB 覆盖率自动补测平台。实现了真实仓库执行、真实测试、真实 coverage 解析，不使用 mock 数据。

## 核心能力

1. 覆盖率收集（自动发现 UT + E2E）
- 自动读取目标 TiDB 仓库的 `Makefile`、`tools/check/ut.go`、`.agents/skills/tidb-test-guidelines/SKILL.md`、`AGENTS.md`。
- 自动发现并执行官方测试入口，而不是手工填写命令。
- 当前内置 TiDB 自动流程：
  - UT: `make gotest_in_verify_ci`（等价于 `tools/bin/ut --coverprofile ...`）
  - E2E: `make integrationtest`（`tests/integrationtest/run-tests.sh` + `go tool covdata textfmt`）
- 自动收集 `.out` 与 `coverage.dat`。

2. 覆盖率解析
- 解析 Go coverprofile/`covdata textfmt` 输出。
- 提取在全部 profile 中都未覆盖的代码段。

3. AI 打分与过滤
- 按 package 并发调用 Codex。
- 使用全局统一 rubric（0-100）打分，确保跨 package 可比较。
- 过滤低价值防御分支。

4. 并行生成与闭环验证
- 并发生成测试。
- 执行 `go test <package> -run <TestName>`。
- 失败回传 stderr 给 Codex 修复，最多 3 次。
- 如果测试暴露出真实缺陷，可同时生成最小源码修复（search/replace patch）。
- 当包含修复时，要求测试内包含回归注释，说明修复了什么问题。
- 成功后再次跑带 `-coverprofile` 的确认测试，验证目标行被命中。

## 资源控制

TiDB UT 非常重。平台通过 `coverage.utMaxProcs` 控制 `tools/bin/ut` 的并发（通过设置 `GOMAXPROCS`）。

## 断点重启（支持 SIGTERM/SIGINT）

- 平台会维护 checkpoint 文件（默认：`<runReportFile>.checkpoint.json`）。
- 收到 `SIGTERM`/`SIGINT` 后，不再分发新任务，并在当前任务完成后落盘进度。
- 下次用同一份配置重新启动时，会自动：
  - 复用已完成的 coverage profile（跳过 UT/E2E）
  - 复用已完成的 AI 打分结果（`scoredTasksFile`）
  - 仅继续未完成的测试生成任务
- 可在配置中显式指定 checkpoint 路径：
  - `output.checkpointFile`
- checkpoint 中会持久化 Codex thread id；失败任务重试时可跨进程复用上下文。

## Codex 认证

`@openai/codex-sdk` 需要可用认证态：
- `OPENAI_API_KEY`，或
- `codex login` 登录态。

所以不是“必须手动填 key”，但必须存在有效认证。

## 一键启动

```bash
pnpm install
pnpm boost
```

## 配置（platform.config.json）

- `coverage.autoDetectTidbCommands`: 自动发现 TiDB UT/E2E 命令（默认 `true`）
- `coverage.runUnit`: 是否执行 UT 覆盖率阶段
- `coverage.runE2E`: 是否执行 E2E 覆盖率阶段
- `coverage.utMaxProcs`: UT 最大并发（通过 `GOMAXPROCS`）
- `coverage.profileGlobs`: 覆盖率文件匹配
- `generation.retryFailed`: 断点恢复时是否重试失败的生成结果（默认 `false`）
- `output.checkpointFile`: 可选，自定义断点文件路径

如果关闭自动发现，也可以手工配置 `coverage.unitCommands` / `coverage.e2eCommands`。

## 输出

- `artifacts/scored-tasks.json`
- `artifacts/run-report.json`
- `artifacts/run-report.json.checkpoint.json`（默认 checkpoint）
- `<repo>/.totalcover/*.out`
