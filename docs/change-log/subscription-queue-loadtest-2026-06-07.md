# 2026-06-07 订阅推送队列与压测复盘

## 背景

本次更新围绕订阅推送链路做了重构和压测准备，核心目标是让每轮远行商人刷新后，在云函数 60 秒限制下分批处理，最终能覆盖最多 5000 个订阅用户。同时保留用户已有关注商品和剩余提醒次数，避免为了测试触达真实用户。

## 主要更新

- 新增 `subscription_targets` 运行时索引集合。用户保存或更新关注商品时，会同步维护一条按 `openid|templateId` 聚合的订阅目标，用于后续推送快速扫描。
- `notification_deliveries` 成为推送状态主表，同一用户、同一模板、同一轮次按 delivery 去重，并在内嵌 `attempts/events` 中记录尝试、错误、扣次和退回情况。
- 每条 delivery 最多进行 2 次实际发送尝试。发送前先扣 1 次，发送成功确认状态；临时失败会退回该次扣除；43101/拒收会标记用户额度为 `wechatRejected` 并归零。
- 定时触发保持每轮第 3、5、10 分钟。第 3 分钟未拿到有效远端商品则等待，第 5 分钟继续，第 10 分钟保底；成功采集后写入 10 分钟派发窗口。
- 可选收尾账号通过 `NOTIFY_LAST_RECIPIENT_OPENID` 环境变量配置，只在命中订阅且有次数时进入队列，并在普通用户 pending/retryable/sending 清空后再处理。文档和代码仓库不保存真实 openid。
- 仪表盘改读 `notification_deliveries` 汇总状态，增加补发本轮待处理、补记扣次、补退次数、清理旧通知表等运维能力。

## 压测与成本控制

- 新增云端影子压测能力，使用 `loadtest_*` 独立集合和 mock sender，不调用微信真实订阅消息接口，不修改真实用户集合。
- 压测支持全成功、临时超时、43101 拒收、stuck sending、收尾账号等场景，并复用生产队列的物化、claim、扣次、退回和最多两次尝试规则。
- 发现 1000 人压测对数据库调用消耗明显：一次 seed 至少约 2000 条测试写入，runRound 还会继续产生 delivery、quota、attempt/event 等读写。
- 为避免误点烧调用次数，已从仪表盘日常运维区移除压测按钮。
- `admin.loadTest.seed` 和 `admin.loadTest.runRound` 现在必须显式传 `confirmLoadTestCost: true` 才会执行；`summary/cleanup` 保留为低频维护动作。

## 线上问题与处理

- `subscription_targets` 首次回填时报 `database collection not exists`。原因是云数据库还没有新集合。已在云函数写入工具中增加缺集合容错：写入时遇到集合不存在会尝试创建集合后重试；读取或清理不存在集合时按空集合处理。
- 回填索引时报 `Invoking task timed out after 3 seconds`。实际数据已经写入，问题来自调用链等待超时，而不是索引失败。已给本地仪表盘调用 `rocoAdminApi`、以及 `rocoAdminApi -> rocoApi` 的 `cloud.callFunction` 都显式加 `timeout: 60000`。
- 压测 seed 报 `ResourceExist Table exist`。原因是 1000 人并发写入时多个 worker 同时尝试创建同一个 `loadtest_*` 集合。已把 `ResourceExist/Table exist` 视为集合已存在，并用 `ensuringCollections` 复用同一集合的创建 Promise，避免并发抢建报错。
- `backfillSubscriptionTargets` 已保留为隐藏维护兜底，不再作为仪表盘日常按钮展示。当前 `subscription_targets` 已完整，后续由用户保存/更新订阅自动维护。

## 当前数据核验

只读统计云端数据后，当前订阅索引状态为：

```json
{
  "subscription_targets": {
    "total": 174,
    "enabled": 174,
    "emptyEnabledTargets": 0
  },
  "subscriptions": {
    "total": 962,
    "enabled": 911,
    "enabledOpenidTemplateGroups": 174,
    "missingTargetGroups": 0
  },
  "subscription_quotas": {
    "total": 178
  }
}
```

结论：启用订阅按 `openid|templateId` 聚合后为 174 组，`subscription_targets` 启用记录也是 174 条，缺失为 0。

## 验证

已执行以下检查：

```text
node --check cloudfunctions\rocoApi\index.js
node --check cloudfunctions\rocoAdminApi\dashboardService.js
node --check cloudfunctions\rocoAdminApi\operationService.js
node --check tools\admin-dashboard\server.js
node --check tools\admin-dashboard\public\app.js
node tools\simulations\notify-flow-sim.js
```

模拟测试覆盖：

- 第 3 分钟失败、第 5 分钟成功后，从第 5 分钟起算 10 分钟派发窗口。
- 第 10 分钟保底采集后，同样进入独立 10 分钟派发窗口。
- 5000 用户分页物化和分批派发。
- 临时失败退回次数，第二次发送重新扣次，同一轮最多两次。
- 收尾账号在普通队列清空后才发送。
- 1000 人影子压测全成功、5% 超时、1% 拒收、stuck sending 场景。

## 部署与后续注意

- 需要重新部署 `rocoApi` 和 `rocoAdminApi`，确保云端拿到最新代码和 60 秒调用等待。
- 云开发控制台里确认两个云函数超时时间为 60 秒。
- `subscription_targets` 不应删除，它是后续生产推送的运行时索引。
- `backfillSubscriptionTargets` 和 `admin.loadTest.*` 都是隐藏维护动作，不应作为日常按钮暴露。
- 大规模真实用户试发仍不建议进行；云端影子压测通过后，只做 5-20 个真人 canary。
