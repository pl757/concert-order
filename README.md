# 演唱会下单工作台 — Render 版

客户在前台填单提交，你在后台实时看到，不需要付费。
价位只有 **内场 / 看台**，没有场馆字段。

## 订单统一分类（新增）

- 后台默认**按场次分组**：演唱会名大差不差归一类 + 同一场次归一类
- 归一化规则：去空格/标点/全半角、去年份（2024/2025/2026）、去“演唱会/巡回演唱会/巡演”等后缀；一个名字是另一个名字的前缀也算同一演唱会（例如“周杰伦”和“周杰伦嘉年华”同一场次归一组）；场次时间统一成 `YYYY-MM-DD HH:MM`，`2026/12/24 19:30` 和 `2026-12-24T19:30` 算同一场
- 不同场次会分开；每组显示单数、张数、合计金额、待处理数，可展开/收起，可一键复制本场汇总；也可以切到「全部列表」按时间看单
- 新订单提交时后端会算好 `groupKey`，老订单没有 `groupKey` 也会在后台按同一规则实时分组；导出 CSV 多了一列「分组」

## 正式版已包含

- **后台有密码**：打开 `/admin.html` 要输密码，密码在 Render 的环境变量 `ADMIN_PASSWORD` 里设置，部署时必须填，默认 `change-me-123456` 部署前必须改掉
- **订单不会丢**：订单存在持久磁盘 `/data/concert-order/orders.json`，重启、重新部署也不会丢
- **可以导出备份**：后台点「导出 CSV 备份」
- **防刷**：同一 IP 1 分钟最多下 20 单
- **实时同步**：后台用 SSE + 每 3 秒轮询兜底，新订单自动出现
- **一键复制**：前台填好后可复制场次日期 / 价位 / 姓名 / 身份证 / 电话，共五行；后台每单也能一键复制

## 文件说明

- `server.js`：后端，零依赖，会自动读 Render 给的 `PORT`
- `public/index.html`：前台，发给客户
- `public/admin.html`：后台，只给你自己，要密码
- `render.yaml`：Render 一键部署配置
- `package.json`：`npm start` 就能跑

## 部署到 Render（5 分钟）

### 方法一：一键 Blueprint（推荐）
1. 把这个文件夹传到 GitHub（新建仓库，把文件推上去）
2. 打开 render.com，注册登录 → New → **Blueprint** → 选你的仓库
3. Render 会读 `render.yaml` 自动创建服务和 1GB 持久磁盘，并提示你填 `ADMIN_PASSWORD`，填一个强密码，记好
4. 点 Apply，等部署完成，拿到地址，例如 `https://concert-order-xxxx.onrender.com`

### 方法二：手动建 Web Service
1. GitHub 同上
2. Render → New → **Web Service** → 选仓库
3. 设置：Environment `Node`，Build Command 留空，Start Command `node server.js`，Plan 选 **Starter（约 $7/月）**，不要选 Free
4. 环境变量：`ADMIN_PASSWORD` = 你的强密码，`DATA_DIR` = `/data/concert-order`
5. 左侧 Disks → Add Disk：Name `concert-data`，Mount Path `/data`，Size `1 GB`，保存后重新部署一次
6. 部署好拿到地址，例如 `https://concert-order-xxxx.onrender.com`

## 部署后测试

- 前台：`https://你的地址/`，手机或微信里点开，填一单提交
- 后台：`https://你的地址/admin.html`，输密码进去，看新订单是不是实时出现，并按场次分好组
- 健康检查：`https://你的地址/health`
- 没问题再把前台链接发给客户

## 平时维护

- **看日志**：Render 服务页 → Logs
- **重启**：服务页 → Manual Deploy → Deploy latest commit
- **备份订单**：后台点「导出 CSV 备份」，每周导一次
- **换密码**：Render → Environment → 改 `ADMIN_PASSWORD`，保存后重新部署

## 重要提醒

- **只发前台链接给客户**，不要发 `/admin.html`，更不要把后台密码发给客户
- Render 是海外服务器，微信里打开可能比国内云慢一点，正式用建议 Starter 套餐
- 身份证、电话是敏感信息，不要公开传播，定期导出备份后删除不需要的订单

## 本地先试

```bash
ADMIN_PASSWORD=你的密码 DATA_DIR=./data node server.js
```
前台 http://localhost:3000/ ，后台 http://localhost:3000/admin.html
