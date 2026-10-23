/* ============================================================================
 * flagship-fusion · ISA 交叉索引（ISA Crosswalk）
 * ----------------------------------------------------------------------------
 * 发现（零重写审计的第一手结论）：
 *   舰队里存在两套各自完整的 1024 项微指令集，设计【正交】：
 *
 *   AXIOM (axiom-ai)          1024 = 16 族 × 16 算子 × 4 变体
 *     回答的是：「有哪些算子，各有哪些执行变体」
 *     变体轴 = base（标量语义）· batched（批处理，逐位一致）
 *              fused（融合，消除中间物化）· inplace（原地执行）
 *
 *   flagship-ai L10           1024 = 8 域 × 128 槽位
 *     回答的是：「每条代数律是否成立」
 *     域轴 = A 标量 · B 向量 · C 矩阵 · D 注意力 · E 形状 · F 归一 · G 激活 · H 采样
 *
 *   二者不是同一张表的两种编号，而是一枚硬币的两面：
 *     AXIOM 的算子空间  ×  flagship-ai 的律空间  ≫ 任一单独集合
 *
 * 本模块做三件事（全部是「读 + 索引」，不产生任何新算法）：
 *   1. 拉取两套注册表（AXIOM 的 src/registry.js、flagship-ai 的 NS.L10.ops）
 *   2. 建立【统一语义标签轴】——把两套 ISA 各自映射到同一组主题标签
 *   3. 输出交叉矩阵：哪些语义被两套 ISA 各自覆盖（双证）、哪些只有一方覆盖（孤证）
 *
 * 输出：data/isa-crosswalk.json + 终端矩阵报告
 *
 * 范式锚定：ONNX operator-set 的「同一 op 多版本并存」模型 +
 *            数据库领域的 schema mapping（同构异名 / 同名异构）+
 *            图论中的双射与覆盖度分析。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./adapter.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'isa-crosswalk.json');

/* ---------------------------------------------------------------------------
 * 1. 统一语义标签轴（Unified Semantic Tag Axis）
 *    这是本模块的核心资产：一套能同时描述「算子空间」与「律空间」的标签体系。
 *    标签来源：两套 ISA 自己的 group/domain 名称 + 算子名关键词。
 * -------------------------------------------------------------------------*/
const TAGS = [
  { id: 'scalar', zh: '标量算术与初等函数', kw: [/^标量|标量/, /sigmoid|gelu|erf|tanh|relu|expm1|log1p|sqrt|reciprocal|clip|fma|hypot|除与|分配|对合|零元|结合|交换/] },
  { id: 'vector', zh: '向量运算与聚合', kw: [/vec|向量/, /归约|reduce|求和|均值|中位|范数|逐元素|elementwise/] },
  { id: 'matrix', zh: '矩阵/张量运算', kw: [/矩阵|matrix|matmul|matvec|张量|tensor/i, /转置|transpose|乘加|矩阵加|矩阵减|矩阵缩放/] },
  { id: 'shape', zh: '形状与索引', kw: [/reshape|形状|索引|切片|slice|gather|scatter|步长|维度|stride/] },
  { id: 'norm', zh: '归一化与正则', kw: [/归一|norm|层归一|layernorm|rmsnorm|批归一|batch.?norm|权重归一|group_norm|minmax|zscore/i] },
  { id: 'attn', zh: '注意力与位置编码', kw: [/注意力|attention|attn|qk|打分|因果|mask|rope|alibi|kv.?cache|多头|mha|gqa|mqa/i] },
  { id: 'act', zh: '激活与损失', kw: [/激活|act/i, /损失|loss|交叉熵|cross.?entropy|softmax.*ce/] },
  { id: 'sample', zh: '采样与量化', kw: [/采样|sampl|topk|topk|argmax|argmin|量化|quant|温度|temperature/i] },
  { id: 'opt', zh: '优化与梯度', kw: [/优化|optim|adam|sgd|梯度下降|动量|momentum|共轭|broyden|bfgs|学习率|衰减|裁剪/] },
  { id: 'pgm', zh: '概率图与推断', kw: [/概率图|pgm|hmm|马尔可夫|贝叶斯|bayes|前向-后向|viterbi|belief|mcmc|gibbs|粒子|kalman|d.?separation/] },
  { id: 'rl', zh: '强化学习与决策', kw: [/强化|reinforcement|policy|q.?learning|sarsa|td|bandit|ucb|ppo|monte.?carlo|价值迭代/] },
  { id: 'metric', zh: '评估与度量', kw: [/准确率|精度|召回|auc|f1|困惑度|perplexity|bleu|mrr|ndcg|指标|metric|编辑距离|轮廓/] },
  { id: 'data', zh: '数据处理与管线', kw: [/数据|data|分词|token|shuffle|归一化拟合|增广|去重|填充|pad|onehot/i] },
  { id: 'info', zh: '信息论与熵', kw: [/信息|entropy|熵|kl|互信息|困惑|信道|容量|rate.?distortion/i] },
  { id: 'sys', zh: '系统运行时', kw: [/arena|内存|缓存|cache|屏障|barrier|流|stream|事件|event|追踪|trace|profile|派发|dispatch|栅栏|fence|引用计数|ref_?count|checkpoint|预取|prefetch/] },
  { id: 'prob', zh: '概率分布与采样', kw: [/高斯|gauss|正态|伯努利|二项|均匀|期望|variance|协方差|covariance|marginal|条件/] },
  { id: 'lin-alg', zh: '经典线性代数', kw: [/特征|eigen|分解|decompos|cholesky|qr|svd|秩|nullspace|正交|条件数|cond|迹|trace|行列式|det|逆|求解/] },
  { id: 'autograd', zh: '自动微分与反向', kw: [/反向|backward|bwd|梯度检验|grad.?check|链式法则|chain.?rule|jacobian|vjp|jvp|bptt|stop.?grad|detach/i] }
];

function tagOf(text) {
  const t = String(text || '');
  const hits = [];
  for (const tag of TAGS) {
    if (tag.kw.some(re => re.test(t))) hits.push(tag.id);
  }
  return hits;
}

/* ---------------------------------------------------------------------------
 * 2. 拉取 AXIOM 注册表（1024 项）
 * -------------------------------------------------------------------------*/
function loadAxiomRegistry() {
  const dir = A.findRepoDir('axiom-ai');
  if (!dir) return null;
  const p = path.join(dir, 'src', 'registry.js');
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/var AXIOM_REGISTRY = (\[[\s\S]*?\]);/);
  if (!m) return null;
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

/* ---------------------------------------------------------------------------
 * 3. 拉取 flagship-ai L10 注册表（1024 项）
 * -------------------------------------------------------------------------*/
function loadFlagshipL10() {
  const dir = A.findRepoDir('flagship-ai');
  if (!dir) return null;
  const idx = path.join(dir, 'src', 'index.js');
  if (!fs.existsSync(idx)) return null;
  const NS = globalThis.FlagshipAI || (globalThis.FlagshipAI = {});
  try {
    delete require.cache[require.resolve(idx)];
    require(idx);
  } catch (e) {
    return null;
  }
  const L10 = globalThis.FlagshipAI && globalThis.FlagshipAI.L10;
  if (!L10 || !L10.ops) return null;
  const out = [];
  for (const key of Object.keys(L10.ops)) {
    const op = L10.ops[key];
    out.push({
      key,
      domain: op.domain,
      index: op.index,
      name: op.name,
      invariant: op.invariant,
      status: op.status,
      math: op.math || '',
      ref: op.ref || '',
      complexity: op.complexity || ''
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 4. 交叉矩阵构建
 * -------------------------------------------------------------------------*/
function buildCrosswalk() {
  const axiom = loadAxiomRegistry();
  const flagship = loadFlagshipL10();

  if (!axiom) throw new Error('未找到 axiom-ai 注册表（需先放置 vendor/axiom-ai 或 .cache/fleet/axiom-ai）');
  if (!flagship) throw new Error('未找到 flagship-ai L10 注册表');

  // AXIOM 侧：按 (group, op) 归并 4 变体
  const axiomOps = new Map();
  for (const e of axiom) {
    const k = `${e.group}.${e.op}`;
    if (!axiomOps.has(k)) {
      axiomOps.set(k, {
        key: k, group: e.group, groupZh: e.groupName, op: e.op, opZh: e.opZh,
        variants: {}, invariant: e.invariant, tags: tagOf(`${e.group} ${e.op} ${e.opZh} ${e.name}`)
      });
    }
    axiomOps.get(k).variants[e.variant] = { status: e.status, impl: e.impl, id: e.id };
  }

  // flagship-ai 侧：按域归并 128 槽
  const flagshipDomains = new Map();
  for (const e of flagship) {
    if (!flagshipDomains.has(e.domain)) {
      flagshipDomains.set(e.domain, {
        domain: e.domain, name: e.domain === 'A' ? '标量算术与初等函数' : '', slots: [], tags: new Set()
      });
    }
    const d = flagshipDomains.get(e.domain);
    d.slots.push(e);
    for (const t of tagOf(`${e.domain} ${e.name} ${e.invariant} ${e.math}`)) d.tags.add(t);
  }

  // 标签 → 覆盖统计
  const tagCoverage = {};
  for (const tag of TAGS) {
    const axiomHits = [...axiomOps.values()].filter(o => o.tags.includes(tag.id));
    const flagDomains = [...flagshipDomains.values()].filter(d => d.tags.has(tag.id));
    const flagSlots = flagDomains.reduce((n, d) => n + d.slots.length, 0);
    tagCoverage[tag.id] = {
      zh: tag.zh,
      axiomOps: axiomHits.length,
      axiomOpsAll: axiomHits.map(o => o.key),
      flagshipDomains: flagDomains.map(d => d.domain),
      flagshipSlots: flagSlots,
      dual: axiomHits.length > 0 && flagSlots > 0,
      onlyIn: axiomHits.length > 0 && flagSlots === 0 ? 'axiom'
        : (axiomHits.length === 0 && flagSlots > 0 ? 'flagship' : 'both')
    };
  }

  // 变体覆盖统计（AXIOM 特有轴）
  const variantCoverage = { base: 0, batched: 0, fused: 0, inplace: 0 };
  for (const o of axiomOps.values()) {
    for (const v of Object.keys(variantCoverage)) {
      if (o.variants[v] && o.variants[v].status === 'verified') variantCoverage[v]++;
    }
  }

  const totalVariants = Object.keys(variantCoverage).reduce((n, v) => n + variantCoverage[v], 0);
  const totalPossible = axiomOps.size * 4;

  return {
    schema: 'flagship-fusion/isa-crosswalk@1',
    generatedAt: new Date().toISOString(),
    generator: 'src/isa-crosswalk.js',
    sources: {
      axiom: { repo: 'axiom-ai', file: 'src/registry.js', entries: axiom.length, ops: axiomOps.size },
      flagship: { repo: 'flagship-ai', file: 'src/L10-microisa/registry.js', entries: flagship.length, domains: flagshipDomains.size }
    },
    designNote: '两套 ISA 正交：AXIOM = 算子空间（16族×16算子×4变体），flagship-ai L10 = 律空间（8域×128律）。交叉后覆盖度显著大于任一单独集合。',
    tagAxis: TAGS.map(t => ({ id: t.id, zh: t.zh })),
    tagCoverage,
    variantCoverage: {
      perVariant: variantCoverage,
      verified: totalVariants,
      possible: totalPossible,
      coverage: totalVariants / totalPossible
    },
    axiomOps: [...axiomOps.values()].map(o => ({
      key: o.key, group: o.group, groupZh: o.groupZh, op: o.op, opZh: o.opZh,
      invariant: o.invariant, tags: o.tags,
      variants: Object.fromEntries(Object.entries(o.variants).map(([k, v]) => [k, { status: v.status, impl: v.impl, id: v.id }]))
    })),
    flagshipDomains: [...flagshipDomains.values()].map(d => ({
      domain: d.domain, slots: d.slots.length, tags: [...d.tags],
      impl: d.slots.filter(s => s.status === 'impl').length
    }))
  };
}

/* CLI */
if (require.main === module) {
  const cw = buildCrosswalk();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(cw, null, 2));

  console.log('════════════════════════════════════════════════════════════');
  console.log(' 旗舰融合 · ISA 交叉索引');
  console.log('════════════════════════════════════════════════════════════');
  console.log(` AXIOM      : ${cw.sources.axiom.entries} 条 = ${cw.sources.axiom.ops} 算子 × 4 变体`);
  console.log(` flagship-ai: ${cw.sources.flagship.entries} 条 = ${cw.sources.flagship.domains} 域 × 128 槽`);
  console.log('─���───────────────────────────────────────────────────────────');
  console.log(' 语义标签轴覆盖：');
  console.log('   标签'.padEnd(14) + 'AXIOM算子  flagship槽位  覆盖');
  for (const t of Object.entries(cw.tagCoverage)) {
    const c = t[1];
    const mark = c.dual ? '双证 ✅' : (c.onlyIn === 'axiom' ? '仅AXIOM ⚠️' : '仅flagship ⚠️');
    console.log(`   ${t[0].padEnd(14)} ${String(c.axiomOps).padStart(8)} ${String(c.flagshipSlots).padStart(12)}  ${mark}`);
  }
  console.log('────────────────────────────────────────────────────────────');
  const v = cw.variantCoverage;
  console.log(` AXIOM 变体覆盖：base ${v.perVariant.base} · batched ${v.perVariant.batched} · fused ${v.perVariant.fused} · inplace ${v.perVariant.inplace}`);
  console.log(`   合计 ${v.verified}/${v.possible} = ${(v.coverage * 100).toFixed(1)}%`);
  console.log(` → ${OUT}`);
}

module.exports = { buildCrosswalk, TAGS, tagOf };
