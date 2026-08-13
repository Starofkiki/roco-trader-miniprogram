# 云开发部署说明

本项目现在使用云函数承接后端能力：

- 当前远行商人：`merchant.current`
- 首页聚合启动：`home.bootstrap`
- 历史记录：`merchant.history`
- 聚合历史记录：`merchant.historyBundle`
- 按轮次增量读取历史：`merchant.historyByKeys`
- 推荐统计：`merchant.stats`
- 轮次评价统计：`merchant.voteSummary`
- 提交轮次评价：`merchant.voteSubmit`
- 保存订阅：`subscribe.save`
- 查询剩余次数：`subscribe.status`
- 更新订阅商品：`subscribe.updateItems`
- 反馈提交：`feedback.submit`
- 查询我的反馈：`feedback.mine`
- 标记反馈回复已读：`feedback.markRead`
- 定时采集并推送：`merchant.notifyCurrent`
- 管理员强制同步当前轮次：`admin.forceSyncCurrent`
- 管理员人工写入与指定商品推送：`admin.manualCurrent.*`
- 公告历史列表：`announcement.list`
- 静态商品目录：`products.catalogV2`
- 商品统计快照：`products.statsSnapshots`
- 初始化商品目录：`admin.productCatalog.seed`
- 对照云存储商品 JSON：`admin.productCatalog.previewCloudJson`
- 本地运维后台：`rocoAdminApi`

## 1. 创建云数据库集合

在微信开发者工具的“云开发”控制台中创建以下集合，并建议设置为“仅云函数可读写”：

```text
users
subscriptions
subscription_targets
subscription_item_targets
subscription_profiles
subscription_item_targets_v2
subscription_quotas
notification_deliveries
merchant_round_jobs
merchant_round_votes
merchant_history
merchant_history_bundles
merchant_product_stats_snapshots
product_catalog
product_catalog_meta
product_offers
feedback
```

首次部署商品目录后，在云开发控制台调用一次 `rocoApi`：

```json
{
  "action": "admin.productCatalog.seed",
  "maintenanceSecret": "你的维护密钥",
  "confirmProductCatalogSeed": true
}
```

该动作使用仓库生成的统一快照初始化 `product_catalog`、`product_offers` 和目录元数据。重复执行默认只补缺失文档，不会覆盖云端已有说明或图片；确认需要用生成快照覆盖已有文档时，额外传入 `"overwriteExisting": true`。

商品图片迁移完成并重新部署 `rocoApi` 后，执行以下动作只同步商品图片字段，不覆盖商品介绍、报价或统计数据：

```json
{
  "action": "admin.productCatalog.syncImages",
  "maintenanceSecret": "你的维护密钥",
  "confirmProductImageSync": true
}
```

该动作会先补迁尚未写入映射的商品图；只有全部云文件校验成功后，才更新 `product_catalog` 的 `image_file_id` 和备用 `image_url`。

商品启停配置变化后，执行以下动作只同步 `status` 字段，不覆盖其他商品资料：

```json
{
  "action": "admin.productCatalog.syncStatuses",
  "maintenanceSecret": "你的维护密钥",
  "confirmProductStatusSync": true
}
```

如需先检查现有云存储商品 JSON，执行只读预览：

```json
{
  "action": "admin.productCatalog.previewCloudJson",
  "maintenanceSecret": "你的维护密钥",
  "cloudFileId": "cloud://你的商品-json-fileID"
}
```

预览只返回新增名称和字段冲突，不会写数据库。先根据报告合并源数据，再重新生成并初始化目录。

## 2. 配置云函数环境变量

在云函数 `rocoApi` 的环境变量中配置：

```json
{
  "ROCOM_API_BASE_URL": "https://wegame.shallow.ink",
  "ROCOM_API_KEY": "你的远程接口 key",
  "ROCOM_TIMEOUT_MS": "5000",
  "WECHAT_APP_ID": "wx665ff8ce8ec2a184",
  "WECHAT_APP_SECRET": "你的小程序密钥",
  "WECHAT_SUBSCRIBE_TEMPLATE_ID": "ZT-hSLIk-muFnlIZ-VACBoNpxKKGrGb31fsWn4XaGxY",
  "WECHAT_MINIPROGRAM_STATE": "formal",
  "WECHAT_TEMPLATE_FIELD_ITEM": "thing1",
  "WECHAT_TEMPLATE_FIELD_TIME": "time5",
  "WECHAT_TEMPLATE_FIELD_REMARK": "thing3",
  "MAINTENANCE_SECRET": "你的维护密钥",
  "ADMIN_OPENIDS": "openid_1,openid_2"
}
```

关注提醒使用 3 个共享次数池模板。客户端会一次请求三个模板，每个允许的模板增加 1 次；也可以使用一个 JSON 环境变量统一覆盖配置：

```json
{
  "WECHAT_SUBSCRIBE_TEMPLATES_JSON": "[{\"key\":\"merchant_primary\",\"label\":\"新商品上架提醒\",\"templateId\":\"ZT-hSLIk-muFnlIZ-VACBoNpxKKGrGb31fsWn4XaGxY\",\"payloadMode\":\"product_arrival\",\"fields\":{\"item\":\"thing1\",\"time\":\"time5\",\"remark\":\"thing3\"}},{\"key\":\"merchant_arrival\",\"label\":\"商品到货提醒\",\"templateId\":\"x1IzmXjI0iUa8d2AEou0bPm72oBDVXwCzara5zBwk0M\",\"payloadMode\":\"product_arrival\",\"fields\":{\"item\":\"thing1\",\"time\":\"time2\",\"remark\":\"thing3\"}},{\"key\":\"merchant_activity\",\"label\":\"活动进度提醒\",\"templateId\":\"y0kmCnjN496miwcs73YNlzY6Fi47LxCKhekWGCqb-og\",\"payloadMode\":\"activity_progress\",\"fields\":{\"item\":\"thing1\",\"time\":\"thing2\",\"remark\":\"thing3\"}}]"
}
```

`WECHAT_SUBSCRIBE_TEMPLATES_JSON` 会按模板槽位覆盖对应配置，未写出的槽位继续使用代码内置模板，旧的单模板 JSON 不会再隐藏另外两个模板。正式环境仍建议明确配置全部三个。`activity_progress` 仅用于远行商人商品提醒：活动名称显示商品名，活动进度显示到货时间与轮次，温馨提示显示剩余提醒次数；不用于公告或普通活动推送。

云函数 `rocoAdminApi` 也需要配置同一个 `MAINTENANCE_SECRET`，用于本地后台读取仪表盘数据、执行运维操作，以及在服务端安全转发小程序管理员的人工兜底动作。

同时在 `rocoAdminApi` 配置管理员 openid 白名单，多个 openid 使用英文逗号分隔：

```json
{
  "ADMIN_OPENIDS": "openid_1,openid_2"
}
```

小程序只会调用 `admin.status` 和专用的安全管理员接口，不会获取或传输 `MAINTENANCE_SECRET`。云数据库集合继续建议设置为“仅云函数可读写”。公告历史使用 `announcements` 集合中 `kind: "notice"` 的文档；反馈处理状态、公开回复、已读时间和管理员备注继续写入 `feedback` 集合，不需要新建集合。用户查询反馈时只使用云函数上下文中的 openid，公开接口不会返回 openid 或管理员备注。

公告、反馈列表已经使用数据库复合游标分页，每页最多读取 `pageSize + 1` 条。上线前在云开发控制台建立以下组合索引（排序字段均为降序，`_id` 作为同时间戳的稳定次序）：

- `announcements`: `kind + deleted + publishedAt + _id`
- `feedback`: `openid + createdAt + _id`
- `feedback`: `status + createdAt + _id`
- `notification_deliveries`: `roundKey + status`
- `notification_deliveries`: `roundKey + openid + status`
- `subscription_item_targets`: `enabled + itemKey`
- `subscription_item_targets_v2`: `enabled + itemKey`

`merchant.current` 和 `merchant.historyBundle` 现在严格只读。当前轮尚未由定时任务同步时，`merchant.current` 返回 `pending: true`，不会请求远端接口或写数据库；远端采集只能由定时任务、`admin.forceSyncCurrent` 和管理员人工同步触发。`home.bootstrap` 支持传入 `sections`（`merchant`、`announcement`、`subscription`、`vote`），客户端只请求已过期部分。

正式版使用 `formal`。如需在开发版或体验版调试订阅消息，可临时改为：

```json
{
  "WECHAT_MINIPROGRAM_STATE": "developer"
}
```

云函数可以直接通过 `cloud.getWXContext()` 获取 `openid`。`WECHAT_APP_ID` 和 `WECHAT_APP_SECRET` 用于 `cloud.openapi` access token 异常时的 HTTPS 发送兜底。

如需清零开发阶段测试人员的订阅、提醒额度、通知队列、派发索引、用户记录和反馈数据，请额外配置一个仅维护人员知道的 `MAINTENANCE_SECRET`，然后在云开发控制台调用云函数动作 `admin.resetTesterData`：

```json
{
  "action": "admin.resetTesterData",
  "maintenanceSecret": "你的维护密钥",
  "openids": ["测试人员 openid"]
}
```

该动作只会清理传入 `openids` 对应的数据，不会批量清空正式用户。

如需清空开发阶段的全部轮次评价投票历史，请继续使用维护密钥，并显式确认清空：

```json
{
  "action": "admin.clearRoundVotes",
  "maintenanceSecret": "你的维护密钥",
  "confirmClearAllVotes": true
}
```

该动作会清空 `merchant_round_votes` 和 `merchant_round_vote_summaries`。

`subscription_targets` 是订阅推送运行时索引，用户保存或更新关注商品时会自动同步。首次上线新派发队列、或确认索引损坏需要修复时，才需要手动执行一次派发索引回填。该动作只从现有 `subscriptions` 生成 `subscription_targets`，不会改动用户关注商品或剩余提醒次数：

```json
{
  "action": "admin.backfillSubscriptionTargets",
  "maintenanceSecret": "你的维护密钥",
  "batchLimit": 80
}
```

该动作是隐藏维护兜底，不作为仪表盘日常按钮展示。正常推送会直接读取已维护好的 `subscription_targets` 和 `subscription_item_targets`。如果返回 `hasMore: true`，继续调用并传入返回的 `nextCursor`：

```json
{
  "action": "admin.backfillSubscriptionTargets",
  "maintenanceSecret": "你的维护密钥",
  "batchLimit": 80,
  "cursor": "上次返回的 nextCursor"
}
```

第二阶段订阅模型迁移按以下顺序进行，任一步异常都可以关闭对应环境变量回到 v1：

1. 设置 `SUBSCRIPTION_V2_DUAL_WRITE=true`，保持 `SUBSCRIPTION_V2_READ=false` 和 `SUBSCRIPTION_V2_LEGACY_WRITE=true`。
2. 分批调用 `admin.backfillSubscriptionProfilesV2`；每次把返回的 `nextCursor` 传给下一批，直到 `hasMore=false`。
3. 设置 `SUBSCRIPTION_V2_SHADOW_READ=true` 观察 `[subscription-v2][shadow]` 日志，确认 v1/v2 候选数量和签名一致。
4. 设置 `SUBSCRIPTION_V2_READ=true` 切换读取；迁移观察期保留 `SUBSCRIPTION_V2_READ_FALLBACK=true`。
5. 稳定一个发布周期后设置 `SUBSCRIPTION_V2_READ_FALLBACK=false`，再设置 `SUBSCRIPTION_V2_LEGACY_WRITE=false` 停止旧集合写入。此时 v2 写入会自动保持启用。

回填调用示例：

```json
{
  "action": "admin.backfillSubscriptionProfilesV2",
  "maintenanceSecret": "你的维护密钥",
  "batchLimit": 80,
  "cursor": "上次返回的 nextCursor；首批留空"
}
```

`subscription_profiles/{openid}` 每个用户一条，`subscription_item_targets_v2/{itemKey_openid}` 每个用户与商品一条；三个模板的可用次数仍保留在 `subscription_quotas`，因此迁移不改变扣次、退款、拒收切换模板和失败重试语义。

首次上线历史聚合包、或确认聚合包损坏需要修复时，可以从现有 `merchant_history` 重建 `merchant_history_bundles`：

```json
{
  "action": "admin.backfillHistoryBundles",
  "maintenanceSecret": "你的维护密钥"
}
```

小程序历史页运行时优先读取 `merchant.historyBundle`，避免每个用户冷启动都读取最多 120 条历史文档。

首次上线商品统计快照时，在历史聚合包回填完成后执行：

```json
{
  "action": "admin.backfillProductStatsSnapshots",
  "maintenanceSecret": "你的维护密钥"
}
```

该动作会在 `merchant_product_stats_snapshots` 中生成 `rolling`、`season_s1`、`season_s2`、`season_s3` 四份快照。S1、S2回填后保持固定；后续每轮历史同步只更新滚动统计和S3快照。S1棱镜球会按已确认口径固定校正为2次。赛季快照结构或分类统计口径升级后，也应重新执行该动作以覆盖固定的S1、S2快照。

确认仪表盘和推送链路都已改读 `notification_deliveries` 后，可以清理旧通知审计集合：

```json
{
  "action": "admin.clearLegacyNotificationCollections",
  "maintenanceSecret": "你的维护密钥"
}
```

## 影子压测

大规模订阅压测请先使用独立测试集合，不要直接对真实用户试发。以下动作只写入 `loadtest_subscription_targets`、`loadtest_subscription_quotas`、`loadtest_notification_deliveries`、`loadtest_merchant_round_jobs`，发送阶段使用 mock sender，不会调用微信订阅消息接口，也不会修改正式用户的关注商品或剩余提醒次数。

压测会产生大量数据库读写，已从仪表盘日常运维按钮中隐藏。先运行本地模拟脚本，确实需要云端验证时，再在云开发控制台手动调用，并显式传 `confirmLoadTestCost: true`。例如 1000 人种子至少会写入约 2000 条测试记录，完整派发还会继续产生 delivery、quota、attempt/event 相关读写。

```json
{ "action": "admin.loadTest.seed", "maintenanceSecret": "你的维护密钥", "confirmLoadTestCost": true, "userCount": 1000 }
```

```json
{ "action": "admin.loadTest.runRound", "maintenanceSecret": "你的维护密钥", "confirmLoadTestCost": true, "timeoutRate": 0.05, "rejectRate": 0.01, "stuckRate": 0.02 }
```

```json
{ "action": "admin.loadTest.summary", "maintenanceSecret": "你的维护密钥" }
```

```json
{ "action": "admin.loadTest.cleanup", "maintenanceSecret": "你的维护密钥" }
```

`runRound` 可重复执行：单次云函数会在软预算内尽量清空队列，仍有 `pending`、`retryable_failed` 或过期 `sending` 时，再执行一次会从测试队列继续。压测通过后，再做 5-20 个真人 canary。

如需在自动调用窗口之后手动强制重新调取远端 API，并覆盖当前轮次历史记录，可在云开发控制台调用：

```json
{
  "action": "admin.forceSyncCurrent",
  "maintenanceSecret": "你的维护密钥",
  "notify": false
}
```

`notify` 默认为不推送。需要补发订阅消息时传 `true`，只会推送给已订阅且命中本轮商品、并且还有提醒额度的用户：

```json
{
  "action": "admin.forceSyncCurrent",
  "maintenanceSecret": "你的维护密钥",
  "notify": true
}
```

该动作只修复当前正在进行的轮次。例如 08:30 调用会修复第 1 轮；如果已经到 12:00 之后，远端 API 通常只能返回第 2 轮，不能再自动恢复第 1 轮。

## 3. 上传云函数

在微信开发者工具中，分别右键：

```text
cloudfunctions/rocoApi
cloudfunctions/rocoAdminApi
```

选择：

```text
上传并部署：云端安装依赖
```

商品源数据调整后，先在项目根目录执行：

```text
node tools/catalog/build-product-catalog.js
node tools/catalog/test-product-catalog.js
```

生成结果会同时写入小程序、`rocoApi` 和 `rocoAdminApi` 的故障回退快照。随后重新部署两个云函数并执行目录初始化动作。

`config.json` 中已经配置订阅消息开放接口权限和定时触发器。定时触发器会在每天 08:00、12:00、16:00、20:00 后的第 3、5、10 分钟各触发一次。第 3 分钟未拿到有效远端商品会等待第 5 分钟继续，第 10 分钟作为保底采集点。任一节点成功采集本轮商品后，会写入 `merchant_round_jobs.dispatchDeadlineAt`，并在后续 10 分钟窗口内分批派发 `notification_deliveries` 队列。

如果云函数日志里没有整点后第 3、5、10 分钟的自动调用记录，需要在微信开发者工具中右键 `cloudfunctions/rocoApi`，选择“上传触发器”。仅“上传并部署：云端安装依赖”有时不会把本地 `config.json` 里的定时触发器同步到云端。

## 4. 上传小程序

云函数上传成功后，再点击微信开发者工具右上角“上传”小程序代码，然后到微信公众平台提交审核/发布。
