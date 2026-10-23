# 旗舰融合 · Flagship Fusion

> 301 仓旗舰舰队的**治理层** —— 不重写任何算法，只锻造「尺子」。
>
> 作者：**晨星** · 深圳市 AI 云科技 · 一人公司（OPC）
> 许可：MIT · 成果完整开源至 GitHub · 可运行 / 可复现 / 可验证

---

## 这是什么

一个**零依赖**的 Node.js 治理层，把晨星舰队 301 个仓库里**各自已经写好的** AI 实现
（Transformer、GMM、QR/Jacobi、AdamW、BM25、BPE、Viterbi、值迭代……）放在一起：

| 能力 | 文件 | 解决的问题 | 范式锚定 |
|---|---|---|---|
| 跨仓差分对拍 | `src/differential.js` | **同名不同义**：gelu 精确/tanh 近似、crossEntropy log₂/log、layernorm 按行/展平、erf 近似精度差 8 个数量级 | NIST 资格认证的多实现互证 |
| ISA 交叉索引 | `src/isa-crosswalk.js` | 两套 ISA 设计正交（AXIOM「有哪些算子」vs L10「哪些代数律成立」），无映射 | 编译器 ISA 完备性检查 |
| 变体缺口审计 | `src/variant-closer.js` | 213 条 spec-only 缺口：区分「缺算法」与「属性本不成立」 | 属性测试（QuickCheck/Hypothesis） |
| 舰队统一验证 | `src/fleet-verify.js` | 301 仓各自绿，但看不到舰队整体健康度 | pytest/jest workspace + Bazel aggregation |
| 单文件仪表盘 | `tools/build-dashboard.js` | 上述结果的零依赖可视化 | 浏览器内一键自检范式 |

**核心主张**：每个仓的自测全绿 ≠ 跨仓一致。对拍引擎首次运行就抓出 4 处分歧
（gelu 语义、crossEntropy 底数、layernorm 归一轴、erf 精度档），各仓自测全都「绿」——
这正是治理层存在的理由。

---

## 快速开始

```bash
# 零依赖，无需 npm install
node src/differential.js          # 跨仓差分对拍（13 项语义契约）
node src/isa-crosswalk.js         # AXIOM 1024 微指令 × L10 交叉索引
node src/variant-closer.js        # 213 条变体缺口诚实审计
node src/fleet-verify.js          # 舰队统一验证（默认 210 本地快照仓）
node tools/build-dashboard.js     # 生成零依赖单文件仪表盘

# —— 依赖自治修复链（新增）——
node tools/fleet-npm-install.js   # 为缺 node_modules 的仓批量安装依赖
node tools/entrypoint-doctor.js   # 诊断「垫片入口失效」的仓，产出待审覆盖表
node tools/fleet-fetch.js         # 从 GitHub 重新收割舰队源码快照（tarball）
```

打开 `dashboard.html` 即可交互浏览全部结果（无外部请求、无 CDN、无构建链）。

---

## 依赖自治与诚实记账（2026-10-24 增补）

213 仓首跑把 **118 个仓判成 FAIL**。逐条归因后发现：其中绝大多数不是代码缺陷，
而是**环境问题**与**快照结构属性**。治理层据此新增三项机制，全部如实记账：

### 1. Python 依赖栈自治修复

根因：验证器调裸 `python`，解析到无第三方库的解释器，导致 62 个仓报
`No module named 'numpy'`。按隔离规则装入受管 venv
（numpy 2.5.4 / scipy 1.16.3 / scikit-learn 1.9.1 / pandas 3.0.6）后，
验证器改为**能力探测**：依次候选解释器并实跑 `import numpy,scipy,sklearn,pandas`，
取第一个真能导入的；全部失败则如实回退并标记 `ENV-BLOCKED`，绝不假装有依赖。

### 2. `ENV-BLOCKED` 与 `FAIL` 分账

把「缺依赖」从「代码真缺陷」里分出来，是避免**让使用者去改本来正确的代码**的关键：

| 状态 | 含义 | 该谁行动 |
|---|---|---|
| `PASS` / `PASS-CORE` | 自检通过（降级绿如实标注） | 无需行动 |
| `ENV-BLOCKED` 🔧 | 环境缺依赖（numpy / node_modules / 私有包 404） | 修环境后重验 |
| `FAIL` ❌ | 真断言失败或真崩溃 | 改代码 |
| `NO-CHECK` ➖ | 仓内无自检入口 | 补自检（可选） |
| `TIMEOUT` ⏱️ | 超时且无降级入口 | 调预算或拆慢测试 |

### 3. Curated 入口覆盖表 `data/entrypoint-overrides.json`

自动探测按惯例猜入口，惯例失效时分两种性质，都显式登记而非静默：

- **`entry`** —— 仓自身打包不一致，重定向到真实入口。
  实证案例 `transformer-forge`：其 `_smoke.js` / `_probe.js` / `_uicheck.js` 三个垫片都从
  `index.html` 正则抠 `<script id="engine">` 内联引擎，但引擎早已拆成独立 UMD 文件
  `transformer-forge.js`，垫片正则恒返回 `null` 而崩溃；而 `transformer-forge.js`
  自带 `require.main === module` 自检入口，实测 **8/8 全绿**。
- **`substitute`** —— 聚合仓的子模块在 tarball 快照中为空占位（git submodule 内容不入快照），
  由舰队中独立存在的兄弟仓代行验证。
  实证案例 `flagship-monorepo`：四个子目录均为空，四个兄弟仓实测
  **8/8 + 9/9 + 9/9 + 6/6 = 32/32 全绿**。

每条覆盖都附**可复现实测命令与输出**，维护原则：不接受「试试看」。

### 4. `tools/entrypoint-doctor.js` —— 入口医生

对 27 个「垫片家族」仓逐个实跑：垫片能跑就不动；跑不动的，枚举仓内所有含
`require.main === module` 的根 `.js` 并逐个实跑，产出**待审覆盖表**
（`data/proposed-overrides.json`）。提议 ≠ 生效，须人工确认后才进 overrides。

**实测结论（修正判定式后）**：27 个垫片仓中 **26 个正常工作，1 个真损坏且已重定向**
（transformer-forge），**0 个无解**。其中 kalman-forge（204/204）与 spectral-forge（33/33）
在 45s 预算下会超时、在 150s 预算下全绿——是**慢**不是坏，故医生超时预算与
`fleet-verify.js` 的 `TIMEOUT_MS` 对齐。

> 教训：判定式的第一版正则漏认了 `ALL GREEN`、`SUMMARY: 8/8`、`PASS 204 / 204` 三种写法，
> 一度把 13 个健康仓误报成「损坏」。**工具的误报率和被测系统的缺陷率一样值得审计。**

### 5. npm 依赖批量安装

`tools/fleet-npm-install.js` 为缺 `node_modules` 的仓逐个 `npm install`
（逐仓隔离 + 6 分钟硬超时 + 如实记账）。实测把
**aether-research 从 0 测试变成 48 通过**、**aetherflow 从 0 变成 105 通过**——
零代码改动，纯环境修复即回收 153 个绿色测试。

---

## 实测结果（2026-10-24）

### 1. 跨仓差分对拍 —— 13 项语义契约，0 破约

```
总计 13：🟢全绿 7 · 🟠降级 1 · 🟡孤证 5 · 🔴破约 0
🟢 硬门禁通过（无破约）
```

三级判决 + 四道硬门禁：

- **G1 多实现**：同一语义契约至少有 2 个独立实现参与（孤证降级为 🟡）
- **G2 两两一致**：所有实现对拍 Δ ≤ 容差
- **G3 契约内**：各实现 vs 高精度参照 Δ ≤ 契约精度档
- **G4 相对误差**：maxRelErr ≤ 1e-9 **或** 绝对差 ≤ 契约容差
  （numpy.allclose 混合判据；纯相对误差在真值趋零处会失真，是数值验证的经典陷阱）

对拍抓出的真实分歧（各仓自测均「绿」）：

| 分歧 | 根因 | 处置 |
|---|---|---|
| `gelu` Δ≈1e-3 | axiom-ai 用 A&S 近似 erf（≈1.5e-7），ai-forge 用机器精度 erf（4.4e-16） | 拆为 `gelu.erf` / `gelu.tanh` 两个语义契约 |
| `crossEntropy` 差 ln2 倍 | 一个用 log₂、一个用 ln | 拆为 `crossEntropy.bits` / `.nat` |
| `layernorm` 不一致 | 一个按行归一、一个对全张量归一 | 拆为 `layernorm.row` / `.flat` |
| `erf` 精度差 8 个数量级 | 近似式 vs 机器精度实现 | 记入精度排序，推荐档内实现 |

**互证密度最高的原语**：`matmul` / `softmax` —— 5 个独立实现两两对拍全部 Δ=0.00e+0。

### 2. AXIOM ISA 覆盖 —— 812/1024 = 79.3%

```
base 255 · batched 243 · fused 240 · inplace 73
```

每族恰 64 条 = 16 算子 × 4 变体（base/batched/fused/inplace）；每算子恰 4 变体。

### 3. 变体缺口审计 —— 213 条逐条定性

```
inplace 183 · batched 13 · fused 16 · base 1
可闭合 1 · 形状不守恒（原地语义本不成立）84 · 缺签名表样本 52 …
```

**关键结论：缺口 ≠ 缺算法。** 84 条属形状不守恒（reshape / QR / eig / concat / split），
「原地执行」在语义上本就不成立——这是**属性判定**，不是缺陷，更不是待实现项。

### 4. 舰队统一验证

```bash
node src/fleet-verify.js --json data/fleet-verify-full.json
```

- 探测各仓既有自检入口（`npm test` / `node test/run.js` / `src/verify.js`）
- **超时降级**：全量入口超时 → 重试轻量入口（`test:core` 等），如实标记 `PASS-CORE`，
  绝不把超时粉饰成通过
- 退出码：0 = 全体绿 · 1 = 存在失败仓 · 2 = 用法/环境错误

实测依据：axiom-ai 的 `npm test` = core(8.5s) + ui-smoke；ui-smoke 在 vm 沙箱内运行
386 项不变量检查需 26s（跨 realm 调用失去 JIT 优化），全量 69.2s 通过。
这不是缺陷，是**环境属性**——故设两级入口，两者都如实记账。

#### 数据年份与快照说明（诚实记账）

- `data/fleet-verify-full.json` 是 **2026-10-24 03:48（UTC）的基线快照**，
  早于本文档上述全部自治修复；`dashboard.html` 的舰队视图即渲染该快照，
  并在视图内标注快照时间。因此基线中的 118 个 FAIL 含大量
  「环境受阻」（缺 numpy / 缺 node_modules / 入口失效）而非代码缺陷。
- 全量复跑被用户中止后未重启。改为对修复声明涉及的 6 个关键仓做
  **有界抽查**（`node src/fleet-verify.js --only aether-research,aetherflow,transformer-forge,flagship-monorepo,kalman-forge,spectral-forge --json data/spot-check.json`）：

| 仓 | 入口 | 抽查结果 |
|---|---|---|
| aether-research | `npm test` → vitest | ✅ Tests 48 passed (48) |
| aetherflow | `npm test` → vitest | ✅ Tests 105 passed (105) |
| flagship-monorepo | substitute → 4 兄弟仓 | ✅ 4/4 PASS（子模块空占位代验） |
| kalman-forge | `node _smoke.js` | ✅ 204/204 ALL GREEN |
| spectral-forge | `node _smoke.js` | ✅ 33/33 |
| transformer-forge | `node transformer-forge.js`（覆盖入口） | ✅ 8/8 全绿 |

**抽查 6/6 全绿，100.0%**（2026-10-24 20:50 UTC）。Python 解释器解析到受管 venv
（numpy/scipy/sklearn/pandas 能力探测通过）。

---

## 仓库结构

```
flagship-fusion/
├── dashboard.html              # 零依赖单文件仪表盘（构建产物）
├── src/
│   ├── differential.js         # 跨仓差分对拍引擎
│   ├── isa-crosswalk.js        # AXIOM ↔ L10 ISA 交叉索引
│   ├── variant-closer.js       # 变体缺口诚实审计器
│   └── fleet-verify.js         # 舰队统一验证器（含入口覆盖 + 失败归因）
├── tools/
│   ├── build-dashboard.js      # 仪表盘构建器（装配既有 JSON，不造数）
│   ├── fleet-fetch.js          # 从 GitHub 收割舰队源码快照（codeload tarball）
│   ├── fleet-npm-install.js    # 缺 node_modules 仓的依赖自治安装器
│   └── entrypoint-doctor.js    # 垫片入口诊断器（产出待审覆盖表）
└── data/                       # 实测产物（JSON，可复现）
    ├── differential.json
    ├── isa-crosswalk.json
    ├── variant-closure.json
    ├── fleet-verify-full.json      # 基线快照 03:48 UTC（修复前，见「数据年份」）
    ├── spot-check.json             # 修复后 6 关键仓有界抽查（6/6 全绿）
    ├── entrypoint-overrides.json   # curated 入口覆盖表（含理由）
    └── proposed-overrides.json     # 医生产出的待审候选
```

---

## 零重写原则

本仓库**不包含任何算法实现**——所有数学计算都发生在被治理的 301 个旗舰仓里。
这里只有四样东西：**尺子**（对拍判据）、**地图**（ISA 交叉索引）、
**账本**（缺口审计）、**仪表**（舰队验证 + 可视化）。

凡有更强的现成方案，立即替换自写；每一行代码都站在世界顶级成果之上。

---

## 数据来源

舰队快照位于**工作区** `.cache/fleet/`（210 仓源码，本仓库的同级目录，不在库内），
元数据快照 `.cache/repos.json`（301 仓，GitHub GraphQL 清单）。
两者均为构建输入，不入库（体积原因），可用以下命令重新生成：

```bash
node tools/fleet-fetch.js                 # 按 .cache/repos.json 全量收割
node tools/fleet-fetch.js --list          # 先看清单再动手
node tools/fleet-fetch.js --only a,b,c    # 补收割指定仓
node tools/fleet-fetch.js --force         # 强制重新下载
```

收割方式：codeload tarball（`codeload.github.com/<org>/<repo>/tar.gz/HEAD`）
+ 系统 tar 解包，四态如实记账（已收割 / 已存在 / 404 / 错误）。
路径漂移时用 `FUSION_FLEET` / `FUSION_MANIFEST` 环境变量指位。
tarball 不含 git submodule 内容——聚合仓子模块的空占位由
`fleet-verify.js` 的 substitute 机制交兄弟仓代验，语义无损。

---

## 许可

MIT License · 作者署名：**晨星**
