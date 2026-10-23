/* ============================================================================
 * flagship-fusion · 适配层（Adapter Layer）
 * ----------------------------------------------------------------------------
 * 零重写宣言：本文件【不实现任何算法】。
 * 301 个仓库已经各自实现了 matmul / softmax / gelu / layernorm / adam ……
 * 若再写一遍，既是重复造轮子，也无法证明任何东西。
 * 本层唯一职责：把 6 座旗舰仓【已经写好的】函数，用薄适配器归一为同一契约，
 * 使「跨仓对拍」（differential.js）可以对它们逐位比较。
 *
 * ★ 语义签名（Semantic Signature）—— 本层最关键的设计
 *   对拍发现：同名函数在不同仓可能【语义不同】，不是 bug，是约定不同：
 *     gelu          → flagship-ai 用 tanh 近似；axiom-ai 用精确 erf；engine 用 erfc
 *     crossEntropy  → axiom-ai 用 log2（bits）；engine 用 log（nats）
 *     layerNorm     → axiom-ai 按行；engine 对展平向量；flagship-ai 显式 (r,c)
 *   若不加语义签名地硬对拍，会把「约定差异」误报成「实现错误」；
 *   若一概按「同名即同义」放行，真正的错误反而被吞掉。
 *   本层引入 variant 轴：{op, variant} 才是对拍的最小可比单元。
 *
 * 设计范式锚定：
 *   - Adapter Pattern（GoF 1994）：把不兼容的接口转为统一接口
 *   - Operator-set 语义版本化（ONNX / StableHLO）：同名不同义必须显式区分
 *   - Algebraic Law Cross-Check：不同实现若满足同一定律 → 必须逐位一致
 * ==========================================================================*/
'use strict';

/* ---------------------------------------------------------------------------
 * 1. 仓目录发现：优先 submodule 路径，其次本地 .cache/fleet 快照
 * -------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');

const REPO_ROOTS = [
  path.resolve(__dirname, '..', 'vendor'),           // git submodule 落点（发布态）
  path.resolve(__dirname, '..', '..', '.cache', 'fleet') // 本地舰队快照（开发态）
];

function findRepoDir(name) {
  for (const root of REPO_ROOTS) {
    const p = path.join(root, name);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 2. 仓库加载器：懒加载 + 失败即跳过（绝不因单仓故障拖垮整场对拍）
 * -------------------------------------------------------------------------*/
const _cache = new Map();

function loadRepo(name, entry) {
  if (_cache.has(name)) return _cache.get(name);
  let mod = null;
  const dir = findRepoDir(name);
  if (dir && entry) {
    const p = path.join(dir, entry);
    if (fs.existsSync(p)) {
      try {
        delete require.cache[require.resolve(p)];
        mod = require(p);
      } catch (e) {
        mod = { __error: String(e && e.message || e) };
      }
    }
  }
  _cache.set(name, mod);
  return mod;
}

/* ---------------------------------------------------------------------------
 * 3. 数值工具
 * -------------------------------------------------------------------------*/
function flatten(x, out) {
  out = out || [];
  if (Array.isArray(x)) { for (const v of x) flatten(v, out); }
  else if (typeof x === 'number') out.push(x);
  else if (x && typeof x.length === 'number' && typeof x !== 'string') { for (let i = 0; i < x.length; i++) flatten(x[i], out); }
  return out;
}

function maxAbsDiff(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const n = Math.min(fa.length, fb.length);
  let m = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(fa[i] - fb[i]); if (d > m) m = d; }
  if (fa.length !== fb.length) m = Infinity;
  return m;
}

function maxRelErr(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const n = Math.min(fa.length, fb.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(fa[i] - fb[i]);
    const s = Math.abs(fa[i]) + Math.abs(fb[i]) + 1e-12;
    const r = d / s;
    if (r > m) m = r;
  }
  return m;
}

/* ---------------------------------------------------------------------------
 * 4. 高精度解析参照（Ground Truth）
 *    erf 用 Maclaurin 级数（精度 ≈1e-16），而非 A&S 7.1.26 近似（≈1.5e-7），
 *    以免参照本身的误差污染 1e-15 级门禁。
 * -------------------------------------------------------------------------*/
function erfPrecise(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a > 6) return sign;
  let term = a, sum = 0;
  for (let n = 0; n < 120; n++) {
    const add = term / (2 * n + 1);
    sum += (n % 2 === 0 ? add : -add);
    term *= a * a / (n + 1);
    if (term < 1e-20) break;
  }
  return sign * 2 * sum / Math.sqrt(Math.PI);
}

/* ---------------------------------------------------------------------------
 * 5. 各仓原语定位表 —— 全部指向【已存在的函数】，无一新增实现
 * -------------------------------------------------------------------------*/
const SOURCES = {
  'flagship-ai': {
    repo: 'flagship-ai',
    entry: 'src/index.js',
    locators: {
      'matmul': 'matmul',
      'softmax': 'softmaxRows',
      'gelu.tanh': 'geluFwd',
      'layernorm.row': 'layernormFwd',
      'crossEntropy.logits': 'crossEntropy',
      'rmsnorm.row': 'rmsnormFwd'
    }
  },
  'axiom-ai': {
    repo: 'axiom-ai',
    entry: 'src/core.js',
    locators: {
      'matmul': 'matMul',
      'softmax': 'softmax',
      'gelu.erf': 'gelu',
      'relu': 'relu',
      'layernorm.row': 'layerNorm',
      'logsumexp': 'logsumexp',
      'crossEntropy.bits': 'crossEntropy'
    }
  },
  'ai-forge': {
    repo: 'ai-forge',
    entry: 'src/index.js',
    locators: {
      'matmul': 'matmul',
      'softmax': 'softmax',
      'gelu.erf': 'gelu',
      'relu': 'relu',
      'logsumexp': 'logsumexp',
      'crossEntropy.logits': 'crossEntropy'
    }
  },
  'ai-forge-core': {
    repo: 'ai-forge-core',
    entry: 'src/ai-forge.js',
    locators: {
      'matmul': 'matmul',
      'softmax': 'softmaxRows',
      'adam.step': 'adam'
    }
  },
  'flagship-ai-engine': {
    repo: 'flagship-ai-engine',
    entry: 'src/index.js',
    locators: {
      'matmul': 'matmul',
      'softmax': 'softmax',
      'gelu.erf': 'gelu',
      'relu': 'relu',
      'layernorm.flat': 'layerNorm',
      'logsumexp': 'logsumexp',
      'crossEntropy.nat': 'crossEntropy',
      'adam.step': 'adamStep'
    }
  },
  'flagship-algo-forge': {
    repo: 'flagship-algo-forge',
    entry: 'apex-forge.js',
    locators: {
      'gelu.erf': 'Act.gelu',
      'softmax': 'Act.softmax'
    }
  }
};

/* ---------------------------------------------------------------------------
 * 6. 统一契约原语定义
 *    key 格式：op 或 op.variant。variant 缺省即该 op 的唯一语义。
 * -------------------------------------------------------------------------*/
const PRIM = {
  /* ---- matmul：2×3 · 3×2 = 2×2 ---- */
  matmul: {
    kind: 'matrix',
    input: () => [[[1, 2, 3], [4, 5, 6]], [[1, 0], [0, 1], [1, 1]]],
    apply: {
      'flagship-ai': (mod, inp) => {
        const A = Float64Array.from(inp[0].flat()), B = Float64Array.from(inp[1].flat());
        const C = mod.matmul(A, B, inp[0].length, inp[0][0].length, inp[1][0].length);
        const out = [];
        for (let i = 0; i < inp[0].length; i++) out.push(Array.from(C.slice(i * inp[1][0].length, (i + 1) * inp[1][0].length)));
        return out;
      },
      'axiom-ai': (mod, inp) => mod.matMul(inp[0], inp[1]),
      'ai-forge': (mod, inp) => {
        const A = mod.tensor(inp[0].flat(), [inp[0].length, inp[0][0].length]);
        const B = mod.tensor(inp[1].flat(), [inp[1].length, inp[1][0].length]);
        const C = mod.matmul(A, B);
        const r = inp[0].length, c = inp[1][0].length;
        const out = [];
        for (let i = 0; i < r; i++) out.push(Array.from(C.data.slice(i * c, (i + 1) * c)));
        return out;
      },
      'ai-forge-core': (mod, inp) => mod.matmul(inp[0], inp[1]),
      'flagship-ai-engine': (mod, inp) => mod.matmul(inp[0], inp[1])
    }
  },

  /* ---- softmax：长度 5 概率归一 ---- */
  softmax: {
    kind: 'vector',
    input: () => [0.3, -1.2, 2.0, 0.5, 1.1],
    apply: {
      'flagship-ai': (mod, x) => Array.from(mod.softmaxRows(Float64Array.from(x), 1, x.length)),
      'axiom-ai': (mod, x) => mod.softmax(x),
      'ai-forge': (mod, x) => Array.from(mod.softmax(mod.tensor(x, [x.length])).data),
      'ai-forge-core': (mod, x) => mod.softmaxRows([x])[0],
      'flagship-ai-engine': (mod, x) => mod.softmax(x),
      'flagship-algo-forge': (mod, x) => mod.Act.softmax(x)
    }
  },

  /* ---- gelu.erf：精确 erf 形式（数学真值唯一） ---- */
  'gelu.erf': {
    kind: 'vector',
    input: () => [-2.5, -0.7, 0.0, 0.3, 1.1, 2.7],
    apply: {
      'axiom-ai': (mod, x) => x.map(v => mod.gelu(v)),
      'ai-forge': (mod, x) => x.map(v => mod.gelu(v)),
      'flagship-ai-engine': (mod, x) => x.map(v => mod.gelu(v)),
      'flagship-algo-forge': (mod, x) => x.map(v => mod.Act.gelu(v))
    }
  },

  /* ---- gelu.tanh：tanh 近似（GPT-2 配方）—— 语义与 erf 不同，单列一组 ---- */
  'gelu.tanh': {
    kind: 'vector',
    input: () => [-2.5, -0.7, 0.0, 0.3, 1.1, 2.7],
    apply: {
      'flagship-ai': (mod, x) => Array.from(mod.geluFwd(Float64Array.from(x)))
    }
  },

  /* ---- relu：分段线性，必须逐位精确 ---- */
  relu: {
    kind: 'vector',
    input: () => [-2.5, -0.7, 0.0, 0.3, 1.1, 2.7],
    apply: {
      'axiom-ai': (mod, x) => x.map(v => mod.relu(v)),
      'ai-forge': (mod, x) => Array.from(mod.relu(mod.tensor(x, [x.length])).data),
      'flagship-ai-engine': (mod, x) => x.map(v => mod.relu(v))
    }
  },

  /* ---- layernorm.row：逐行归一（2 行 × 4 列） ---- */
  'layernorm.row': {
    kind: 'matrix',
    input: () => [[1.0, 2.0, 3.0, 4.0], [-2.0, 0.5, 1.5, 3.0]],
    apply: {
      'flagship-ai': (mod, inp) => {
        const r = inp.length, c = inp[0].length;
        const X = Float64Array.from(inp.flat());
        const g = new Float64Array(c).fill(1), b = new Float64Array(c).fill(0);
        const res = mod.layernormFwd(X, g, b, r, c);
        const Y = res && res.Y ? res.Y : res;   // flagship-ai 返回 {Y, xhat, rstd}
        const out = [];
        for (let i = 0; i < r; i++) out.push(Array.from(Y.slice(i * c, (i + 1) * c)));
        return out;
      },
      'axiom-ai': (mod, inp) => mod.layerNorm(inp)
    }
  },

  /* ---- layernorm.flat：对展平向量整体归一（engine 语义） ---- */
  'layernorm.flat': {
    kind: 'vector',
    input: () => [1.0, 2.0, 3.0, 4.0, -2.0, 0.5, 1.5, 3.0],
    apply: {
      'flagship-ai-engine': (mod, x) => mod.layerNorm(x)
    }
  },

  /* ---- logsumexp：数值稳定版 ---- */
  logsumexp: {
    kind: 'vector',
    input: () => [0.3, -1.2, 2.0, 0.5, 1.1],
    apply: {
      'axiom-ai': (mod, x) => mod.logsumexp(x),
      'ai-forge': (mod, x) => mod.logsumexp(Float64Array.from(x)),
      'flagship-ai-engine': (mod, x) => mod.logsumexp(x)
    }
  },

  /* ---- crossEntropy.bits：以 2 为底（axiom-ai 语义，单位 bits） ---- */
  'crossEntropy.bits': {
    kind: 'vector',
    input: () => [0.5, 0.2, 0.2, 0.1],
    apply: {
      'axiom-ai': (mod, p) => mod.crossEntropy(p, [0.4, 0.3, 0.2, 0.1])
    }
  },

  /* ---- crossEntropy.nat：以 e 为底（engine 语义，单位 nats） ---- */
  'crossEntropy.nat': {
    kind: 'vector',
    input: () => [0.5, 0.2, 0.2, 0.1],
    apply: {
      'flagship-ai-engine': (mod, p) => mod.crossEntropy(p, [0.4, 0.3, 0.2, 0.1])
    }
  },

  /* ---- adam.step：单步 Adam 更新（x, g, state, t）→ 新 x ---- */
  'adam.step': {
    kind: 'vector',
    input: () => ({ x: [1.0, -2.0, 0.5], g: [0.1, -0.3, 0.2], t: 1 }),
    apply: {
      'flagship-ai-engine': (mod, inp) => mod.adamStep(inp.x, inp.g, {}, inp.t).x,
      'ai-forge-core': (mod, inp) => {
        const params = inp.x.slice();
        const state = {};
        mod.adam(params, inp.g, state, 0.01, 0.9, 0.999, 1e-8);
        return params;
      }
    }
  },

  /* ---- crossEntropy.logits：从 logits 与 one-hot 目标算平均 CE（nats） ---- */
  'crossEntropy.logits': {
    kind: 'matrix',
    input: () => [[[1.0, 2.0, 0.5], [0.2, -1.0, 3.0]], [2, 0]],
    apply: {
      'flagship-ai': (mod, inp) => {
        const [logits, targets] = inp;
        const T = logits.length, V = logits[0].length;
        const flat = Float64Array.from(logits.flat());
        const res = mod.crossEntropy(flat, targets, T, V);
        return res && res.loss != null ? res.loss : res;
      },
      'ai-forge': (mod, inp) => {
        const [logits, targets] = inp;
        const T = logits.length, V = logits[0].length;
        const L = mod.tensor(logits.flat(), [T, V]);
        return [mod.crossEntropy(L, targets).data[0]];
      }
    }
  },

  /* ---- rmsnorm.row：均方根归一（无中心化） ---- */
  'rmsnorm.row': {
    kind: 'matrix',
    input: () => [[1.0, 2.0, 3.0, 4.0], [-2.0, 0.5, 1.5, 3.0]],
    apply: {
      'flagship-ai': (mod, inp) => {
        const r = inp.length, c = inp[0].length;
        const X = Float64Array.from(inp.flat());
        const g = new Float64Array(c).fill(1), b = new Float64Array(c).fill(0);
        const res = mod.rmsnormFwd(X, g, b, r, c);
        const Y = res && res.Y ? res.Y : res;
        const out = [];
        for (let i = 0; i < r; i++) out.push(Array.from(Y.slice(i * c, (i + 1) * c)));
        return out;
      }
    }
  }
};

/* ---------------------------------------------------------------------------
 * 7. 解析参照（Ground Truth）—— 每个 (op,variant) 的独立真值
 * -------------------------------------------------------------------------*/
const ANALYTIC = {
  matmul: (inp) => {
    const [A, B] = inp;
    return A.map(row => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  },
  softmax: (x) => {
    const mx = Math.max(...x);
    const e = x.map(v => Math.exp(v - mx));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map(v => v / s);
  },
  'gelu.erf': (x) => x.map(v => 0.5 * v * (1 + erfPrecise(v / Math.SQRT2))),
  'gelu.tanh': (x) => x.map(v => 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v * v * v)))),
  relu: (x) => x.map(v => (v > 0 ? v : 0)),
  'layernorm.row': (inp) => inp.map(row => {
    const mu = row.reduce((a, b) => a + b, 0) / row.length;
    const varc = row.reduce((a, b) => a + (b - mu) * (b - mu), 0) / row.length;
    const inv = 1 / Math.sqrt(varc + 1e-5);
    return row.map(v => (v - mu) * inv);
  }),
  'layernorm.flat': (x) => {
    const mu = x.reduce((a, b) => a + b, 0) / x.length;
    const varc = x.reduce((a, b) => a + (b - mu) * (b - mu), 0) / x.length;
    const inv = 1 / Math.sqrt(varc + 1e-5);
    return x.map(v => (v - mu) * inv);
  },
  logsumexp: (x) => {
    const mx = Math.max(...x);
    return mx + Math.log(x.reduce((a, v) => a + Math.exp(v - mx), 0));
  },
  'crossEntropy.bits': (p) => p.reduce((h, v, i) => (v > 0 ? h - v * Math.log2([0.4, 0.3, 0.2, 0.1][i]) : h), 0),
  'crossEntropy.nat': (p) => p.reduce((h, v, i) => (v > 0 ? h - v * Math.log([0.4, 0.3, 0.2, 0.1][i]) : h), 0),
  'adam.step': (inp) => {
    const lr = 0.01, b1 = 0.9, b2 = 0.999, eps = 1e-8, t = inp.t;
    const m = inp.g.map(v => (1 - b1) * v);
    const v = inp.g.map(g => (1 - b2) * g * g);
    return inp.x.map((xi, i) => {
      const mh = m[i] / (1 - Math.pow(b1, t));
      const vh = v[i] / (1 - Math.pow(b2, t));
      return xi - lr * mh / (Math.sqrt(vh) + eps);
    });
  },
  'crossEntropy.logits': (inp) => {
    const [logits, targets] = inp;
    const T = logits.length;
    let loss = 0;
    for (let t = 0; t < T; t++) {
      const row = logits[t];
      const mx = Math.max(...row);
      const lse = mx + Math.log(row.reduce((a, v) => a + Math.exp(v - mx), 0));
      loss += lse - row[targets[t]];
    }
    return [loss / T];
  },
  'rmsnorm.row': (inp) => inp.map(row => {
    const ms = row.reduce((a, b) => a + b * b, 0) / row.length;
    const inv = 1 / Math.sqrt(ms + 1e-5);
    return row.map(v => v * inv);
  })
};

/* ---------------------------------------------------------------------------
 * 8. 契约导出
 * -------------------------------------------------------------------------*/
module.exports = {
  SOURCES, PRIM, ANALYTIC,
  findRepoDir, loadRepo, maxAbsDiff, maxRelErr, flatten, erfPrecise
};
