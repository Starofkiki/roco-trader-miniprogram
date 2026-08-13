# 远行商人记录本

[![CI](https://github.com/Starofkiki/roco-trader-miniprogram/actions/workflows/ci.yml/badge.svg)](https://github.com/Starofkiki/roco-trader-miniprogram/actions/workflows/ci.yml)

面向《洛克王国：世界》玩家的非官方微信小程序，用于查看远行商人当前商品、历史记录和出现统计，并在关注商品出现后通过微信订阅消息尽量提醒玩家。

项目由个人维护，已在真实小程序环境中运行。它不是刷新预测工具，所有数据仅供参考，最终结果以游戏内显示为准。

## 主要功能

- 当前轮次商品查询与分组展示
- 历史日历、赛季统计和商品详情
- 关注商品与微信订阅消息提醒
- 公告、用户反馈和公开回复
- 云函数定时采集、幂等派发、失败重试与额度回退
- 商品目录生成、快照回退和独立影子压测

## 为什么开源

远行商人的商品按固定时段刷新，玩家容易错过想要的稀有商品。本项目把分散的实时数据整理成可查询的历史，并将关注与微信提醒组合成日常可用的社区工具。

公开仓库提供完整的小程序、云函数、目录生成器和回归测试，便于审查提醒可靠性、复用微信云开发方案，并让社区共同修正商品数据。生产用户记录、运营统计、订阅聚合数据和部署资源标识不会进入仓库。

## 技术结构

```text
pages/                       微信小程序页面
custom-tab-bar/              自定义底部导航
utils/                       商品、历史、缓存和云函数调用逻辑
cloudfunctions/rocoApi/      用户侧数据与提醒云函数
cloudfunctions/rocoAdminApi/ 管理与运维云函数
tools/catalog/               商品目录生成与回归测试
tools/simulations/           通知队列模拟测试
```

小程序使用微信云开发。商品数据由云函数获取并写入云数据库；当前轮次获取失败时使用历史或生成快照回退。提醒派发使用可恢复队列，按轮次和用户去重，并对临时失败进行有限重试。更多设计说明见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 本地开发

### 前置条件

- 微信开发者工具
- 已开通云开发的小程序账号
- Node.js 18 或更高版本

### 导入与配置

1. Fork 或克隆仓库。
2. 在微信开发者工具中导入项目目录。
3. 将 `project.config.json` 中的 `touristappid` 替换为你自己的小程序 AppID。
4. 在 `deployment.config.js` 填写自己的云环境、AppID、订阅模板和可选图片资源。
5. 按 [`cloudfunctions/README.md`](cloudfunctions/README.md) 创建数据库集合、配置环境变量并部署两个云函数。
6. 不要把密钥、openid、数据库导出、生产日志或用户统计提交到 Git。

`deployment.config.js` 只存放可公开的部署标识。微信 AppSecret、接口密钥、维护密钥和管理员 openid 必须通过云函数环境变量配置。

## 验证

运行完整语法检查、目录一致性检查和回归测试：

```powershell
npm test
```

商品源数据变化后，重新生成快照并验证：

```powershell
node tools/catalog/build-product-catalog.js
node tools/catalog/test-product-catalog.js
```

云端负载测试会产生数据库读写费用。请先运行本地模拟；确需云端验证时，使用独立的 `loadtest_*` 集合，禁止对真实用户批量试发。

## 参与贡献

欢迎提交问题、数据修正和小范围 Pull Request。开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，可贡献方向见 [`ROADMAP.md`](ROADMAP.md)。安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要在公开 Issue 中粘贴密钥或用户数据。

## 数据、隐私与第三方内容

- 仓库不提供生产数据库、用户 openid、订阅记录、运营统计或后台凭据。
- 示例标识和测试 openid 均为无效占位符，不对应真实用户或部署。
- 本项目为玩家社区工具，与腾讯、《洛克王国》及其项目组没有隶属或授权关系。
- 游戏名称、商标、角色、道具名称和相关图像的权利归其各自权利人所有；这些内容不因本仓库的代码许可证而获得再许可。

更多边界说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 开源许可

本项目源代码采用 [MIT License](LICENSE) 许可。第三方名称、商标、游戏素材、数据源内容及生产数据不在该许可范围内。
