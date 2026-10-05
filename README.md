# Huntington–Hill 席位分摊与优先级解释后端

离线运行的席位分摊演示服务：给定多个地区的人口与固定总席位数，使用
**Huntington–Hill 等比例法（method of equal proportions）** 逐席分配，并完整记录
每一轮参与比较的**精确优先级量**。仅用于虚构数据的算法演示，不涉及真实选票、
候选人排序或选举认证。

- 运行时：Node.js（内置 `node:sqlite`，无需任何原生模块）+ TypeScript
- 形态：只有 HTTP API 与命令行（CLI），无前端、无 Docker、无 WSL、无外部在线服务
- 平台：Windows 本地可直接运行

## 算法说明

1. 每个地区先获得 **1 个基础席位**（本题强制每地至少一席）。
2. 剩余席位逐个分配。某地区已有 `n` 席时，其下一优先级为

   `优先级 = population / sqrt(n * (n+1))`

3. 每轮选出当前优先级最高的地区，给它加一席；获席后只更新该地区的下一优先级，
   其余地区不变。**不是**先按人口比例四舍五入再补差，也**不是**始终按人口大小排序。
4. **平局**按地区编号的固定顺序处理：编号按 Unicode 码点字典序排序，
   排在前的地区获席。输入顺序不会成为隐藏的平局条件，结果可复现。
5. **精确比较**：比较两个正优先级等价于比较其平方分数。
   对 `a = P1/sqrt(n1(n1+1))` 与 `b = P2/sqrt(n2(n2+1))`，比较交叉乘积
   `P1² · n2(n2+1)` 与 `P2² · n1(n1+1)`，全程使用 **BigInt**，
   巨大人口或近似平局不会被浮点误差颠倒。小数近似只用于展示，绝不参与实际选择。

每轮记录包含：获席地区、分配前后席位数、获胜者精确量（`numeratorSq/denominator`）、
本轮全部候选地区及其精确量，因此可查看任意地区“下一席”的候选优先级及与获胜者的关系
（`winner` / `equal` / `below`）。

### 范围限制（按题意）

- 总席位不能少于地区数；**不支持最低席位例外**（不能靠丢弃小地区满足更少总席位）。
- 不支持多层分配，也不提供与其他选举制度的并排比较。
- 比较报告只说明**新增席位去向**与各地区**人口每席**；不声称任何比例指标最优，
  也不保证满足其他分摊方法的配额公理（Huntington–Hill 本身不满足配额公理）。

## 参数与上限

| 配置（环境变量） | 默认值 | 含义 |
| --- | --- | --- |
| `HH_MAX_REGIONS` | `1000` | 单次人口版本最多地区数 |
| `HH_MAX_POPULATION_DIGITS` | `39` | 人口十进制位数上限 |
| `HH_MAX_TOTAL_SEATS` | `100000` | 总席位上限（分配前校验预算） |
| `HH_PORT` | 不设置则自动选择空闲端口 | HTTP 端口 |
| `HH_DATA_DIR` / `HH_DB_PATH` | `data` / `data/hh.sqlite` | 项目内数据目录与 SQLite 文件 |

人口以**十进制整数字符串**交换（如 `"6000"`）。以下输入一律明确拒绝并返回错误码：
重复编号、零人口、负数、小数、前导零、非字符串数字、空编号、非整数席位、
总席位低于地区数、总席位或地区数超上限。

## 数据持久化

SQLite 保存**冻结人口版本**、总席位、规则版本（`huntington-hill:2025-10`）、
最终分配与每轮获席记录：

- 修改人口会创建**独立版本与分析**，不覆盖旧分配。
- 读取旧分析时从冻结快照**重放**算法，用重放结果逐轮核对持久化记录，
  并核对席位总数与“每地至少一席”；不一致返回 `REPLAY_MISMATCH`。
  因此重启后能够从旧快照回放原记录。
- 分析写入在单个数据库事务中完成，中途失败整体回滚。
- 同一版本 + 总席位 + 规则版本重复提交是幂等的，返回既有分析（`reused: true`）。

## 快速开始

需要 Node.js ≥ 22.5（开发与验证使用 Node.js 25）。

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm run demo       # 内置演示：不同人口 + 相同人口平局 + 总席位比较
npm test           # 编译并运行全部测试（node:test）
npm start          # 启动 HTTP API（默认自动选空闲端口；HH_PORT 可固定）
```

## CLI

```powershell
# 校验并冻结人口版本（PowerShell 下建议用 --file，避免引号转义问题）
node dist/cli.js validate --file examples/regions.json

# 执行分摊，显示席位表与前 5 轮逐轮精确优先级
node dist/cli.js run <versionId> <totalSeats> --rounds 5

# 重启后查看旧分析（内部从快照重放核对）
node dist/cli.js show <analysisId> --rounds 5

# 全部逐轮记录
node dist/cli.js rounds <analysisId>

# 查看某地区在某轮的候选优先级及与获胜者关系
node dist/cli.js candidate <analysisId> <round> <code>

# 比较两个总席位数 / 导出 CSV 或 JSON
node dist/cli.js compare <analysisA> <analysisB>
node dist/cli.js export <analysisId> --format csv

# 单独启动 API（也可用 npm start）
node dist/cli.js serve --port 7070
```

`--db <路径>` 可指定 SQLite 文件，默认 `data/hh.sqlite`（演示用 `data/demo.sqlite`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查与规则版本 |
| `GET` | `/limits` | 当前地区数 / 人口位数 / 总席位上限 |
| `POST` | `/versions` | 校验并创建冻结人口版本，体：`{"regions":[{"code,"population"}]}` |
| `GET` | `/versions` `/versions/:id` | 列出 / 查看冻结版本 |
| `POST` | `/versions/:id/analyses` | 执行分摊，体：`{"totalSeats":10}`；重复提交返回 `200 + reused` |
| `GET` | `/analyses?versionId=` | 列出分析 |
| `GET` | `/analyses/:id?round=N&code=C` | 地区结果 + 逐轮记录（可带候选视角） |
| `GET` | `/analyses/:id/rounds/:n/candidates/:code` | 指定地区在第 n 轮的候选优先级与关系 |
| `GET` | `/analyses/:id/export?format=csv|json` | 导出（默认 CSV） |
| `GET` | `/compare?a=<id>&b=<id>` | 比较两个总席位（须同一人口版本） |

错误响应统一为 `{"error":{"code","message","details"}}`，HTTP 状态码：
校验类 `400`，不存在 `404`，冲突/回放不一致 `409`，内部错误 `500`。

错误码：`REGION_EMPTY`、`REGION_CODE_DUPLICATE`、`POPULATION_NOT_POSITIVE_INTEGER`、
`POPULATION_TOO_MANY_DIGITS`、`TOO_MANY_REGIONS`、`SEATS_NOT_INTEGER`、
`SEATS_BELOW_REGION_COUNT`、`SEATS_ABOVE_LIMIT`、`INVALID_REQUEST`、`NOT_FOUND`、
`CONFLICT`、`REPLAY_MISMATCH`、`INTERNAL`。

### curl 示例（PowerShell 7）

```powershell
curl.exe -X POST http://127.0.0.1:7070/versions `
  -H "content-type: application/json" `
  --data '@examples/regions.json'

curl.exe -X POST http://127.0.0.1:7070/versions/1/analyses `
  -H "content-type: application/json" `
  -d '{\"totalSeats\":10}'

curl.exe "http://127.0.0.1:7070/analyses/1?round=1&code=WEST"
curl.exe "http://127.0.0.1:7070/compare?a=1&b=2"
curl.exe "http://127.0.0.1:7070/analyses/1/export"
```

## 手算样例

人口 `NORTH=6000, SOUTH=3000, WEST=1000`，总席位 10（先各 1 席，再分 7 席）：

| 轮次 | 获胜者 | 依据（获胜前优先级） |
| --- | --- | --- |
| 1 | NORTH | 6000/√2 ≈ 4242.64 |
| 2 | NORTH | 6000/√6 ≈ 2449.49 > 3000/√2 ≈ 2121.32 |
| 3 | SOUTH | 3000/√2 ≈ 2121.32 > 6000/√12 ≈ 1732.05 |
| 4 | NORTH | 6000/√12 ≈ 1732.05 |
| 5 | NORTH | 6000/√20 ≈ 1341.64 > 3000/√6 ≈ 1224.74 |
| 6 | SOUTH | 3000/√6 ≈ 1224.74 > 6000/√30 ≈ 1095.45 |
| 7 | NORTH | 6000/√30 ≈ 1095.45 |

最终 **NORTH 6、SOUTH 3、WEST 1**，三地人口每席恰为 1000。
相同人口（如 A=B=C=1000，总席位 5）时第 1、2 轮精确平局，按字典序 A、B 获席，
结果 A=2、B=2、C=1。

## 测试覆盖

`test/` 使用内置 `node:test`，共 28 个用例，覆盖：

- 总席位恰好等于地区数、单地区、大整数人口（38 位）近似平局；
- 重复提交幂等、上限拒绝、全部非法输入错误码；
- 小样例逐轮手算，并用**每轮独立全量扫描**的独立参考实现核对多组数据；
- 人口统一乘正整数、输入重排均不改变结果；
- 总席位加一时只有一个地区 +1 且无地区减席（单调性）；
- 事务失败回滚无残留、关闭后重开数据库的快照回放、完整 HTTP API 流程。

## 项目结构

```
src/
  config.ts     上限、数据目录、规则版本（均可由环境变量覆盖）
  errors.ts     错误码与 HTTP 状态映射
  types.ts      数据类型
  priority.ts   输入校验、BigInt 精确比较、每轮全量扫描选获胜者
  engine.ts     Huntington–Hill 分配、发布核对、快照重放
  store.ts      SQLite 建表、事务、冻结版本、逐轮记录
  compare.ts    两个总席位数比较报告
  service.ts    业务编排
  serialize.ts  API/CSV 序列化
  server.ts     纯 Node http 的 API（默认选空闲端口）
  cli.ts        命令行与内置演示
test/           单元 / 持久化 / HTTP 测试
examples/      示例输入
scripts/       API 冒烟脚本
```

## 已知假设与限制

- 平局固定使用地区编号的 Unicode 字典序（题意要求固定顺序）。
- 人口上限默认 39 位，足以容纳任意现实量级；可通过环境变量调整，BigInt 本身无精度上限。
- 本服务只做后端；不提供网页界面、鉴权与多用户并发控制（本地离线演示用途）。
- `node:sqlite` 在当前 Node 版本带实验性标记，启动命令已统一加 `--no-warnings`。
