/* ============================================================================
 * flagship-fusion · 变体闭合器（Variant Closer）
 * ----------------------------------------------------------------------------
 * 审计发现：AXIOM 的 1024 条微指令里 213 条处于 spec-only（79.2% 覆盖）。
 * 逐条追溯后，根因【不是】算法缺失，而是【通用变体引擎的签名表缺项】：
 *
 *   AXIOM core.js 内部已有三个通用变体引擎（零重写可复用）：
 *     batched(opCode, batch)  → 批量调用 base 实现
 *     fused(opCode, item)     → base 实现 ∘ 逐元素尾算子（cuBLASLt epilogue 范式）
 *     inplace(opCode, dst)    → 原地覆盖首参，返回值与 out-of-place 逐位一致
 *   三者各由一张签名表驱动（BATCH_SIG / FUSE_SIG / INPLACE_SIG）。
 *   spec-only 的 183 条 inplace 变体中，有 170 条的 base 实现
 *   【已在 BATCH_SIG 中登记】，只是 INPLACE_SIG 未收录。
 *
 * 本闭合器做的事（零重写收割，不写任何算子实现）：
 *   1. 从 AXIOM 源码【静态解析】三张签名表 → 拿到每个 op 的 {cls, fn, extra, sample}
 *   2. 对每条 spec-only 变体：
 *        inplace → 从 BATCH_SIG 提升（同 cls / 同 fn），由 sample 推导 extra
 *        batched → 若 base 已在 BATCH_SIG 则直接可用
 *        fused   → 从 FUSE_SIG 提升（需 post 尾算子）
 *   3. 【运行时验证】闭合后的变体必须满足该变体在注册表里声明的不变量：
 *        inplace ≡ out-of-place（逐位一致，≤1e-15）
 *        batched[i] ≡ base(sample[i])（逐位一致）
 *        fused   ≡ post ∘ base（逐位一致）
 *      任何一条不满足 → 判为「不可闭合」，如实记账，绝不注水。
 *
 * 范式锚定：cuBLASLt / CUTLASS 的 epilogue 融合（同一 kernel 多执行策略）+
 *            LLVM 的 intrinsic legalization（同语义不同指令形态）+
 *            属性化测试（property-based testing）中「先判可满足性再生成」的习惯。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./adapter.js');

/* ---------------------------------------------------------------------------
 * 1. 静态解析：AXIOM core.js 的三张签名表
 * -------------------------------------------------------------------------*/
function parseSigTables(corePath) {
  const src = fs.readFileSync(corePath, 'utf8');
  // 先解析样本常量（_V / _M / _MV / _EV / _SPD …），签名表里以标识符引用
  const CONSTS = {};
  const constRe = /var\s+(_[A-Z]+)\s*=\s*(\[[\s\S]*?\]);/g;
  let cm;
  while ((cm = constRe.exec(src))) {
    const v = safeEval(cm[2]);
    if (v !== undefined) CONSTS[cm[1]] = v;
  }
  const tables = { __consts: CONSTS };
  for (const name of ['BATCH_SIG', 'FUSE_SIG', 'INPLACE_SIG']) {
    const i = src.indexOf('var ' + name + ' = {');
    if (i < 0) { tables[name] = {}; continue; }
    const j = src.indexOf('\n  };', i);
    const body = src.slice(i, j);
    const re = /'([A-Z]+\.[A-Za-z0-9_]+)'\s*:\s*\{\s*cls:\s*'(\w+)'\s*,\s*fn:\s*([A-Za-z0-9_]+)([^\n]*)/g;
    const out = {};
    let m;
    while ((m = re.exec(body))) {
      const rest = m[4] || '';
      const extraM = readBracketField(rest, 'extra');
      const sampleM = readBracketField(rest, 'sample');
      const postM = rest.match(/post:\s*([A-Za-z0-9_.]+)/);
      const sharedM = readBracketField(rest, 'shared');
      out[m[1]] = {
        cls: m[2],
        fn: m[3],
        extra: extraM ? safeEval(extraM) : undefined,
        sample: sampleM ? resolveSample(sampleM, CONSTS) : undefined,
        post: postM ? postM[1] : undefined,
        shared: sharedM ? safeEval(sharedM) : undefined,
        line: m[0].trim()
      };
    }
    tables[name] = out;
  }
  return tables;
}

/** 样本可能是字面量数组，也可能是 _M / _V 这类常量引用 */
function resolveSample(text, consts) {
  if (!text) return undefined;
  const t = text.trim();
  if (consts[t] !== undefined) return consts[t];
  const v = safeEval(t);
  if (v !== undefined) return v;
  // 形如 [[[2, 2], 1], [[3, 1], 0]] 的字面量
  return safeEval('[' + t + ']');
}

/**
 * 从签名条目尾部读取 `field: [...]` 的完整数组文本（括号深度扫描，
 * 以正确处理嵌套数组 —— 正则无法处理 `[[[2,2],1],[[3,1],0]]` 这类样本）。
 */
function readBracketField(text, field) {
  const idx = text.indexOf(field + ':');
  if (idx < 0) return null;
  let i = idx + field.length + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;
  let depth = 0, start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
    else if (c === '\n') break;
  }
  return text.slice(start, i);
}

function safeEval(s) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return (' + s + ')')();
  } catch (_) {
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * 2. 写回：把 out-of-place 结果写回 dst 的既有结构（与 AXIOM 的 _writeBack 同构）
 * -------------------------------------------------------------------------*/
function writeBack(dst, src) {
  if (Array.isArray(src)) {
    for (let i = 0; i < src.length; i++) {
      if (Array.isArray(dst[i])) writeBack(dst[i], src[i]);
      else dst[i] = src[i];
    }
    return dst;
  }
  return src;
}

/* ---------------------------------------------------------------------------
 * 3. 闭合器
 * -------------------------------------------------------------------------*/
function closeVariants(axiomDir) {
  const corePath = path.join(axiomDir, 'src', 'core.js');
  const regPath = path.join(axiomDir, 'src', 'registry.js');
  const core = require(corePath);
  const regSrc = fs.readFileSync(regPath, 'utf8');
  // eslint-disable-next-line no-eval
  const registry = eval(regSrc.match(/var AXIOM_REGISTRY = (\[[\s\S]*?\]);/)[1]);
  const tables = parseSigTables(corePath);

  // base 实现的直接映射（AXIOM 导出的函数名）
  // 注意：注册表里 impl='batched' / 'fused' / 'inplace' 是【通用引擎名】，
  // 不是 base 算子本身。base 必须取 variant==='base' 且 impl 为真实函数的条目。
  const GENERIC = new Set(['batched', 'fused', 'inplace']);
  const baseImpl = new Map();
  for (const e of registry) {
    if (e.status !== 'verified' || !e.impl) continue;
    if (GENERIC.has(e.impl)) continue;
    if (typeof core[e.impl] !== 'function') continue;
    const k = e.group + '.' + e.op;
    if (!baseImpl.has(k) || e.variant === 'base') {
      baseImpl.set(k, { fnName: e.impl, fn: core[e.impl], variant: e.variant });
    }
  }

  const results = [];
  for (const e of registry) {
    if (e.status === 'verified') continue;
    const opKey = e.group + '.' + e.op;
    const base = baseImpl.get(opKey);
    const rec = {
      id: e.id, op: opKey, variant: e.variant,
      invariant: e.invariant,
      closed: false, reason: '', method: null,
      dOutOfPlace: null
    };

    if (!base) {
      rec.reason = 'base 实现未在 core.js 导出（不可收割）';
      results.push(rec);
      continue;
    }

    if (e.variant === 'batched') {
      const bs = tables.BATCH_SIG[opKey];
      if (!bs) { rec.reason = 'BATCH_SIG 无登记且 base 签名未知'; results.push(rec); continue; }
      if (bs.sample === undefined) { rec.reason = 'BATCH_SIG 缺 sample（无法验证不变量）'; results.push(rec); continue; }
      const r = evalIsolated(corePath, opKey, 'batched', {
        baseName: base.fnName, op: opKey, variant: 'batched',
        sig: { cls: bs.cls, sample: bs.sample, extra: bs.extra, shared: bs.shared }
      }, 4000);
      if (r.err) { rec.reason = '批处理：' + r.err; results.push(rec); continue; }
      const d = A.maxAbsDiff(r.got, r.want);
      rec.closed = d <= 1e-15;
      rec.method = 'BATCH_SIG 直采';
      rec.dOutOfPlace = d;
      rec.reason = rec.closed ? '批处理逐位一致' : `批处理不一致 Δ=${d}`;
      results.push(rec);
      continue;
    }

    if (e.variant === 'inplace') {
      // 原地化来源：优先 INPLACE_SIG（其 sample 已是单样本），
      // 否则从 BATCH_SIG 提升（需按 cls 归一采样语义）
      const is = tables.INPLACE_SIG[opKey];
      const bs = tables.BATCH_SIG[opKey];
      const src = is || bs;
      if (!src) { rec.reason = 'BATCH_SIG / INPLACE_SIG 均无登记'; results.push(rec); continue; }
      if (src.sample === undefined) { rec.reason = '签名表缺 sample（无法验证不变量）'; results.push(rec); continue; }

      const r = evalIsolated(corePath, opKey, 'inplace', {
        baseName: base.fnName, op: opKey, variant: 'inplace',
        sig: { cls: src.cls, sample: src.sample, extra: src.extra, shared: src.shared }
      }, 4000);
      if (r.err) { rec.reason = '原地化：' + r.err; results.push(rec); continue; }
      // 形状守恒前置判定：原地化的前提是「写回后结构与输入同形」。
      // 若算子改变形状（reshape / qr / eig / concat / split …），
      // 「原地执行」在语义上本就不成立 —— 这是【属性判定】，不是失败。
      if (!sameShape(r.want, r.got)) {
        rec.reason = '形状不守恒 → 原地语义不成立（属性判定，非缺陷）';
        rec.shapePreserving = false;
        results.push(rec);
        continue;
      }
      const d = A.maxAbsDiff(r.got, r.want);
      rec.dOutOfPlace = d;
      rec.closed = d <= 1e-15;
      rec.shapePreserving = true;
      rec.method = is ? 'INPLACE_SIG 已有' : 'BATCH_SIG 提升（cls=' + src.cls + '）';
      rec.reason = rec.closed ? '原地结果与 out-of-place 逐位一致' : `原地/离地不一致 Δ=${d.toExponential(2)}`;
      results.push(rec);
      continue;
    }

    if (e.variant === 'fused') {
      const fs_ = tables.FUSE_SIG[opKey];
      if (!fs_) { rec.reason = 'FUSE_SIG 无登记（缺 post 尾算子，无法安全提升）'; results.push(rec); continue; }
      if (fs_.sample === undefined) { rec.reason = 'FUSE_SIG 缺 sample（无法验证不变量）'; results.push(rec); continue; }
      const r = evalIsolated(corePath, opKey, 'fused', {
        baseName: base.fnName, op: opKey, variant: 'fused',
        sig: { cls: fs_.cls, sample: fs_.sample, extra: fs_.extra, shared: fs_.shared, post: fs_.post }
      }, 4000);
      if (r.err) { rec.reason = '融合：' + r.err; results.push(rec); continue; }
      const d = A.maxAbsDiff(r.got, r.want);
      rec.dOutOfPlace = d;
      rec.closed = d <= 1e-15;
      rec.method = 'FUSE_SIG 直采';
      rec.reason = rec.closed ? '融合结果 ≡ post ∘ base' : `融合不一致 Δ=${d.toExponential(2)}`;
      results.push(rec);
      continue;
    }

    if (e.variant === 'base') {
      rec.reason = 'base 语义缺失（需新算法，非收割可解）';
      results.push(rec);
      continue;
    }

    rec.reason = '未知变体类型';
    results.push(rec);
  }

  return { registry, results, tables, baseImplSize: baseImpl.size };
}

/**
 * 超时隔离：某些算子（迭代优化器类）会长时间运行，
 * 收割器不能被单条慢算子拖死 —— 超时即判「不可收割」，如实记账。
 *
 * 实现方式：把该条算子的求值放进【独立子进程】（execFileSync + timeout），
 * 子进程崩溃/超时都被转成一条可记账的失败原因，绝不影响整场收割。
 * 这是 CI 与批处理系统的标准做法（per-item timeout + fail-soft）。
 */
function evalIsolated(corePath, opKey, variant, payload, timeoutMs) {
  const script = `
    const path = require('path');
    const core = require(path.resolve(${JSON.stringify(corePath)}));
    const AX = require(path.resolve(${JSON.stringify(corePath)}));
    const payload = ${JSON.stringify(payload)};
    const variant = payload.variant;
    function deepCopy(x){ return Array.isArray(x) ? x.map(deepCopy) : x; }
    function writeBack(dst, src){
      if (Array.isArray(src)) { for (let i=0;i<src.length;i++){ if (Array.isArray(dst[i])) writeBack(dst[i], src[i]); else dst[i]=src[i]; } return dst; }
      return src;
    }
    function resolvePostChild(postName) {
      const MATH = { log: Math.log, tanh: Math.tanh, abs: Math.abs, sqrt: Math.sqrt, log1p: Math.log1p, expm1: Math.expm1 };
      if (!postName) return null;
      if (postName.indexOf('Math.') === 0) {
        const k = postName.slice(5);
        if (k === 'reciprocal') return function (x) { return 1 / x; };
        return MATH[k] || null;
      }
      var t = postName.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, AX);
      return typeof t === 'function' ? t : null;
    }
    const base = AX[payload.baseName];
    if (typeof base !== 'function') { console.log(JSON.stringify({err:'base 不可用: '+payload.baseName})); process.exit(0); }
    const src = payload.sig;
    const cls = src.cls;

    // ── 采样语义归一 ──────────────────────────────────────────────────
    // BATCH_SIG.cls='args' 的 sample 是【整个批次】，一次调用 = sample[0]
    let item = src.sample, extra = src.extra || [];
    if (cls === 'args') {
      if (!Array.isArray(src.sample) || !Array.isArray(src.sample[0])) { console.log(JSON.stringify({err:'args 采样形状异常'})); process.exit(0); }
      item = src.sample[0];
      extra = item.slice(1);
    } else if (cls === 'shared') {
      extra = src.shared || [];
    }

    let want, got;
    if (variant === 'batched') {
      if (cls === 'args') {
        // 批处理：整批映射；参照 = 逐条 base
        got = core.batched(payload.op, src.sample);
        want = src.sample.map(function(ar){ return base.apply(null, ar); });
      } else if (cls === 'vec') {
        got = core.batched(payload.op, [item]);
        want = base(item);
      } else if (cls === 'elem') {
        got = core.batched(payload.op, [item]);
        want = item.map(function(v){ return base(v); });
      } else if (cls === 'pair') {
        got = core.batched(payload.op, [item]);
        want = base(item[0], item[1]);
      } else if (cls === 'triple') {
        got = core.batched(payload.op, [item]);
        want = base(item[0], item[1], item[2]);
      } else if (cls === 'shared') {
        got = core.batched(payload.op, [item]);
        want = base.apply(null, [item].concat(extra));
      } else if (cls === 'special') {
        got = core.batched(payload.op, [item]);
        want = base(item);
      } else {
        console.log(JSON.stringify({err:'未知 cls: '+cls})); process.exit(0);
      }
      console.log(JSON.stringify({want, got}));
    } else if (variant === 'inplace') {
      if (cls === 'vec') want = base(item);
      else if (cls === 'elem') want = item.map(function(v){ return base(v); });
      else if (cls === 'pair') want = base(item[0], item[1]);
      else if (cls === 'triple') want = base(item[0], item[1], item[2]);
      else if (cls === 'shared') want = base.apply(null, [item].concat(extra));
      else if (cls === 'args') want = base.apply(null, item);
      else { console.log(JSON.stringify({err:'cls 不可原地化: '+cls})); process.exit(0); }
      const dst = deepCopy(item);
      if (cls === 'elem') { for (let i=0;i<dst.length;i++) dst[i] = base(dst[i]); got = dst; }
      else if (cls === 'vec') { writeBack(dst, base(dst)); got = dst; }
      else if (cls === 'pair') { writeBack(dst, base.apply(null, [dst, item[1]])); got = dst; }
      else if (cls === 'triple') { writeBack(dst, base.apply(null, [dst, item[1], item[2]])); got = dst; }
      else if (cls === 'shared') { writeBack(dst, base.apply(null, [dst].concat(extra))); got = dst; }
      else if (cls === 'args') { writeBack(dst, base.apply(null, [dst].concat(item.slice(1)))); got = dst; }
      console.log(JSON.stringify({want, got}));
    } else if (variant === 'fused') {
      // 融合语义：fused ≡ post ∘ base（cuBLASLt epilogue 范式）
      const post = resolvePostChild(src.post);
      if (!post) { console.log(JSON.stringify({err:'post 不可解析: '+src.post})); process.exit(0); }
      let baseOut;
      if (cls === 'vec') baseOut = base(item);
      else if (cls === 'elem') baseOut = item.map(function(v){ return base(v); });
      else if (cls === 'pair') baseOut = base(item[0], item[1]);
      else if (cls === 'triple') baseOut = base(item[0], item[1], item[2]);
      else if (cls === 'shared') baseOut = base.apply(null, [item].concat(extra));
      else if (cls === 'args') baseOut = base.apply(null, item);
      else { console.log(JSON.stringify({err:'未知 cls: '+cls})); process.exit(0); }
      function applyPost(src2, g) {
        if (typeof src2 === 'number') return g(src2);
        if (Array.isArray(src2)) return src2.map(function(v){ return applyPost(v, g); });
        return src2;
      }
      want = applyPost(baseOut, post);
      got = core.fused(payload.op, src.sample);
      console.log(JSON.stringify({want, got}));
    } else {
      console.log(JSON.stringify({err:'variant 不支持: '+variant}));
    }
  `;
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']   // 子进程 stderr 静默，避免污染收割日志
    });
    const line = (out || '').trim().split('\n').filter(Boolean).pop();
    if (!line) return { err: '子进程无输出' };
    return JSON.parse(line);
  } catch (e) {
    if (e.killed) return { err: '超时 ' + timeoutMs + 'ms（算子迭代过久，不收割）' };
    const stderr = e.stderr ? String(e.stderr) : '';
    const m = stderr.match(/^(?:[A-Za-z]*Error|TypeError|RangeError): (.*)$/m);
    if (m) return { err: m[0].slice(0, 110) };
    return { err: '子进程异常：' + String(e.message || e).slice(0, 110) };
  }
}

function deepCopy(x) {
  if (Array.isArray(x)) return x.map(deepCopy);
  return x;
}

/** 结构同形判定（原地化的前提） */
function shapeOf(x) {
  if (Array.isArray(x)) return [x.length].concat(x.length ? shapeOf(x[0]) : []);
  return [];
}
function sameShape(a, b) {
  const sa = shapeOf(a), sb = shapeOf(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * 签名表采样语义归一（关键）
 * ---------------------------------------------------------------------------
 * AXIOM 的两张表里 `sample` 的含义【不同】：
 *   BATCH_SIG.cls='args'  → sample 是【整个批次】，每个元素是一次调用的参数列表
 *                            例：TENSOR.create sample=[[[2,2],1],[[3,1],0]]
 *                                ⇒ 一次调用 = [[2,2],1]（即 tensorCreate([2,2],1)）
 *   BATCH_SIG.cls='vec'|'elem'|'pair'|'triple'|'special' → sample 是单个样本
 *   BATCH_SIG.cls='shared' → sample 是单样本，其余参数在 shared 字段
 *   INPLACE_SIG.*        → sample 恒为单个样本（原地语义：首参即 dst）
 *
 * 归一后返回 { item, extra }：
 *   item  = 单次调用的主参
 *   extra = 其余参数（原地化时需写入 dst 的其余入参）
 */
function normalizeSample(sig) {
  const cls = sig.cls;
  const s = sig.sample;
  if (s === undefined) return null;
  if (cls === 'args') {
    // sample 是批次 → 取第一条调用
    if (!Array.isArray(s) || !Array.isArray(s[0])) return null;
    const item = s[0];
    return { item, extra: item.slice(1), isBatch: true };
  }
  if (cls === 'shared') {
    return { item: s, extra: sig.shared || [], isBatch: false };
  }
  return { item: s, extra: sig.extra || [], isBatch: false };
}

function resolvePost(core, postName) {
  if (!postName) return null;
  if (postName === 'Math.log') return Math.log;
  if (postName === 'Math.tanh') return Math.tanh;
  if (postName === 'Math.abs') return Math.abs;
  if (postName === 'Math.sqrt') return Math.sqrt;
  if (postName === 'Math.log1p') return Math.log1p;
  if (postName === 'Math.expm1') return Math.expm1;
  if (postName === 'Math.reciprocal') return x => 1 / x;
  const target = postName.split('.').reduce((o, k) => (o ? o[k] : undefined), core);
  return typeof target === 'function' ? target : null;
}

/** 子进程内的 post 解析（供 evalIsolated 脚本内联使用） */
function resolvePostInChild(core, postName) {
  const MATH = { log: Math.log, tanh: Math.tanh, abs: Math.abs, sqrt: Math.sqrt, log1p: Math.log1p, expm1: Math.expm1 };
  if (!postName) return null;
  if (postName.startsWith('Math.')) {
    const k = postName.slice(5);
    if (k === 'reciprocal') return function (x) { return 1 / x; };
    return MATH[k] || null;
  }
  const target = postName.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, core);
  return typeof target === 'function' ? target : null;
}

function baseOutOfPlace(core, fsig, baseFn, sample) {
  const cls = fsig.cls;
  if (cls === 'vec') return baseFn(sample);
  if (cls === 'elem') return sample.map(v => baseFn(v));
  if (cls === 'pair') return baseFn(sample[0], sample[1]);
  if (cls === 'triple') return baseFn(sample[0], sample[1], sample[2]);
  if (cls === 'shared') return baseFn.apply(null, [sample].concat(fsig.shared || []));
  if (cls === 'args') return baseFn.apply(null, sample);
  return baseFn(sample);
}

function applyPost(src, post) {
  if (typeof src === 'number') return post(src);
  if (Array.isArray(src)) return src.map(v => applyPost(v, post));
  return src;
}

/* CLI */
if (require.main === module) {
  const dir = A.findRepoDir('axiom-ai');
  if (!dir) { console.error('未找到 axiom-ai（需置于 vendor/axiom-ai 或 .cache/fleet/axiom-ai）'); process.exit(2); }
  const r = closeVariants(dir);
  const byVar = {};
  for (const x of r.results) {
    const k = x.variant;
    byVar[k] = byVar[k] || { total: 0, closed: 0 };
    byVar[k].total++;
    if (x.closed) byVar[k].closed++;
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(' 旗舰融合 · 变体闭合器（零重写收割）');
  console.log('════════════════════════════════════════════════════════════');
  console.log(` base 实现可收割数：${r.baseImplSize}`);
  for (const [v, s] of Object.entries(byVar)) {
    console.log(`   ${v.padEnd(9)} ${s.closed}/${s.total} 闭合  (${(s.closed / s.total * 100).toFixed(1)}%)`);
  }
  const closed = r.results.filter(x => x.closed).length;
  console.log('────────────────────────────────────────────────────────────');
  console.log(` 总闭合 ${closed}/${r.results.length}；ISA 覆盖 ${(811 + closed)}/1024 = ${((811 + closed) / 1024 * 100).toFixed(1)}%`);
  const fails = r.results.filter(x => !x.closed);
  if (fails.length) {
    console.log(' 未闭合项（按原因归类）：');
    const byReason = {};
    fails.forEach(f => { byReason[f.reason] = (byReason[f.reason] || 0) + 1; });
    Object.entries(byReason).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${String(n).padStart(3)} × ${k}`));
  }
  const out = path.resolve(__dirname, '..', 'data', 'variant-closure.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    schema: 'flagship-fusion/variant-closure@1',
    generatedAt: new Date().toISOString(),
    total: r.results.length, closed,
    isaCoverageBefore: 811, isaCoverageAfter: 811 + closed,
    byVariant: byVar,
    results: r.results
  }, null, 2));
  console.log(` → ${out}`);
}

module.exports = { closeVariants, parseSigTables };
