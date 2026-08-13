# 远行商人记录本

[![CI](https://github.com/Starofkiki/roco-trader-miniprogram/actions/workflows/ci.yml/badge.svg)](https://github.com/Starofkiki/roco-trader-miniprogram/actions/workflows/ci.yml)

面向《洛克王国：世界》玩家的非官方微信小程序，用于查看远行商人当前商品、历史记录和出现统计，并在关注商品出现后通过微信订阅消息尽量提醒玩家。

项目由个人维护，已经作为真实小程序运行。它不是刷新预测工具，所有数据仅供参考，最终结果以游戏内显示为准。

## 主要功能

- 当前轮次商品查询与分组展示
- 历史日历、赛季统计和商品详情
- 关注商品与微信订阅消息提醒
- 公告、用户反馈和公开回复
- 云函数定时采集、幂等派发、失败重试与额度回退
- 商品目录生成、快照回退和独立影子压测
- 仅维护者本地使用的管理面板

## 项目价值

远行商人的商品按固定时段刷新，玩家容易错过想要的稀有商品。本项目把分散的实时数据整理成可查询的历史，并将关注与微信提醒组合成一个日常可用的社区工具。

截至 2026 年 6 月，项目曾记录单日约 100 名用户使用，提醒系统已有 174 组启用订阅索引。相关记录见：

- [`docs/social-media-metrics-updated.csv`](docs/social-media-metrics-updated.csv)
- [`docs/change-log/subscription-queue-loadtest-2026-06-07.md`](docs/change-log/subscription-queue-loadtest-2026-06-07.md)

这些数字仅用于说明项目存在真实使用场景，不包含用户身份信息。

## 技术结构

```text
pages/                       微信小程序页面
custom-tab-bar/              自定义底部导航
utils/                       商品、历史、缓存和云函数调用逻辑
cloudfunctions/rocoApi/      用户侧数据与提醒云函数
cloudfunctions/rocoAdminApi/ 管理与运维云函数
tools/catalog/               商品目录生成与回归测试
tools/simulations/           通知队列模拟测试
tools/admin-dashboard/       维护者本地管理面板
```

小程序使用微信云开发。商品数据由云函数获取并写入云数据库；当前轮次获取失败时使用历史或生成快照回退。提醒派发使用可恢复队列，按轮次和用户去重，并对临时失败进行有限重试。

## 本地开发

### 前置条件

- 微信开发者工具
- 已开通云开发的小程序账号
- Node.js 18 或更高版本（运行本地脚本和管理面板）

### 导入与配置

1. Fork 或克隆仓库。
2. 在微信开发者工具中导入项目目录。
3. 将 `project.config.json` 中的 `appid` 改为你自己的小程序 AppID。
4. 将 `app.js` 中的云环境 ID、AppID 和订阅模板 ID 改为你自己的配置。
5. 按 [`cloudfunctions/README.md`](cloudfunctions/README.md) 创建数据库集合、配置环境变量并部署两个云函数。
6. 不要把密钥、openid、数据库导出或生产日志提交到 Git。

仓库中的环境标识和模板 ID 不是密钥，但只适用于原维护者的部署。微信 AppSecret、腾讯云 SecretKey、维护密钥和管理密码必须通过环境变量或本地 `.env` 配置。

## 验证

完整语法检查和回归测试可以通过统一入口运行：

```powershell
npm test
```

也可以单独运行某个回归脚本：

```powershell
node tools/catalog/test-product-catalog.js
node tools/catalog/test-product-detail-render.js
node tools/catalog/test-product-history-stats.js
node tools/catalog/test-product-list-page.js
node tools/catalog/test-product-stats-snapshots.js
node tools/catalog/test-stats-history-sync.js
node tools/simulations/notify-flow-sim.js
node tools/test-cloud-io-optimizations.js
node tools/test-feedback-replies.js
```

云端负载测试会产生数据库读写费用。请先运行本地模拟测试；确需云端验证时，使用独立的 `loadtest_*` 集合，禁止对真实用户批量试发。

## 参与贡献

欢迎提交问题、文档修正和小范围 Pull Request。开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要在公开 Issue 中粘贴密钥或用户数据。

## 数据、隐私与第三方内容

- 仓库不提供生产数据库、用户 openid、订阅记录或后台凭据。
- `docs` 中的使用量数字为人工记录的聚合值，不用于用户画像。
- 本项目为玩家社区工具，与腾讯、《洛克王国》及其项目组没有隶属或授权关系。
- 游戏名称、商标、角色、道具名称和相关图像的权利归其各自权利人所有；这些内容不因本仓库的代码许可证而获得再许可。

更多边界说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 开源许可

本项目源代码采用 [MIT License](LICENSE) 许可。第三方名称、商标、游戏素材、数据源内容及生产数据不在该许可范围内。
