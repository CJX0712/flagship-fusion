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
```

打开 `dashboard.html` 即可交互浏览全部结果（无外部请求、无 CDN、无构建链）。

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

### 2. AXIOM ISA 覆盖 —— 811/1024 = 79.2%

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

---

## 仓库结构

```
flagship-fusion/
├── dashboard.html              # 零依赖单文件仪表盘（构建产物）
├── src/
│   ├── differential.js         # 跨仓差分对拍引擎
│   ├── isa-crosswalk.js        # AXIOM ↔ L10 ISA 交叉索引
│   ├── variant-closer.js       # 变体缺口诚实审计器
│   └── fleet-verify.js         # 舰队统一验证器
├── tools/
│   └── build-dashboard.js      # 仪表盘构建器（装配既有 JSON，不造数）
└── data/                       # 实测产物（JSON，可复现）
    ├── differential.json
    ├── isa-crosswalk.json
    ├── variant-closure.json
    └── fleet-verify-full.json
```

---

## 零重写原则

本仓库**不包含任何算法实现**——所有数学计算都发生在被治理的 301 个旗舰仓里。
这里只有四样东西：**尺子**（对拍判据）、**地图**（ISA 交叉索引）、
**账本**（缺口审计）、**仪表**（舰队验证 + 可视化）。

凡有更强的现成方案，立即替换自写；每一行代码都站在世界顶级成果之上。

---

## 数据来源

舰队快照位于 `.cache/fleet/`（210 仓源码，由 `tools/fleet-fetch.js` 从
GitHub `CJX0712` 收割）。元数据快照 `.cache/repos.json`（301 仓）。
两者均为构建输入，不入库（体积原因），可用 `node tools/fleet-fetch.js` 重新生成。

---

## 许可

MIT License · 作者署名：**晨星**
