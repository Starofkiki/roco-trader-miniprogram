# 云开发部署说明

仓库包含两个微信云函数：

- `rocoApi`：玩家端查询、关注、反馈、统计和提醒派发。
- `rocoAdminApi`：受管理员白名单保护的维护操作。

## 1. 创建数据库集合

建议将以下集合设置为“仅云函数可读写”：

```text
announcements
feedback
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
merchant_round_vote_summaries
merchant_history
merchant_history_bundles
merchant_product_stats_snapshots
product_catalog
product_catalog_meta
product_offers
share_image_assets
```

建议建立以下组合索引，字段顺序与排序方向应和查询一致：

- `announcements`: `kind + deleted + publishedAt + _id`
- `feedback`: `openid + createdAt + _id`
- `feedback`: `status + createdAt + _id`
- `notification_deliveries`: `roundKey + status`
- `notification_deliveries`: `roundKey + openid + status`
- `subscription_item_targets`: `enabled + itemKey`
- `subscription_item_targets_v2`: `enabled + itemKey`

## 2. 配置环境变量

在 `rocoApi` 配置：

```text
ROCOM_API_BASE_URL=https://wegame.shallow.ink
ROCOM_API_KEY=<remote-api-key>
ROCOM_TIMEOUT_MS=5000
WECHAT_APP_ID=<your-miniprogram-appid>
WECHAT_APP_SECRET=<your-app-secret>
WECHAT_SUBSCRIBE_TEMPLATE_ID=<template-id-1>
WECHAT_SUBSCRIBE_TEMPLATE_ID_2=<template-id-2>
WECHAT_SUBSCRIBE_TEMPLATE_ID_3=<template-id-3>
WECHAT_MINIPROGRAM_STATE=developer
MAINTENANCE_SECRET=<random-maintenance-secret>
ADMIN_OPENIDS=<comma-separated-openids>
```

正式发布时把 `WECHAT_MINIPROGRAM_STATE` 改为 `formal`。如模板字段与默认的 `thing1`、`time5`、`thing3` 不一致，可使用 `WECHAT_TEMPLATE_FIELD_*` 系列环境变量覆盖。

也可以用 `WECHAT_SUBSCRIBE_TEMPLATES_JSON` 一次配置三个模板。值必须是 JSON 数组，每项包含 `key`、`label`、`templateId`、`payloadMode` 和 `fields`。仓库不提供任何真实模板 ID。

`rocoAdminApi` 至少配置相同的 `MAINTENANCE_SECRET` 和 `ADMIN_OPENIDS`。密钥和 openid 不得写进源代码、配置文件、Issue 或日志样例。

## 3. 初始化商品目录

先在项目根目录生成并验证目录：

```powershell
node tools/catalog/build-product-catalog.js
node tools/catalog/test-product-catalog.js
```

部署 `rocoApi` 后，在云开发控制台调用一次：

```json
{
  "action": "admin.productCatalog.seed",
  "maintenanceSecret": "<your-maintenance-secret>",
  "confirmProductCatalogSeed": true
}
```

默认只补缺失文档。只有确认需要覆盖云端目录时才添加 `"overwriteExisting": true`。

## 4. 上传云函数和触发器

在微信开发者工具中分别右键以下目录，选择“上传并部署：云端安装依赖”：

```text
cloudfunctions/rocoApi
cloudfunctions/rocoAdminApi
```

`cloudfunctions/rocoApi/config.json` 定义了定时触发器。部署后检查云函数日志；若没有定时调用记录，再单独执行“上传触发器”。

## 5. 迁移与压力测试安全

- 任何回填、清理或覆盖动作都必须使用维护密钥，并先在开发环境验证。
- 本地优先运行 `node tools/simulations/notify-flow-sim.js`。
- 云端负载测试只允许写入 `loadtest_*` 集合并使用 mock sender。
- 禁止用真实用户做批量试发，禁止导出或提交 openid、订阅记录和通知日志。
- 迁移 v2 订阅模型时，依次使用 dual-write、回填、shadow-read、切读和停止旧写入；每一步都应可通过环境变量回退。

## 6. 发布小程序

云函数和触发器验证完成后，在微信开发者工具上传小程序代码，再到微信公众平台提交审核。首次发布前至少验证：当前轮查询、历史回退、关注保存、订阅授权、幂等派发、反馈权限和管理员白名单。
