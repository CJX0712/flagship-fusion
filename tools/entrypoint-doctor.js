#!/usr/bin/env node
/**
 * entrypoint-doctor.js —— 自检入口医生（Curated Override 表的生成器）
 * ----------------------------------------------------------------------------
 * 问题背景：
 *   舰队各仓的自检入口分两代写法：
 *     (a) 老写法：_smoke.js 等垫片从 index.html 正则抠 <script id="engine"> 内联引擎
 *     (b) 新写法：引擎拆为独立 UMD 文件，自带 require.main === module 自检入口
 *   当仓从 (a) 迁到 (b) 却没更新垫片时，垫片的正则恒返回 null 而崩溃 ——
 *   这不是算法缺陷，是打包不一致。transformer-forge 即属此类（已实证 8/8 全绿）。
 *
 * 本工具做的事（零重写：只诊断 + 提议，不修改任何仓）：
 *   1. 找出所有「探测到的入口属于垫片家族」的仓
 *   2. 实跑该垫片；失败的，枚举仓内所有含 require.main === module 的根 .js
 *   3. 逐个实跑候选，记录哪个真能自检通过
 *   4. 汇总为一份【待审覆盖表】（--emit 落盘），由人确认后才进 overrides.json
 *
 * 设计原则：
 *   - 提议 ≠ 生效：生成的是候选，必须人工/显式确认才写入 data/entrypoint-overrides.json
 *   - 如实记账：垫片能跑就不动；跑不了又有替代的，明确标注「替代入口」与实测战绩
 *   - 全部实跑：不靠猜，每个结论都有退出码与输出背书
 *
 * 用法：
 *   node tools/entrypoint-doctor.js            # 诊断并打印
 *   node tools/entrypoint-doctor.js --emit     # 额外写出 data/proposed-overrides.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FLEET = process.env.FUSION_FLEET || path.join(ROOT, '..', '.cache', 'fleet');

const SHIM_FILES = ['_smoke.js', '_probe.js', '_uicheck.js'];
// 垫片超时与 fleet-verify.js 的 TIMEOUT_MS 对齐（150s）。
// 实测依据：kalman-forge（204 项）与 spectral-forge（33 项）在 45s 预算下会超时，
// 但在 150s 下分别 ALL GREEN —— 它们是【慢】而不是【坏】。预算不一致会把慢仓误判成坏仓。
const SHIM_TIMEOUT = Number(process.env.DOCTOR_SHIM_TIMEOUT_MS || 150000);
const CAND_TIMEOUT = Number(process.env.DOCTOR_CAND_TIMEOUT_MS || 150000);

function run(dir, file, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], {
    cwd: dir, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' })
  });
  const out = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => l.trim());
  return {
    status: r.error && r.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : (r.status === 0 ? 'OK' : 'FAIL'),
    code: r.status,
    ms: Date.now() - t0,
    lines: out,
    tail: out.slice(-4).join(' | ').slice(0, 200)
  };
}

/** 仓内根目录含 require.main === module 的 .js（排除垫片与 bench） */
function candidateEntries(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    if (SHIM_FILES.includes(f)) continue;
    if (/^bench/.test(f)) continue;
    try {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/require\.main\s*===\s*module/.test(src)) out.push(f);
    } catch (_) { /* 忽略不可读文件 */ }
  }
  // 大文件优先：自检通常写在主库里，共享依赖库一般较小且无自检
  return out.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a)).size, sb = fs.statSync(path.join(dir, b)).size;
    return sb - sa;
  });
}

function hasSelfTestOutput(res) {
  const text = res.lines.join('\n');
  // 覆盖各仓自检输出的写法：
  //   中文：结果 / 全绿 / 全部通过 / 通过 N/N
  //   英文：ALL GREEN / ALL PASS / PASS N / N passed
  //   计分：SUMMARY: 8/8 · 结果：8/8 · PASS 204 / 204 · 8/8 全绿
  // 已由调用方保证 status === 'OK'，故此处只需确认输出里确有「自检计分」的痕迹，
  // 避免把「静默退出 0」误判成自检通过。
  return /(ALL GREEN|ALL PASS|全绿|全部通过|SUMMARY|结果|通过\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|PASS\s+\d+\s*\/|\d+\s+passed)/i.test(text);
}

function main() {
  if (!fs.existsSync(FLEET)) {
    console.error('未找到舰队目录：' + FLEET);
    process.exit(2);
  }
  const repos = fs.readdirSync(FLEET, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .filter(name => SHIM_FILES.some(f => fs.existsSync(path.join(FLEET, name, f))))
    .sort();

  console.log('══════════════════════════════════════════════════════════');
  console.log(' 自检入口医生 · Entrypoint Doctor');
  console.log('══════════════════════════════════════════════════════════');
  console.log(` 舰队目录：${FLEET}`);
  console.log(` 垫片家族仓：${repos.length} 个`);
  console.log('──────────────────────────────────────────────────────────');

  const report = [];
  for (const name of repos) {
    const dir = path.join(FLEET, name);
    // 该仓探测入口会是哪个垫片？（与 fleet-verify 的 CANDIDATES 顺序一致）
    const shim = SHIM_FILES.find(f => fs.existsSync(path.join(dir, f)));
    const primary = run(dir, shim, SHIM_TIMEOUT);

    if (primary.status === 'OK' && hasSelfTestOutput(primary)) {
      report.push({ name, shim, shimStatus: 'OK', broken: false, alternative: null });
      console.log(` ✅ ${name.padEnd(30)} ${shim} 正常`);
      continue;
    }

    // 垫片不可用 → 寻找替代入口
    const cands = candidateEntries(dir);
    let found = null;
    for (const c of cands) {
      const r = run(dir, c, CAND_TIMEOUT);
      if (r.status === 'OK' && hasSelfTestOutput(r)) { found = { file: c, ms: r.ms, tail: r.tail }; break; }
    }
    report.push({
      name, shim, shimStatus: primary.status, broken: true,
      shimTail: primary.tail,
      alternative: found,
      triedCandidates: cands.length
    });
    console.log(` ❌ ${name.padEnd(30)} ${shim} 不可用（${primary.status}）` +
      (found ? `\n     → 替代入口 node ${found.file} ✅ (${(found.ms / 1000).toFixed(1)}s) ${found.tail}`
             : `\n     → 无可用替代（已试 ${cands.length} 个候选）`));
  }

  const broken = report.filter(r => r.broken);
  const fixable = broken.filter(r => r.alternative);
  console.log('──────────────────────────────────────────────────────────');
  console.log(` 汇总：垫片正常 ${report.length - broken.length} · 垫片损坏 ${broken.length} · 其中可重定向 ${fixable.length} · 无解 ${broken.length - fixable.length}`);

  if (process.argv.includes('--emit')) {
    const proposed = {
      _doc: [
        '由 tools/entrypoint-doctor.js --emit 自动生成的【待审覆盖表】。',
        '⚠️ 这是候选，不是生效配置。确认每条后，手动合并进 data/entrypoint-overrides.json 的 entry 段。',
        '生成时间：' + new Date().toISOString()
      ],
      entry: {}
    };
    for (const r of fixable) {
      proposed.entry[r.name] = {
        cmd: 'node',
        args: [r.alternative.file],
        reason: `垫片 ${r.shim} 不可用（${r.shimStatus}：${r.shimTail || ''}）。替代入口 node ${r.alternative.file} 实测自检通过。`
      };
    }
    const out = path.join(ROOT, 'data', 'proposed-overrides.json');
    fs.writeFileSync(out, JSON.stringify(proposed, null, 1));
    console.log(` 已写出待审覆盖表：${out}（${fixable.length} 条候选，需人工确认后合并）`);
  }
  process.exit(broken.length - fixable.length > 0 ? 1 : 0);
}

if (require.main === module) main();
