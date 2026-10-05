# Huntington–Hill 席位分摊本地后端

这是一个只包含 API 与 CLI 的离线 TypeScript/Node.js/SQLite 示例服务，用于虚构人口数据的算法演示。它不连接外部在线 API，不需要 Docker、WSL 或付费服务。

## 方法

每个地区先获得 1 个基础席位，再为剩余每一席选择当前优先级最高的地区。地区已有 `n` 席时：

```text
priority = population / sqrt(n * (n + 1))
```

程序不计算浮点平方根，而比较优先级平方：

```text
populationA² / (nA * (nA + 1))  对  populationB² / (nB * (nB + 1))
```

等价交叉乘积为：

```text
populationA² * nB * (nB + 1)  对  populationB² * nA * (nA + 1)
```

人口和乘积均使用 `BigInt` 精确处理。完全平局时按稳定地区编号顺序：先按十进制位数、再按字典序。输入数组顺序不会成为隐藏平局条件。

本项目强制每个地区至少一席，因此总席位不能少于地区数，也不支持最低席位例外、多层分配或多制度比较。结果不声称满足其他分摊方法的配额公理。

## 环境

- Windows PowerShell
- Node.js 22 以上；开发验证使用 Node.js 25
- SQLite 使用 Node 内置 `node:sqlite`

## 安装与构建

```powershell
npm install
npm run build
```

## 演示

```powershell
npm run demo
```

演示包含：

- 3 个不同人口地区分配到 10 席，展示逐轮优先级和席位表。
- 3 个相同人口地区分配到 6 席，展示固定编号平局。

## 启动 API

```powershell
npm start
```

默认把端口设为 `0`，系统会选择本机空闲端口并在控制台输出。也可以指定端口：

```powershell
$env:PORT="8080"; npm start
```

数据默认写入项目内 `data/huntington-hill.sqlite`。可通过 `HH_DATA_DIR` 修改目录：

```powershell
$env:HH_DATA_DIR="$PWD\data"; npm start
```

服务只监听 `127.0.0.1`。

## API

所有人口均使用十进制整数字符串。

### 建立冻结人口版本

```powershell
$body = @'
{"regions":[{"id":"1","population":"600"},{"id":"2","population":"300"},{"id":"3","population":"100"}]}
'@
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/versions -ContentType 'application/json' -Body $body
```

可选项：

```json
{
  "limits": {
    "maxRegions": 1000,
    "maxPopulationDigits": 39,
    "maxTotalSeats": 100000
  }
}
```

相同人口、限制和规则版本的重复提交会返回既有版本，不产生覆盖。

### 执行分配

`POST /allocations`

```json
{"populationVersionId":"...", "totalSeats":10}
```

返回最终席位、每轮获席地区、分配前后席位、所有候选地区的精确分子/分母以及交叉乘积关系。

### 查询

- `GET /allocations`：列出分配。
- `GET /allocations?id=...`：读取完整分配。
- `GET /rounds?allocationId=...&limit=50&offset=0`：分页读取逐轮记录。
- `GET /regions?allocationId=...&regionId=...`：查询地区席位。
- `GET /export?allocationId=...`：导出冻结人口、规则、最终结果和轮次 JSON。

### 比较相邻总席位数

`POST /compare`

```json
{"lowerAllocationId":"...", "higherAllocationId":"..."}
```

第二个分配的总席位必须恰好多 1，并且属于同一个冻结人口版本。报告展示新增席位去向，以及新增席位后各地区的人口每席整数商、余数和小数近似。

## CLI

人口文件 `regions.json`：

```json
{
  "regions": [
    {"id":"1","population":"600"},
    {"id":"2","population":"300"},
    {"id":"3","population":"100"}
  ]
}
```

命令：

```powershell
node dist/cli.js create-version --regions regions.json
node dist/cli.js allocate --version <版本ID> --total-seats 10
node dist/cli.js show --allocation <分配ID> --rounds 10
node dist/cli.js compare --lower <7席ID> --higher <8席ID>
node dist/cli.js export --allocation <分配ID>
```

## 校验与错误

以下输入会被拒绝：

- 空地区列表、重复地区编号。
- 零人口、负数、小数、非字符串、前导零整数。
- 地区数或人口位数超过限制。
- 总席位小于地区数或超过上限。

错误 JSON 包含 `error.code`、中文 `message` 和部分 `details`。常见代码：

- `VALIDATION_ERROR`
- `LIMIT_EXCEEDED`
- `NOT_FOUND`
- `BAD_REQUEST`

## 持久化和回放

SQLite 保存：

- 冻结人口版本及校验和。
- 规则版本。
- 总席位和完整最终结果。
- 每轮获席记录、候选优先级和交叉乘积。

修改人口会创建新版本与新分析，不覆盖旧版本或旧分配。分配及逐轮记录在一个数据库事务中提交；中途失败会回滚。重启后直接读取旧快照和原记录，不重新解释或覆盖历史。

## 测试

```powershell
npm test
```

测试覆盖：

- 总席位恰好等于地区数。
- 单地区、39 位人口、重复提交和上限拒绝。
- 小样例逐轮手算顺序。
- 每轮独立全量扫描所有地区的参考实现。
- 相同人口平局、输入重排、人口统一乘正整数。
- 增加一席时只有一个地区增席且无地区减席。
- 事务失败回滚和重启读取。

## 限制

- 只实现 Huntington–Hill；不比较多种选举制度。
- 不提供前端页面。
- 人口用于虚构算法演示，不处理真实选票、候选人排序或选举认证。
- `populationPerSeatApproximate` 仅用于展示，实际选择始终由 BigInt 精确比较决定。
