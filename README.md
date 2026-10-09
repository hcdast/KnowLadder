# 知阶 KnowLadder

知阶是融合 AI 的教学培训平台，连接课程、教学组织、学习任务、练习测验与反馈。仓库包含真实 API/Web 系统，以及独立的内存演示原型。

**本 README 只提供项目导航与本地启动速查，不维护独立进度表。** 当前实现、验收结果、风险和下一步统一见 [开发计划](docs/开发计划.md)。本地实现与验证不代表生产上线、真实模型质量或内容授权已获批准。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `server/` | NestJS API、MongoDB 迁移、受审计管理 CLI，以及独立业务 worker |
| `web/` | Vue 真实 Web，开发端口 `5174`，通过 `/api` 代理访问后端 |
| `prototype/` | 独立内存演示，开发端口 `5173`；不连接真实业务记录，不作为服务故障兜底 |
| `ops/` | 本地 MongoDB、PM2 启停及受控备份辅助工具 |
| `ecosystem.config.js` | PM2 后端进程配置；不启动 MongoDB、迁移、管理 CLI 或 Web |
| `docs/` | 产品、技术、交互与开发计划四份核心文档 |

## 环境要求

- **Node.js 22.19.0**：`server/`、`web/`、`prototype/` 已统一版本约束，根 `.nvmrc` 提供版本选择。
- npm：使用各目录的 `package-lock.json` 安装依赖。
- MongoDB：默认要求可写副本集，本地 Compose 使用 MongoDB 8.0。
- PM2：可选，用于管理后端进程。
- Docker Compose：可选，用于启动本地开发数据库。
- ClamAV、官方病毒库与安全私有存储：仅启用附件扫描时需要。

使用 nvm-windows 时：

```powershell
nvm install 22.19.0
nvm use 22.19.0
node -v
```

确认输出为 `v22.19.0`。如果设置了 `KL_NODE_BIN`，该路径也必须指向此版本。版本选择不会自动改变已有 PM2 应用的解释器。

Node 22 的本地验证与限制见 [开发计划修订82](docs/开发计划.md)：历史 Node 24 测试不能视为 Node 22 重跑，全套回归与 Linux 可选依赖兼容性仍有未解决项。

## 首次准备

以下命令均在仓库根目录执行，适用于获授权的本地环境，不是生产部署或任意数据库迁移许可。

### 1. 安装依赖并构建后端

```powershell
npm --prefix server ci
npm --prefix web ci
npm --prefix server run build
```

后端运行 `server/dist/` 构建产物，修改后端源码后需重新构建；不要手工修改 `dist/`。

### 2. 配置后端环境

仅在 `server/.env` 不存在时，从 [server/.env.example](server/.env.example) 复制创建，**不要覆盖已有配置**。

至少核对以下项目：

| 配置 | 本地运行要求 |
| --- | --- |
| `MONGODB_URI` | 指向实际 KnowLadder 数据库，核对库名、端口与副本集名称 |
| `APP_ORIGIN` | 默认 `http://127.0.0.1:5174`；浏览器访问地址须与此一致 |
| `PORT` | API 默认 `3000` |
| `ALLOW_INSECURE_HTTP` | 本机 HTTP 显式设为 `true`，不能沿用到生产 |
| `AUTH_RATE_LIMIT_KEY` | 自行生成至少32字节的随机密钥，不使用固定示例值 |
| `FILE_SCAN_ENABLED` | 不使用新附件上传时设为 `false` |

**当前模板的扫描开关行存在重复拼接**。复制后将该行改为合法值：

```dotenv
FILE_SCAN_ENABLED=false
```

不要保留 `falseFILE_SCAN_ENABLED=false`。`.env`、密码与密钥不得写入公开文档或提交到仓库。教学培训/AI等可选扩展开关保持模板默认关闭；启用前须遵循对应迁移与配置合同，见 [教学培训技术方案](docs/技术架构方案.md#ai-training-architecture)。

### 3. 准备 MongoDB

已有可用数据库时，直接配置其 URI，不需要再启动本地 MongoDB。

如果已安装 Docker Compose，且本机 `27017` 未被其他数据库占用，可使用仓库的开发配置：

```powershell
docker compose -f ops/compose.dev.yml up -d
```

该配置启动单节点副本集 `kl-dev`，绑定本机 `27017`，初始化副本集并通过 Docker volume 保存数据；**不会初始化 KnowLadder 业务 schema**。确认 `initialize` 服务成功退出后再检查业务迁移。

另一种本地验证方式是 `ops/mongo-local.cjs`：默认启动真实三节点副本集 `kl-local`，端口 `27117–27119`，要求 `KL_MONGO_DATA` 为仓库外绝对路径。它与 Compose 是替代方式，不需要同时运行；必须按工具输出配置 URI，不能混用 `kl-dev` 与 `kl-local`。

### 4. 检查并按授权初始化数据库

先只读检查目标库：

```powershell
npm --prefix server run migrate -- --inspect
```

首次空库初始化或受控升级时，先核对目标库、迁移合同和授权，并停止所有旧 API、worker、CLI及其他 writer，然后才执行：

```powershell
npm --prefix server run migrate
```

已就绪的数据库日常启动不需要重复迁移。不要删除已有数据库、手改迁移完成标记，或执行历史 UUID/v8/v9 初始化来绕过当前约束。初始化与升级边界见 [本地运行](docs/技术架构方案.md#local-runtime) 和 [ObjectId 初始化合同](docs/技术架构方案.md#object-id-implementation)。

## 日常启动

前提：MongoDB 已启动，环境配置正确，迁移已完成，后端已构建。

### 推荐：PM2 管理后端

未安装 PM2 时，先在所选 Node 22.19.0 环境中安装：

```powershell
npm install -g pm2
```

启动并检查后端：

```powershell
node ops/pm2-backend.cjs start
node ops/pm2-backend.cjs status
node ops/pm2-backend.cjs logs
```

另开终端启动真实 Web：

```powershell
npm --prefix web run dev
```

访问 **http://127.0.0.1:5174**。API 默认为 `http://127.0.0.1:3000`。

`ops/pm2-backend.cjs` 是 `ecosystem.config.js` 的封装，内部调用同一套 PM2 配置，不是另一组服务。不要同时使用两个启动入口，也不要在 PM2 运行时再手动启动同一 API/worker。封装的 `start`/`restart` 会先停止已有项目进程，可能产生短暂中断。

默认启动 `kl-api`、`kl-assessment-worker`、`kl-learning-worker`；启用扫描时另外启动 `kl-files-worker`。评分与学情投影依赖独立 worker，只启动 API 不等于完整学习闭环可用。

### 不使用 PM2

分别在四个终端执行一条命令：

```powershell
npm --prefix server run start
npm --prefix server run assessment:worker
npm --prefix server run learning:worker
npm --prefix web run dev
```

每条命令均持续运行，不是一次性批处理脚本。启用扫描并完成配置后，另开终端执行 `npm --prefix server run files:worker`。

### 停止与重启

```powershell
node ops/pm2-backend.cjs stop
node ops/pm2-backend.cjs restart
```

上述两条是按需选择的操作。`stop` 停止并删除项目固定 PM2 进程，不停止 MongoDB 或 Web；Web及手动启动的服务在各自终端按 `Ctrl+C`。

切换扫描开关或升级/迁移前，先停止后端再修改配置。不要仅依赖 `pm2 stop ecosystem.config.js`：关闭扫描后，旧文件 worker 可能已不在配置列表内，封装会处理这类旧进程。

## 健康检查与账号

启动后可在 PowerShell 中检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/live
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/ready
```

`live` 检查进程存活，`ready` 检查真实数据库与迁移就绪；就绪不能替代业务验收。非生产环境 OpenAPI 地址为 `http://127.0.0.1:3000/api/openapi.json`。

**无默认账号、内置密码或公开自注册。** 首位治理者通过受审计 CLI 引导，日常账号与授权通过真实 Web 管理台办理；临时密码首次登录须改密。账号与职责边界见 [管理权限方案](docs/技术架构方案.md#administration-design)。

### 当前开发库初始化账号

以下为当前开发库实际账号，不是程序内置的默认账号。2026-10-03按用户授权重置全部12个账号密码（含`admin`），账号、组织、角色和权限保持不变；旧会话已撤销。**可用临时密码仅保存在仓库外受保护的私密README及同名密码文件中，不写入本仓库。**

账号职责依据修订87核验记录整理；2026-10-05重新核对凭据状态：admin已完成改密，其余11个账号仍须首次改密。实际业务授权是否仍有效需逐请求服务端核验。六基础角色保留，业务职责由独立授权表达。12个账号覆盖初始化与验收场景，日常按实际人员开通，不要求每个岗位长期保留一个账号。

| 登录名 | 业务职责（基础角色） | 交付状态与待办 | 授权范围与期限 |
| --- | --- | --- | --- |
| `admin` | 平台治理（`platform_ops`） | 已有治理授权；2026-10-05核对已完成改密，旧临时密码失效 | 平台治理；无自动到期，不隐含业务读取 |
| `admin02` | 独立治理审批（`platform_ops`） | 已有治理授权；须由另一实际人员使用 | 平台治理；无自动到期 |
| `account_admin` | 平台账号管理（`platform_ops`） | 待授予`account:platform-manage`；按需启用 | 当前无账号管理授权，范围/期限待配置 |
| `school_admin` | 学校账号管理（`org_admin`） | 待授予`account:manage`；按需启用 | 初始化学校；管理授权尚未配置 |
| `teacher01` | 教学管理（`teacher`） | 已授予名册/指派/教学报告能力；授课关系待配置 | 初始化学校；班级/学科待配置；期限见下文 |
| `editor01` | 内容编辑（`content_editor`） | 角色派生编辑能力；不能自审 | 初始化学校；不因编辑身份获得学生报告权限 |
| `reviewer01` | 独立内容审核（`content_reviewer`） | 已有审核角色；不能审核本人创建内容 | 初始化学校；期限见下文 |
| `exam_manager` | 考试编排（`teacher`） | 已授予`assessment:manage` | 初始化学校；期限见下文 |
| `exam_reviewer` | 独立考试审核（`teacher`） | 已授予`assessment:review`；不得自审 | 初始化学校；期限见下文 |
| `report_reader` | 平台只读报告（`platform_ops`） | 待授予`report:read`；无独立人员需求时暂不启用 | 当前无报告授权，目标组织/期限待配置 |
| `student01` | 本人学习（`student`） | 班级/课程/学习任务待配置 | 初始化学校；仅本人合法学习资源 |
| `student02` | 本人学习及隔离验收（`student`） | 班级/课程/学习任务待配置 | 初始化学校；用于核验他人数据不可见 |

内容审核及显式教学/考试能力的初始化到期时间为**2026-10-31 22:10:39（北京时间）**，密码重置不会续期。具体教学能力为`teaching:roster`、`teaching:assign`、`teaching:report`；有效范围以服务端当前授权和授课关系为准。人员兼任与闲置账号处置见[账号精简原则](docs/技术架构方案.md#account-simplification)。

临时密码默认24小时有效。本批2026-10-05获授权单独延长一个自然月：11个仍需首次改密的账号到期时间为2026-11-05 10:53:25.366（北京时间，UTC为2026-11-05T02:53:25.366Z），原密码保留。admin已完成改密，旧临时密码不可用，不适用本批延期；系统默认有效期未改变。首次登录必须改密，改密后须重新登录；首次改密前不提供组织业务访问。延期不会延长内容审核/教学/考试授权期限，也不会创建班级、授课关系或学习数据。

本批12个账号均已完成真实HTTP登录、本人身份及退出验证；这不代表尚未授予的权限或业务任务已配置完成。凭据遗失/到期应走受审计`password-reset`流程，不使用固定共享密码。

## 附件与可选功能

- `FILE_SCAN_ENABLED=false` 时，新附件登记/上传关闭；扫描 worker 跳过扫描与周期维护，不会把未知结果标为 clean。
- 启用附件须配置 `FILE_STORAGE_ROOT`、`CLAMSCAN_PATH`、`CLAMAV_DATABASE`、`SCAN_DATABASE_MAX_AGE_HOURS`，并满足真实引擎、官方病毒库和私有目录安全检查。
- 关闭扫描不取消既有私有目录安全要求；显式文件维护命令仍受权限与数据库约束。
- 生产部署、AI供应商调用、隐私擦除、备份恢复不能由本 README 的启动命令自动获得授权。

## 常见启动问题

| 现象 | 先检查 |
| --- | --- |
| `EBADENGINE` 或 Node 版本不一致 | `node -v`、`KL_NODE_BIN` 以及启动终端的 Node 路径 |
| 缺少 `server/dist` 或无法解析扫描开关 | 先构建后端；核对 `FILE_SCAN_ENABLED` 是否为严格的 `true`/`false` |
| API 启动失败或 `ready` 不通过 | MongoDB 是否可写、URI 的库名/副本集、迁移状态与配置 |
| Web 能打开但 API 请求失败 | 默认代理指向 `3000`；更换 API 地址须设置 Web 的 `KL_WEB_API_TARGET` |
| 登录或写请求被拒绝 | 使用 `http://127.0.0.1:5174`，核对 `APP_ORIGIN`，不要随意改用 `localhost` |
| 新附件请求返回 `FILE_SCAN_DISABLED` | 扫描已明确关闭，不是上传成功；按附件前提配置后再受控启用 |
| `3000`/`5174` 被占用 | 检查是否已有 PM2 或手动服务，不要盲目结束其他项目进程 |

## 构建与独立演示

```powershell
npm --prefix server run build
npm --prefix web run build
```

只运行内存演示时：

```powershell
npm --prefix prototype ci
npm --prefix prototype run dev
```

访问 `http://127.0.0.1:5173`。演示数据不是实际教学记录，不能用于证明真实 API、持久化或权限能力。

## 核心文档

- [开发计划](docs/开发计划.md)：当前快照、任务、验证证据、风险与交接。
- [项目方案](docs/项目方案.md)：产品目标、范围与准入边界。
- [技术架构方案](docs/技术架构方案.md)：接口、数据库、安全与运行合同。
- [交互及 UI/UX 方案](docs/UIUX设计方案.md)：真实界面、交互规则与独立原型。

协作规则见仓库 `AGENTS.md`。项目许可见 [LICENSE](LICENSE)；项目许可不自动赋予第三方教材、题库、字体或素材使用权。
