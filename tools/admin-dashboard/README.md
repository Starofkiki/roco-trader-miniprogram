# ROCO 本地运维仪表盘

这个工具只在本机运行。浏览器访问本地 Node 代理，代理再调用独立云函数 `rocoAdminApi`。

## 特性

- 页面打开只读取 `cache/summary.json`，不会自动调用云函数。
- 自动云端刷新只在北京时间 `08:15 / 12:15 / 16:15 / 20:15` 执行。
- 强制拉云端、拉取轮次详情、运维操作都需要二次确认。
- 云环境密钥和维护密钥只放在本机 `.env`，不会进入前端页面。

## 准备

先部署云函数：

```text
cloudfunctions/rocoAdminApi
```

云函数 `rocoAdminApi` 需要配置和 `rocoApi` 相同的 `MAINTENANCE_SECRET`。

然后复制本地配置：

```powershell
Copy-Item .env.example .env
```

填写：

```text
TCB_ENV_ID=云开发环境 ID
TENCENTCLOUD_SECRET_ID=腾讯云 SecretId
TENCENTCLOUD_SECRET_KEY=腾讯云 SecretKey
ROCO_MAINTENANCE_SECRET=云函数 MAINTENANCE_SECRET
DASHBOARD_PASSWORD=本地后台登录密码
PORT=8787
```

## 启动

```powershell
npm install
npm start
```

打开：

```text
http://127.0.0.1:8787
```

## 低频调用规则

- 服务器启动时不会立刻调用云函数。
- 页面刷新不会调用云函数。
- 自动刷新只在四个固定时间点执行。
- “强制拉云端”和“拉取详情云端”会立即调用云函数，需要弹窗确认。

## 运维操作

页面中的强制同步、同步并推送、补发当前轮、重置测试数据都会调用云函数，执行前会二次确认。
