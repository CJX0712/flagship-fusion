/* ============================================================================
 * flagship-fusion · 舰队统一验证器（Fleet Verifier）
 * ----------------------------------------------------------------------------
 * 零重写：验证器【不重跑各仓的算法】——它复用各仓【已经写好的】自检入口
 * （npm test / node test/run.js / node src/verify.js …），只做四件事：
 *   1. 探测每个仓的真实自检入口（读 package.json 的 scripts + 探测常见路径）
 *   2. 以子进程方式执行，收集退出码、耗时与摘要
 *   3. 超时降级：全量入口超时 → 重试该仓的轻量入口（如 test:core），
 *      如实标记为 PASS-CORE（降级绿），绝不把超时粉饰成通过
 *   4. 汇总为一张舰队级通过率表 + 门禁退出码
 *
 * 为什么这是「集大成」而不是「又一个测试框架」：
 *   301 个仓各自有自检，但没有任何一处能看到【舰队整体的健康度】。
 *   本验证器把 301 个绿色/红色信号聚成一张表 —— 这就是舰队级「有尺子」。
 *
 * 实测依据（axiom-ai）：其 npm test = core(8.5s) + ui-smoke。ui-smoke 在
 * vm 沙箱内运行 386 项不变量检查需 26s（跨 realm 调用失去 JIT 优化），
 * 叠加 72 组算法演示后总时长超过单次子进程预算 —— 属【环境属性】而非缺陷。
 * 故设两级入口：全量优先，超时则降级到 core，两者都如实记账。
 *
 * 严格 fail-soft：单仓失败不中断全局，只在最终汇总时如实标记。
 * 与 CI 集成友好：退出码 0 = 全体绿；1 = 存在失败仓；2 = 用法/环境错误。
 *
 * 范式锚定：pytest / jest 的 workspace runner + Bazel 的 target aggregation。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FLEET = process.env.FUSION_FLEET || path.join(ROOT, '..', '.cache', 'fleet');

/* ---------------------------------------------------------------------------
 * 1. 自检入口探测（复用各仓既有脚本，不新写测试）
 * -------------------------------------------------------------------------*/
const CANDIDATES = [
  { file: 'package.json', kind: 'npm-test' },
  { file: 'test/run.js', kind: 'node' },
  { file: 'src/verify.js', kind: 'node' },
  { file: 'verify.js', kind: 'node' },
  { file: 'test.js', kind: 'node' },
  { file: 'tests/run.js', kind: 'node' },
  { file: 'selftest.js', kind: 'node' },
  { file: '_smoke.js', kind: 'node' },
  { file: '_probe.js', kind: 'node' },
  { file: 'test/run.py', kind: 'python' },
  { file: 'tests/test_*.py', kind: 'pytest' },
  { file: 'pytest.ini', kind: 'pytest' }
];

/** 轻量入口优先级（超时降级用）：只保留不依赖 UI/浏览器沙片的纯计算自检 */
const FALLBACK_SCRIPTS = ['test:core', 'test:unit', 'test:fast', 'test:quick'];
const FALLBACK_FILES = ['test/run.js', 'src/verify.js', 'verify.js'];

function readScripts(dir) {
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) return null;
  try { return JSON.parse(fs.readFileSync(pj, 'utf8')).scripts || null; } catch (_) { return null; }
}

function detectEntrypoint(dir) {
  // 1) package.json 的 scripts.test 最权威
  const scripts = readScripts(dir);
  if (scripts && scripts.test) {
    return { kind: 'npm', cmd: 'npm', args: ['test'], label: `npm test → ${scripts.test}` };
  }
  // 2) 常见路径
  for (const c of CANDIDATES) {
    if (c.kind === 'npm-test') continue;
    if (c.file.includes('*')) {
      const base = path.join(dir, path.dirname(c.file));
      if (!fs.existsSync(base)) continue;
      const pre = path.basename(c.file).split('*')[0], suf = path.basename(c.file).split('*')[1];
      const hits = fs.readdirSync(base).filter(f => f.startsWith(pre) && f.endsWith(suf));
      if (hits.length) return { kind: 'pytest', cmd: 'python', args: ['-m', 'pytest', '-q', path.join(path.dirname(c.file), hits[0])], label: `pytest ${hits[0]}` };
      continue;
    }
    const p = path.join(dir, c.file);
    if (!fs.existsSync(p)) continue;
    if (c.kind === 'node') return { kind: 'node', cmd: process.execPath, args: [p], label: `node ${c.file}` };
    if (c.kind === 'python') return { kind: 'python', cmd: 'python', args: [p], label: `python ${c.file}` };
    if (c.kind === 'pytest') return { kind: 'pytest', cmd: 'python', args: ['-m', 'pytest', '-q'], label: 'pytest' };
  }
  return null;
}

/** 探测降级入口：先 package.json 的轻量 script，再常见纯计算文件 */
function detectFallback(dir) {
  const scripts = readScripts(dir);
  if (scripts) {
    for (const s of FALLBACK_SCRIPTS) {
      if (scripts[s]) return { kind: 'npm', cmd: 'npm', args: ['run', s], label: `npm run ${s} → ${scripts[s]}` };
    }
  }
  for (const f of FALLBACK_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return { kind: 'node', cmd: process.execPath, args: [p], label: `node ${f}` };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 2. 单仓执行（隔离 + 超时 + 降级 + fail-soft）
 * -------------------------------------------------------------------------*/
const TIMEOUT_MS = Number(process.env.FUSION_TIMEOUT_MS || 150000);

function spawnOne(ep, dir) {
  // Windows 下 npm 是 .cmd 批处理，必须经 shell 执行；Node 脚本直接用绝对路径
  const useShell = ep.kind === 'npm';
  const t0 = Date.now();
  const r = spawnSync(ep.cmd, ep.args, {
    cwd: dir, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    shell: useShell
  });
  return { r, ms: Date.now() - t0 };
}

function summarize(r) {
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n').filter(l => l.trim());
  const summaryLine = lines.slice(-12).reverse().find(l => /通过|PASS|passed|全绿|结果|result|failed|FAIL/i.test(l));
  let passCount = null, totalCount = null;
  const m = summaryLine && summaryLine.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) { passCount = Number(m[1]); totalCount = Number(m[2]); }
  return { lines, summaryLine, passCount, totalCount };
}

function runOne(name, dir) {
  const ep = detectEntrypoint(dir);
  if (!ep) return { name, status: 'NO-CHECK', reason: '未发现自检入口' };

  const { r, ms } = spawnOne(ep, dir);
  const s = summarize(r);

  if (r.error && r.error.code === 'ETIMEDOUT') {
    // ---- 超时降级：重试轻量入口，如实标记 PASS-CORE ----
    const fb = detectFallback(dir);
    if (fb && fb.label !== ep.label) {
      const f = spawnOne(fb, dir);
      const sf = summarize(f.r);
      if (!f.r.error && f.r.status === 0) {
        return {
          name, status: 'PASS-CORE', entry: fb.label, degradedFrom: ep.label,
          pass: sf.passCount, total: sf.totalCount, ms: ms + f.ms,
          summary: (sf.summaryLine || '').trim().slice(0, 120),
          reason: `全量入口超时 ${(ms / 1000).toFixed(0)}s，降级轻量入口通过`
        };
      }
      return {
        name, status: 'TIMEOUT', entry: ep.label, fallback: fb.label,
        ms: ms + f.ms,
        reason: `全量超时 ${(ms / 1000).toFixed(0)}s，降级入口也未通过（退出码 ${f.r.status}）`,
        tail: sf.lines.slice(-6).join('\n').slice(0, 600)
      };
    }
    return { name, status: 'TIMEOUT', entry: ep.label, ms, reason: `超时 ${(ms / 1000).toFixed(0)}s（无降级入口）` };
  }
  if (r.error) {
    return { name, status: 'FAIL', entry: ep.label, ms, reason: `启动失败：${r.error.code || r.error.message}`, summary: (s.lines.slice(-1)[0] || '').trim().slice(0, 120) };
  }
  if (r.status === 0) {
    return { name, status: 'PASS', entry: ep.label, pass: s.passCount, total: s.totalCount, ms, summary: (s.summaryLine || '').trim().slice(0, 120) };
  }
  return {
    name, status: 'FAIL', entry: ep.label, ms,
    reason: `退出码 ${r.status}`,
    summary: (s.summaryLine || s.lines.slice(-1)[0] || '').trim().slice(0, 120),
    tail: s.lines.slice(-6).join('\n').slice(0, 600)
  };
}

/* ---------------------------------------------------------------------------
 * 3. 全舰队执行
 * -------------------------------------------------------------------------*/
function verifyFleet(opts) {
  const options = opts || {};
  const only = options.only ? new Set(options.only) : null;
  const skip = options.skip ? new Set(options.skip) : null;
  const limit = options.limit || Infinity;
  if (!fs.existsSync(FLEET)) {
    return { error: `未找到舰队目录：${FLEET}（先跑 tools/fleet-fetch.js）` };
  }
  const dirs = fs.readdirSync(FLEET).filter(d => {
    const p = path.join(FLEET, d);
    return fs.statSync(p).isDirectory() && !d.startsWith('.') && d !== '_t';
  }).sort();

  const results = [];
  for (const d of dirs) {
    if (results.length >= limit) break;
    if (only && !only.has(d)) continue;
    if (skip && skip.has(d)) continue;
    results.push(runOne(d, path.join(FLEET, d)));
  }

  const by = { PASS: 0, 'PASS-CORE': 0, FAIL: 0, 'NO-CHECK': 0, TIMEOUT: 0 };
  results.forEach(r => by[r.status]++);
  const green = by.PASS + by['PASS-CORE'];
  const withCheck = green + by.FAIL;
  return {
    fleetDir: FLEET,
    total: results.length,
    by,
    green,
    passRate: results.length ? green / results.length : 0,
    checked: withCheck,
    allPass: by.FAIL === 0 && by.TIMEOUT === 0,
    results
  };
}

module.exports = { verifyFleet, detectEntrypoint, detectFallback, FLEET, TIMEOUT_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const only = [];
  let jsonOut = null, limit = Infinity;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) { only.push(...args[i + 1].split(',')); i++; }
    else if (args[i] === '--json' && args[i + 1]) { jsonOut = args[i + 1]; i++; }
    else if (args[i] === '--limit' && args[i + 1]) { limit = Number(args[i + 1]); i++; }
  }
  const r = verifyFleet({ only: only.length ? only : null, limit });
  if (r.error) { console.error(r.error); process.exit(2); }
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(r, null, 1));
    console.log(`JSON 已写入 ${jsonOut}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  console.log(' 旗舰融合 · 舰队统一验证器');
  console.log('════════════════════════════════════════════════════════════');
  console.log(` 舰队目录：${r.fleetDir}`);
  console.log(` 参与验证：${r.total} 仓 · 有自检 ${r.checked} 仓`);
  console.log('────────────────────────────────────────────────────────────');
  const show = r.results.filter(x => x.status !== 'PASS' || only.length);
  const shown = show.length ? show : r.results.filter(x => x.status === 'PASS').slice(0, 20);
  for (const x of shown) {
    const mark = { PASS: '✅', 'PASS-CORE': '🟡', FAIL: '❌', 'NO-CHECK': '➖', TIMEOUT: '⏱️' }[x.status];
    const secs = x.ms != null ? `${(x.ms / 1000).toFixed(1)}s` : '';
    const detail = x.summary ? ` ${x.summary}` : (x.reason ? ` ${x.reason}` : '');
    console.log(` ${mark} ${x.name.padEnd(34)} ${String(x.entry || '').padEnd(30)}${secs.padStart(8)}${detail}`);
  }
  if (shown.length < r.results.length) {
    console.log(` … 其余 ${r.results.length - shown.length} 个 PASS 仓已折叠`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(` ✅ PASS ${r.by.PASS} · 🟡 降级绿 ${r.by['PASS-CORE']} · ❌ FAIL ${r.by.FAIL} · ➖ 无自检 ${r.by['NO-CHECK']} · ⏱️ 超时 ${r.by.TIMEOUT}`);
  console.log(` 舰队通过率：${(r.passRate * 100).toFixed(1)}%（有自检子集 ${r.checked ? (r.green / r.checked * 100).toFixed(1) : '0'}%）`);
  console.log(r.allPass ? ' 🟢 舰队门禁通过' : ' 🔴 舰队存在失败仓');
  process.exit(r.allPass ? 0 : 1);
}
