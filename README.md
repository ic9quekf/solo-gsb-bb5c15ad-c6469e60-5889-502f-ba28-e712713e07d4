# 桌游回合规则验证器

用表单定义**有限状态变量**、**初始值**以及带**条件**和**赋值**的回合规则；系统从初始状态做
**广度优先（BFS）状态空间探索**，自动找出以下三类问题状态，并返回从初始状态出发的**最短触发路径**：

| 问题类型 | 含义 |
| --- | --- |
| 🚫 死锁 `deadlock` | 该状态下**没有任何规则**的触发条件成立（无规则可执行） |
| ⚔️ 互斥冲突 `conflict` | 该状态下有**多条规则同时可执行**（互斥规则重叠触发） |
| 💥 非法转移 `invalidTransition` | 某条可执行规则的赋值结果**超出变量定义域** |

探索对状态**规范化去重**（循环安全），并在达到**状态上限**或**步数视界**时将结果显式标记为
`truncated`（**不完备**）——已探索部分未发现问题时结论是"不能判定安全"，**绝不会误报安全**。

技术栈：Node.js + Express + 原生 HTML/CSS/JS（无前端构建步骤）。

## 一键启动（推荐）

需要本机安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up --build -d
```

然后浏览器打开：

> **http://localhost:3000**

停止服务：

```bash
docker compose down
```

## 本地直接运行

需要 Node.js ≥ 18：

```bash
npm install
npm start
```

同样访问 **http://localhost:3000**。

## 使用方法

1. **定义状态变量**：支持
   - `int` 整数型，需给出闭区间定义域 `[min, max]`（赋值越界即非法转移）；
   - `bool` 布尔型。
2. **填写初始状态**。
3. **设置探索参数**：
   - `maxSteps`：最大步数（BFS 深度上限，0~100）；
   - `maxStates`：去重后状态数量上限（1~200000）。
4. **添加规则**：每条规则包含
   - 规则 ID 与名称；
   - 触发条件：可视化嵌套条件树，支持 **AND / OR / NOT** 分组与 `== != > >= < <=` 比较；无条件表示始终触发；
   - 赋值列表：`set`（设为）、`add`（+=）、`sub`（−=），规则触发后顺序执行；布尔变量仅支持 `set`。
5. 点击 **▶ 运行验证**。
6. 结果区展示：
   - 总体结论徽标（安全 / 发现问题 / **结果不完备**）；
   - 已探索状态数、实际到达深度、合法转移数、各类问题计数；
   - 每个问题状态的最短触发路径（逐步列出触发的规则 ID 与每步状态）。

页面内置 **"安全示例"** 与 **"缺陷示例"**（同时演示冲突、死锁、越界），可一键载入体验。

## 规则集 JSON 导入 / 导出

- 点击 **⤓ 导出 JSON** 下载完整规则集（含变量、初始状态、规则、探索参数）；
- 点击 **⤒ 导入 JSON** 载入此前导出的文件继续编辑。

JSON 结构示例：

```json
{
  "variables": [
    { "name": "phase", "type": "int", "domain": { "min": 0, "max": 2 } },
    { "name": "energy", "type": "int", "domain": { "min": 0, "max": 5 } }
  ],
  "initialState": { "phase": 0, "energy": 5 },
  "rules": [
    {
      "id": "play",
      "name": "出牌",
      "condition": {
        "kind": "all",
        "children": [
          { "kind": "leaf", "var": "phase", "op": "==", "value": 0 },
          { "kind": "leaf", "var": "energy", "op": ">", "value": 0 }
        ]
      },
      "assignments": [
        { "target": "energy", "op": "sub", "value": 1 },
        { "target": "phase", "op": "set", "value": 1 }
      ]
    }
  ],
  "maxSteps": 12,
  "maxStates": 5000
}
```

条件节点说明：`{ "kind": "all" | "any", "children": [...] }`、
`{ "kind": "not", "child": <节点> }`、
`{ "kind": "leaf", "var": "...", "op": "==", "value": 0 }`；
`condition` 为 `null` 时规则无条件触发。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/validate` | 请求体即规则集 JSON，返回探索结果 |
| `GET` | `/api/health` | 健康检查 |

返回结果中的判定字段 `verdict`：

- `safe`：探索完整且未发现问题；
- `issues`：探索完整且发现问题；
- `issues_incomplete`：发现问题，但因达到上限探索被截断，可能还有更多问题；
- `unknown_incomplete`：已探索部分无问题，但探索被截断——**不能判定安全**，请调大上限重试。

```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d @ruleset.json
```

## 正确性要点

- **BFS 保证最短路径**：问题状态在第一次出队（即最浅层）时记录，触发路径即最短路径。
- **状态去重**：按变量名排序序列化生成规范键，相同状态只入队一次，自环/循环不会导致死循环。
- **完备性诚实标记**：状态上限触发时，新状态不再入队且 `truncated=true`；
  步数边界上若仍有可执行规则，同样标记视界截断。两种情况下都不会返回"安全"结论。
- **边界层仍检测**：步数边界上的状态照样检查死锁/冲突，只是不再扩展后继。

## 测试

```bash
npm test
```

覆盖：安全判定、死锁与最短路径、初始态冲突、越界赋值、自环去重、状态上限截断、
步数视界截断、规范键顺序无关、条件树求值与输入校验。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── server.js               # Express 入口（静态资源 + /api/validate）
├── src/engine/
│   ├── conditions.js       # 条件树求值（AND/OR/NOT/比较）
│   ├── assignments.js      # 赋值执行与定义域检查
│   ├── validator.js        # BFS 探索、去重、截断与最短路径
│   └── validate.js         # 输入校验
├── public/                 # 原生前端
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/engine.test.js
```
