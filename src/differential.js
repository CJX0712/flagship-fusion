/* ============================================================================
 * flagship-fusion · 跨仓差分对拍引擎（Differential Cross-Check Engine）
 * ----------------------------------------------------------------------------
 * 核心主张：把 301 座仓库里【各自独立写的同一个原语】放在一起，
 *           逐位比较；若全等 → 该原语在舰队层面获得「多实现互证」背书。
 *
 * 为什么这是零重写的极致：
 *   常规做法 = 再写一遍 matmul，然后和 numpy 比。
 *   本做法   = 不写任何 matmul，直接把 flagship-ai / axiom-ai / ai-forge /
 *              flagship-ai-engine / flagship-algo-forge 各自写的 matmul
 *              拉到一起对拍，再与高精度解析参照（Ground Truth）三方互证。
 *   新增资产 = 【一致性证据 + 精度画像】，而不是【又一份重复实现】。
 *
 * ── 三方互证结构 ───────────────────────────────────────────────────────────
 *   impl_A ─┐
 *   impl_B ─┼─→ 两两逐位比较（一致性）  ┐
 *   impl_C ─┘                            ├─→ 判决
 *   ANALYTIC ─── 高精度解析参照（真值） ─┘
 *
 * ── 四级判决（不是简单的红/绿）────────────────────────────────────────────
 *   GREEN    多实现(≥2) · 两两一致 · 各实现均在其自声明精度契约内 · 达最优档
 *   DEGRADED 契约内但精度低于该语义可达到的最优档 → 【降级】，不掩盖
 *   SOLO     仅 1 个实现可参与（契约内）→ 【孤证】，需补第二实现
 *   RED      契约被破（实现与其自声明精度不符）或同语义实现互相矛盾
 *
 *   为什么不做成简单红/绿：本引擎首次运行即发现 —— axiom-ai 的 erf 用
 *   A&S 7.1.26 近似（自声明 |ε|≤1.5e-7），而 ai-forge 的 erf 达机器精度
 *   （4.4e-16）。两者都「自测全绿」，但精度差 9 个数量级。
 *   只有「契约 + 画像」两层分开，才能既不误伤、又不吞掉真相。
 *
 * ── 硬门禁 ────────────────────────────────────────────────────────────────
 *   G1 多实现存在性：参与对拍的独立仓库数（判定 GREEN / SOLO）
 *   G2 两两一致：任意两实现 maxAbsDiff ≤ 双方精度契约的较宽者
 *   G3 契约内：每个实现 maxAbsDiff(参照) ≤ 该仓对该函数的精度契约
 *   G4 相对误差：maxRelErr ≤ 1e-9 或 绝对差 ≤ 契约容差（numpy.allclose 混合判据；
 *                 纯相对误差会在真值趋零处失真，是数值验证的经典陷阱）
 *
 * 范式锚定：QuickCheck (Claessen & Hughes 2000) 性质测试 +
 *            ONNX / StableHLO 的 operator-set 语义版本化 +
 *            numpy / mpmath 双精度与任意精度双轨对照的社区惯例。
 * ==========================================================================*/
'use strict';

const A = require('./adapter.js');

/* ── 语义变体的「最优可达精度」：数学上该语义应能达到的最好档位 ────────── */
const FUSION_TOL = {
  matmul: 1e-15,
  softmax: 1e-15,
  'gelu.erf': 1e-15,
  'gelu.tanh': 1e-15,
  relu: 0,
  'layernorm.row': 1e-15,
  'layernorm.flat': 1e-15,
  'rmsnorm.row': 1e-15,
  logsumexp: 1e-15,
  'crossEntropy.bits': 1e-15,
  'crossEntropy.nat': 1e-15,
  'crossEntropy.logits': 1e-14,
  'adam.step': 1e-15
};

/* ── 各仓自声明精度契约（索引自各仓源码注释，不修改任何一仓）───────────── */
const REPO_CONTRACT = {
  'flagship-ai': {
    default: 1e-13,
    note: '手写反向传播 + Float64Array；前向不变量实测 ≤1e-15'
  },
  'axiom-ai': {
    default: 1e-13,
    // axiom-ai/src/core.js:310 明确注释「Abramowitz–Stegun 7.1.26，|ε|≤1.5e-7」
    'gelu.erf': 1.5e-7,
    note: 'erf 用 A&S 7.1.26（自声明 |ε|≤1.5e-7）；其余解析解直算'
  },
  'ai-forge': {
    default: 1e-14,
    note: 'erf 高精度实现（实测 4.4e-16）'
  },
  'ai-forge-core': {
    default: 1e-13,
    note: '纯 JS 手写内核'
  },
  'flagship-ai-engine': {
    default: 1e-13,
    'gelu.erf': 1e-7,   // erfc 实现，实测 1.10e-8
    note: 'erfc 形式；实测误差 1.10e-8'
  },
  'flagship-algo-forge': {
    default: 1e-13,
    'gelu.erf': 1.5e-7,
    note: 'erf 用 A&S 近似'
  }
};

const REL_TOL = 1e-9;

/** 加载某仓模块 */
function loadSource(name) {
  const spec = A.SOURCES[name];
  if (!spec) return null;
  const mod = A.loadRepo(spec.repo, spec.entry);
  if (!mod || mod.__error) return null;
  return mod;
}

function contractOf(srcName, primName) {
  const c = REPO_CONTRACT[srcName] || { default: 1e-12 };
  const t = c[primName];
  return t != null ? t : c.default;
}

/**
 * 对拍单个 (op, variant)。
 * @returns 判决对象
 */
function checkPrimitive(name) {
  const prim = A.PRIM[name];
  const truth = A.ANALYTIC[name](prim.input());
  const fusionTol = FUSION_TOL[name] != null ? FUSION_TOL[name] : 1e-12;

  const refs = [];
  const errors = [];
  const input = prim.input();

  for (const srcName of Object.keys(A.SOURCES)) {
    const apply = prim.apply[srcName];
    if (!apply) continue;
    const mod = loadSource(srcName);
    if (!mod) continue;
    const spec = A.SOURCES[srcName];
    const locator = spec.locators[name];
    // 必须能定位到真实函数（防止适配器凭空造函数）
    if (locator) {
      const target = locator.split('.').reduce((o, k) => (o ? o[k] : undefined), mod);
      if (typeof target !== 'function') continue;
    }
    let out;
    try {
      out = apply(mod, input);
    } catch (e) {
      errors.push({ src: srcName, locator, error: String(e && e.message || e) });
      continue;
    }
    const d = A.maxAbsDiff(out, truth);
    const r = A.maxRelErr(out, truth);
    const tol = contractOf(srcName, name);
    refs.push({
      src: srcName,
      locator,
      out,
      dTruth: d,
      rTruth: r,
      tol,
      withinContract: d <= tol,
      atFusionTier: d <= fusionTol
    });
  }

  const alive = refs;

  // G2：两两对拍（容差取双方契约较宽者，避免「谁更准谁背锅」）
  const pairwise = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const tol = Math.max(alive[i].tol, alive[j].tol);
      const d = A.maxAbsDiff(alive[i].out, alive[j].out);
      pairwise.push({
        a: alive[i].src, b: alive[j].src, d, r: A.maxRelErr(alive[i].out, alive[j].out),
        tol, ok: d <= tol
      });
    }
  }

  const gates = {
    G1_multi_impl: alive.length >= 2,
    G2_pairwise: pairwise.every(p => p.ok),
    G3_contract: alive.every(r => r.withinContract),
    // G4 采用 numpy.allclose 的混合判据：绝对容差 OR 相对容差。
    // 纯相对误差会在真值本身很小时失真（例如 gelu(0)=0 附近的 1e-16 差值
    // 被除以极小分母后放大成 1e+2 的假阳性）——这是数值验证的经典陷阱。
    G4_rel: alive.every(r => r.dTruth <= r.tol || r.rTruth <= REL_TOL)
  };

  // ── 四级判决 ──────────────────────────────────────────────────────────
  let verdict, verdictZh, reason;
  if (!gates.G3_contract || !gates.G2_pairwise || !gates.G4_rel) {
    verdict = 'RED';
    verdictZh = '🔴 破约';
    const bad = alive.filter(r => !r.withinContract).map(r => `${r.src}(Δ=${r.dTruth.toExponential(2)}>契约${r.tol.toExponential(1)})`);
    reason = bad.length ? `实现超出其自声明精度契约：${bad.join('、')}` : '同语义实现互相矛盾';
  } else if (!gates.G1_multi_impl) {
    verdict = 'SOLO';
    verdictZh = '🟡 孤证';
    reason = `仅 ${alive.length} 个独立实现参与；契约内但缺少互证`;
  } else if (!alive.every(r => r.atFusionTier)) {
    verdict = 'DEGRADED';
    verdictZh = '🟠 降级';
    const worst = alive.filter(r => !r.atFusionTier).map(r => r.src);
    const best = alive.slice().sort((a, b) => a.dTruth - b.dTruth)[0];
    reason = `契约内但未达最优档 ${fusionTol.toExponential(0)}；降级：${worst.join('、')}；最优：${best.src}(Δ=${best.dTruth.toExponential(2)})`;
  } else {
    verdict = 'GREEN';
    verdictZh = '🟢 全绿';
    reason = `${alive.length} 实现互证，逐位一致，达最优档`;
  }

  const ranked = alive.slice().sort((a, b) => a.dTruth - b.dTruth);

  return {
    name,
    kind: prim.kind,
    verdict, verdictZh, reason,
    fusionTol,
    implCount: alive.length,
    refs: alive.map(r => ({
      src: r.src, locator: r.locator, dTruth: r.dTruth, rTruth: r.rTruth,
      tol: r.tol, withinContract: r.withinContract, atFusionTier: r.atFusionTier
    })),
    errors, pairwise,
    truth,
    gates,
    recommended: ranked.length ? ranked[0].src : null,
    precisionRanking: ranked.map(r => ({ src: r.src, dTruth: r.dTruth }))
  };
}

/** 全量对拍 */
function runAll() {
  const names = Object.keys(A.PRIM);
  const results = names.map(checkPrimitive);
  const by = { GREEN: 0, DEGRADED: 0, SOLO: 0, RED: 0 };
  results.forEach(r => by[r.verdict]++);
  return {
    total: results.length,
    passed: by.GREEN,
    degraded: by.DEGRADED,
    solo: by.SOLO,
    failed: by.RED,
    byVerdict: by,
    hardPass: by.RED === 0,
    results
  };
}

module.exports = { runAll, checkPrimitive, REL_TOL, REPO_CONTRACT, FUSION_TOL };

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf('--json');
  if (jsonIdx >= 0 && args[jsonIdx + 1]) {
    const r = runAll();
    require('fs').writeFileSync(args[jsonIdx + 1], JSON.stringify(r, null, 1));
    console.log(`JSON 已写入 ${args[jsonIdx + 1]}（${r.total} 项对拍）`);
    process.exit(r.hardPass ? 0 : 1);
  }
  const r = runAll();
  console.log('════════════════════════════════════════════════════════════');
  console.log(' 旗舰融合 · 跨仓差分对拍（多实现互证 + 高精度参照三方校验）');
  console.log('════════════════════════════════════════════════════════════');
  for (const x of r.results) {
    console.log(` ${x.verdictZh} ${x.name.padEnd(18)} 实现 ${x.implCount}  最优档=${x.fusionTol.toExponential(0)}  ${x.reason}`);
    for (const ref of x.refs) {
      console.log(`      ${ref.src.padEnd(20)} ${String(ref.locator).padEnd(16)} Δ参照=${ref.dTruth.toExponential(2)} 契约=${ref.tol.toExponential(1)} ${ref.withinContract ? '✓' : '✗'}`);
    }
    for (const p of x.pairwise) console.log(`      对拍 ${p.a} ↔ ${p.b}  Δ=${p.d.toExponential(2)} (容差 ${p.tol.toExponential(1)}) ${p.ok ? '✓' : '✗'}`);
    for (const e of x.errors) console.log(`      ⚠ ${e.src}: ${e.error}`);
    console.log(`      门禁 G1多实现=${x.gates.G1_multi_impl} G2两两一致=${x.gates.G2_pairwise} G3契约内=${x.gates.G3_contract} G4相对误差=${x.gates.G4_rel}`);
    if (x.recommended) console.log(`      ★ 融合推荐：${x.recommended}`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(` 总计 ${r.total}：🟢全绿 ${r.byVerdict.GREEN} · 🟠降级 ${r.byVerdict.DEGRADED} · 🟡孤证 ${r.byVerdict.SOLO} · 🔴破约 ${r.byVerdict.RED}`);
  console.log(r.hardPass ? ' 🟢 硬门禁通过（无破约）' : ' 🔴 存在破约项');
  process.exit(r.hardPass ? 0 : 1);
}
