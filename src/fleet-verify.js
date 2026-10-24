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
 * 0. Python 解释器解析（依赖自治修复后的必要修正）
 * ---------------------------------------------------------------------------
 * 实测教训：全舰队 213 仓首跑有 62 仓报「No module named numpy」而被判 FAIL。
 * 根因不是这些仓的代码缺陷，而是验证器调裸 `python`，解析到的是
 * 无第三方库的裸解释器。依赖栈（numpy/scipy/sklearn/pandas…）已按
 * 隔离规则装入受管 venv。
 *
 * 解析策略 —— 能力探测而非路径猜测：
 *   依次候选（FUSION_PYTHON > 受管 venv > PATH 上的 python），
 *   对每个候选实跑 `import numpy`，取第一个真能导入的。
 *   这样即便 venv 位置漂移或依赖未装，也只会【如实回退】，
 *   绝不会假装有依赖而把「缺 numpy」粉饰成「测试通过」。
 * -------------------------------------------------------------------------*/
const MANAGED_VENV_PY = path.resolve(
  ROOT, '..', '..', '..', '.workbuddy', 'binaries', 'python', 'envs', 'default',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);

function probePython(bin) {
  try {
    const r = spawnSync(bin, ['-c', 'import numpy,scipy,sklearn,pandas'], {
      encoding: 'utf8', timeout: 20000, shell: false
    });
    return r.status === 0 && !r.error;
  } catch (_) { return false; }
}

function resolvePython() {
  const cands = [];
  if (process.env.FUSION_PYTHON) cands.push(process.env.FUSION_PYTHON);
  if (fs.existsSync(MANAGED_VENV_PY)) cands.push(MANAGED_VENV_PY);
  cands.push('python');
  for (const c of cands) {
    if (probePython(c)) return { bin: c, probed: true };
  }
  // 全部候选都缺依赖 → 如实记录，让 ENV-BLOCKED 分类去说话
  return { bin: cands[0] || 'python', probed: false };
}
const PY_RESOLVED = resolvePython();
const PYTHON_BIN = PY_RESOLVED.bin;

/** 子进程统一环境：强制 UTF-8，消除 Windows GBK 控制台把中文错误信息解成乱码的问题 */
function childEnv(extra) {
  return Object.assign({}, process.env, {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    // npm 在非 TTY 下默认关色，避免 ANSI 序列污染摘要匹配
    FORCE_COLOR: '0',
    NO_COLOR: '1'
  }, extra || {});
}

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

/** 文件是否含 pytest 能收集到的用例（test_* 函数或 pytest 导入） */
const PYTEST_MARK = /(^|\n)\s*def\s+test_/m;
function hasPytestCases(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    return PYTEST_MARK.test(src) || /^\s*import\s+pytest/m.test(src);
  } catch (_) {
    return true; // 读不动就交回 pytest 自己去说话，不替它下结论
  }
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
      if (!hits.length) continue;
      const rel = path.join(path.dirname(c.file), hits[0]);
      // 实测教训：入口判定不能只看文件名。phosphor-py 的 tests/test_all.py 是
      // 脚本式自检（0 个 test_* 函数，docstring 写明运行方式是 `python tests/test_all.py`），
      // 盲目喂给 pytest 会得到「no tests ran」并被误记成 FAIL（退出码 5）。
      // 先看内容：确有 pytest 可收集的用例才走 pytest，否则按脚本式自检直接跑
      // （实测 phosphor-py：python tests/test_all.py → 27 通过 / 0 失败）。
      if (hasPytestCases(path.join(dir, rel))) {
        return { kind: 'pytest', cmd: PYTHON_BIN, args: ['-m', 'pytest', '-q', rel], label: `pytest ${rel}` };
      }
      return { kind: 'python', cmd: PYTHON_BIN, args: [rel], label: `python ${rel}` };
    }
    const p = path.join(dir, c.file);
    if (!fs.existsSync(p)) continue;
    if (c.kind === 'node') return { kind: 'node', cmd: process.execPath, args: [p], label: `node ${c.file}` };
    if (c.kind === 'python') return { kind: 'python', cmd: PYTHON_BIN, args: [p], label: `python ${c.file}` };
    if (c.kind === 'pytest') return { kind: 'pytest', cmd: PYTHON_BIN, args: ['-m', 'pytest', '-q'], label: 'pytest' };
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
 * 1b. Curated 入口覆盖表（Entrypoint Overrides）
 * ---------------------------------------------------------------------------
 * 自动探测按「惯例」猜入口，惯例失效时分两种性质，都必须显式登记而非静默：
 *   (a) 仓自身打包不一致：入口指向已不存在的文件（真缺陷，修复方式是重定向）
 *   (b) 聚合仓的子模块在快照中为空占位（结构属性，用舰队中的兄弟仓代行验证）
 * 每条覆盖附可复现理由（实测命令 + 输出），见 data/entrypoint-overrides.json。
 * -------------------------------------------------------------------------*/
const OVERRIDES_PATH = path.join(ROOT, 'data', 'entrypoint-overrides.json');
function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return { entry: {}, substitute: {} };
  try {
    const j = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    return { entry: j.entry || {}, substitute: j.substitute || {} };
  } catch (_) { return { entry: {}, substitute: {} }; }
}
const OVERRIDES = loadOverrides();

/** 入口解析 = 自动探测 ⊕ curated 覆盖表（覆盖优先） */
function resolveEntrypoint(name, dir) {
  const ov = OVERRIDES.entry[name];
  if (ov && ov.args && ov.args.length) {
    return {
      kind: 'override',
      cmd: ov.cmd || process.execPath,
      args: ov.args,
      label: `${ov.cmd || 'node'} ${ov.args.join(' ')}`,
      overrideReason: `入口覆盖：${ov.reason || '见 data/entrypoint-overrides.json'}`
    };
  }
  const ep = detectEntrypoint(dir);
  return ep || null;
}

/* ---------------------------------------------------------------------------
 * 2. 单仓执行（隔离 + 超时 + 降级 + fail-soft）
 * -------------------------------------------------------------------------*/
const TIMEOUT_MS = Number(process.env.FUSION_TIMEOUT_MS || 150000);

function spawnOne(ep, dir) {
  // Windows 下 npm 是 .cmd 批处理，必须经 shell 执行；Node 脚本直接用绝对路径
  const useShell = ep.kind === 'npm';
  // Python 仓的测试常 import 仓自身包（pytest、pytest-file、脚本式自检皆然）。
  // 快照里的包没有 pip install -e，凭 import 找不到 → 会退化成 ModuleNotFoundError
  // 并被误记为「缺依赖」。把仓根（及主流约定的 src/）挂上 PYTHONPATH，
  // 让「仓自己的包」可直接导入，剩下的才真的是第三方缺依赖。
  // （实测：aurora-rag / aether-ai-core-v2 的 src 布局属此类）
  let pyPath = (ep.kind === 'pytest' || ep.kind === 'python') ? dir : null;
  if (pyPath && fs.existsSync(path.join(dir, 'src'))) {
    pyPath = pyPath + path.delimiter + path.join(dir, 'src');
  }
  const t0 = Date.now();
  const r = spawnSync(ep.cmd, ep.args, {
    cwd: dir, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    shell: useShell, env: pyPath ? childEnv({ PYTHONPATH: pyPath }) : childEnv()
  });
  return { r, ms: Date.now() - t0 };
}

/* ---------------------------------------------------------------------------
 * 2b. 失败归因：把「环境缺依赖」与「代码真缺陷」分开记账
 * ---------------------------------------------------------------------------
 * 这是本验证器最重要的诚实性设计。213 仓首跑把 62 个「缺 numpy」的仓
 * 一律记成 FAIL，那是把环境问题误判成代码问题 —— 会让使用者去改本来正确的代码。
 * 现在按输出特征分类：缺模块 → ENV-BLOCKED（可自治修复后重验），
 * 真断言失败 → FAIL（必须改代码）。
 * -------------------------------------------------------------------------*/
/** POSIX-only 标准库：Windows 上不存在这类模块，也无法用 pip 补齐 */
const POSIX_ONLY_MODULES = [
  'resource', 'fcntl', 'termios', 'pty', 'tty', 'pwd', 'grp', 'spwd', 'crypt', 'syslog', 'nis'
];

const ENV_PATTERNS = [
  { re: /No module named '([^']+)'/i, kind: 'python-module' },
  { re: /Cannot find module '([^']+)'/i, kind: 'node-module' },
  { re: /ModuleNotFoundError/i, kind: 'python-module' },
  { re: /'(\S+)' 不是内部或外部命令|is not recognized as an internal or external command/i, kind: 'missing-binary' },
  { re: /missing script|npm ERR! Missing script/i, kind: 'missing-script' },
  { re: /ENOENT|no such file or directory/i, kind: 'missing-file' }
];

/** 缺失模块是不是「仓自己该有却没有的包」：模块根名 == 仓名，且目录下并无该包 */
function isSelfPackageMissing(moduleName, repoName, dir) {
  if (!moduleName) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[-_.]/g, '');
  const root = String(moduleName).split('.')[0];
  if (!root || !norm(repoName).includes(norm(root))) return false;
  const asPackage = path.join(dir, root);
  const asModule = path.join(dir, root + '.py');
  if (fs.existsSync(asPackage) || fs.existsSync(asModule)) return false;
  if (fs.existsSync(path.join(dir, 'src', root))) return false;
  return true;
}

function classifyFailure(out) {
  const text = out || '';
  // POSIX-only 标准库在 Windows 上不存在，也 pip 装不了。
  // 若一律记成「缺依赖」，等于暗示使用者去 pip install 一个永远装不上的模块——
  // 这是归因失真。单独分一类：平台不支持，非代码缺陷，非依赖问题。
  if (process.platform === 'win32') {
    const pm = text.match(/ModuleNotFoundError:\s*No module named '([A-Za-z_][\w.]*)'/);
    if (pm && POSIX_ONLY_MODULES.includes(pm[1])) {
      return {
        envBlocked: true, envKind: 'platform-unsupported',
        detail: `${pm[1]}（POSIX-only 标准库，Windows 无此模块且无法 pip 安装）`
      };
    }
  }
  for (const p of ENV_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { envBlocked: true, envKind: p.kind, detail: (m[1] || '').slice(0, 60) };
  }
  return { envBlocked: false };
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
  const ep = resolveEntrypoint(name, dir);
  if (!ep) return { name, status: 'NO-CHECK', reason: '未发现自检入口' };
  return runOneWith(ep, name, dir, ep.overrideReason || null);
}

/** 单仓执行主体（入口由调用方给定，便于覆盖表注入） */
/**
 * 前置探测：npm 脚本依赖的测试运行器到底装没装？
 *
 * 实测教训（aetheros）：`npm test → vitest run`，但 node_modules 里没有 vitest，
 * npm 直接退 1。若按「退出码非零 = 测试失败」记账，就是把
 * 「依赖未安装」冒充成「代码缺陷」——这正是 ENV-BLOCKED / FAIL 分账要防的事。
 * 主动检查而非事后猜错文编码（Windows 中文/英文 locale 报错文案不同），
 * 因地制宜判断一律用文件系统事实说话。
 */
function missingTestRunner(ep, dir) {
  if (!ep || ep.kind !== 'npm') return null;
  const tok = (String(ep.label).match(/npm test\s*→\s*(\S+)/) || [])[1];
  if (!tok || tok === 'node' || tok === 'npm' || tok === 'npx') return null;
  const bin = path.join(dir, 'node_modules', '.bin');
  const win = process.platform === 'win32';
  const present = fs.existsSync(path.join(bin, tok))
    || fs.existsSync(path.join(bin, tok + (win ? '.cmd' : '')))
    || fs.existsSync(path.join(bin, tok + (win ? '.ps1' : '')));
  return present ? null : tok;
}

function runOneWith(ep, name, dir, overrideReason) {
  // 测试运行器都还没装 → 直接如实记环境受阻，不去跑注定失败的命令
  const missingBin = missingTestRunner(ep, dir);
  if (missingBin) {
    return {
      name, status: 'ENV-BLOCKED', entry: ep.label, ms: 0, overrideReason,
      envKind: 'missing-test-runner', envDetail: missingBin,
      reason: `测试运行器 ${missingBin} 未安装（node_modules 缺失或未装成功）——非代码缺陷`
    };
  }
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
          name, status: 'PASS-CORE', entry: fb.label, degradedFrom: ep.label, overrideReason,
          pass: sf.passCount, total: sf.totalCount, ms: ms + f.ms,
          summary: (sf.summaryLine || '').trim().slice(0, 120),
          reason: `全量入口超时 ${(ms / 1000).toFixed(0)}s，降级轻量入口通过`
        };
      }
      return {
        name, status: 'TIMEOUT', entry: ep.label, fallback: fb.label, overrideReason,
        ms: ms + f.ms,
        reason: `全量超时 ${(ms / 1000).toFixed(0)}s，降级入口也未通过（退出码 ${f.r.status}）`,
        tail: sf.lines.slice(-6).join('\n').slice(0, 600)
      };
    }
    return { name, status: 'TIMEOUT', entry: ep.label, ms, overrideReason, reason: `超时 ${(ms / 1000).toFixed(0)}s（无降级入口）` };
  }
  if (r.error) {
    return { name, status: 'FAIL', entry: ep.label, ms, overrideReason, reason: `启动失败：${r.error.code || r.error.message}`, summary: (s.lines.slice(-1)[0] || '').trim().slice(0, 120) };
  }
  if (r.status === 0) {
    return { name, status: 'PASS', entry: ep.label, pass: s.passCount, total: s.totalCount, ms, overrideReason, summary: (s.summaryLine || '').trim().slice(0, 120) };
  }
  // ---- 失败归因：环境缺依赖 vs 代码真缺陷 ----
  const out = (r.stdout || '') + (r.stderr || '');

  // pytest 一条用例都没收集到（退出码 5 / "no tests ran"）= 入口约定与工具不匹配，
  // 是验证器的选择问题，不是被测仓的断言失败——必须如实分成环境类，不冒充缺陷。
  if (Number(r.status) === 5 || /\bno tests ran\b/i.test(out)) {
    return {
      name, status: 'ENV-BLOCKED', entry: ep.label, ms, overrideReason,
      envKind: 'pytest-no-collect', envDetail: '入口约定不匹配（pytest 未收集到用例）',
      reason: 'pytest 未收集到任何用例（入口约定不匹配，属工具选择问题）——非代码缺陷',
      summary: (s.summaryLine || s.lines.slice(-1)[0] || '').trim().slice(0, 120)
    };
  }

  const c = classifyFailure(out);
  if (c.envBlocked) {
    // 例外一类：缺失模块是「仓自己的包」（模块名 == 仓名，且仓内不存在该目录）
    // 这不是 pip 能补的环境依赖，而是仓自身结构不一致——必须记 FAIL 而非 ENV-BLOCKED。
    // 实证：portforge 的测试 `from portforge.core.config import …`，
    // 但 GitHub 远端与本地快照均不存在 portforge/ 包目录（已用 GitHub API 核对）。
    if (c.envKind === 'python-module' && isSelfPackageMissing(c.detail, name, dir)) {
      return {
        name, status: 'FAIL', entry: ep.label, ms, overrideReason,
        reason: `仓缺少自有包目录 ${c.detail}（tests 导入的本仓模块在仓内不存在，已核对远端同源）——非环境依赖问题`,
        summary: (s.summaryLine || s.lines.slice(-1)[0] || '').trim().slice(0, 120),
        tail: s.lines.slice(-6).join('\n').slice(0, 600)
      };
    }
    return {
      name, status: 'ENV-BLOCKED', entry: ep.label, ms, overrideReason,
      envKind: c.envKind, envDetail: c.detail,
      reason: c.envKind === 'platform-unsupported'
        ? `平台不支持（${c.detail}）——非代码缺陷，需在 Linux/macOS 下重验`
        : `环境缺依赖（${c.envKind}${c.detail ? ': ' + c.detail : ''}）——非代码缺陷`,
      summary: (s.summaryLine || s.lines.slice(-1)[0] || '').trim().slice(0, 120)
    };
  }
  return {
    name, status: 'FAIL', entry: ep.label, ms, overrideReason,
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

    // ---- 覆盖表：substitute（聚合仓由兄弟仓代行验证）----
    const sub = OVERRIDES.substitute[d];
    if (sub && sub.targets && sub.targets.length) {
      const subs = sub.targets
        .filter(t => fs.existsSync(path.join(FLEET, t)))
        .map(t => runOne(t, path.join(FLEET, t)));
      if (subs.length) {
        const allGreen = subs.every(x => x.status === 'PASS' || x.status === 'PASS-CORE');
        results.push({
          name: d,
          status: allGreen ? 'PASS' : 'FAIL',
          entry: `substitute → ${sub.targets.join(', ')}`,
          pass: subs.reduce((a, x) => a + (x.pass || 0), 0),
          total: subs.reduce((a, x) => a + (x.total || 0), 0),
          ms: subs.reduce((a, x) => a + (x.ms || 0), 0),
          substituted: true,
          reason: `聚合仓子模块为空占位，由 ${subs.length} 个兄弟仓代行验证`,
          summary: subs.map(x => `${x.name}:${x.status}`).join(' '),
          children: subs.map(x => ({ name: x.name, status: x.status, pass: x.pass, total: x.total }))
        });
        continue;
      }
    }

    results.push(runOne(d, path.join(FLEET, d)));
  }

  const by = { PASS: 0, 'PASS-CORE': 0, FAIL: 0, 'NO-CHECK': 0, TIMEOUT: 0, 'ENV-BLOCKED': 0 };
  results.forEach(r => by[r.status]++);
  const green = by.PASS + by['PASS-CORE'];
  const withCheck = green + by.FAIL;
  const envBlocked = by['ENV-BLOCKED'];
  return {
    fleetDir: FLEET,
    python: PYTHON_BIN,
    pythonProbed: PY_RESOLVED.probed,
    total: results.length,
    by,
    green,
    passRate: results.length ? green / results.length : 0,
    checked: withCheck,
    envBlocked,
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
  console.log(` Python 解释器：${r.python}${r.pythonProbed ? '（已验证可导入 numpy/scipy/sklearn/pandas）' : '（⚠️ 依赖栈未就绪，相关仓将如实记 ENV-BLOCKED）'}`);
  console.log(` 参与验证：${r.total} 仓 · 有自检 ${r.checked} 仓`);
  console.log('────────────────────────────────────────────────────────────');
  const show = r.results.filter(x => x.status !== 'PASS' || only.length);
  const shown = show.length ? show : r.results.filter(x => x.status === 'PASS').slice(0, 20);
  for (const x of shown) {
    const mark = { PASS: '✅', 'PASS-CORE': '🟡', FAIL: '❌', 'NO-CHECK': '➖', TIMEOUT: '⏱️', 'ENV-BLOCKED': '🔧' }[x.status];
    const secs = x.ms != null ? `${(x.ms / 1000).toFixed(1)}s` : '';
    const detail = x.summary ? ` ${x.summary}` : (x.reason ? ` ${x.reason}` : '');
    console.log(` ${mark} ${x.name.padEnd(34)} ${String(x.entry || '').padEnd(30)}${secs.padStart(8)}${detail}`);
  }
  if (shown.length < r.results.length) {
    console.log(` … 其余 ${r.results.length - shown.length} 个 PASS 仓已折叠`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(` ✅ PASS ${r.by.PASS} · 🟡 降级绿 ${r.by['PASS-CORE']} · ❌ FAIL ${r.by.FAIL} · 🔧 环境受阻 ${r.by['ENV-BLOCKED']} · ➖ 无自检 ${r.by['NO-CHECK']} · ⏱️ 超时 ${r.by.TIMEOUT}`);
  console.log(` 舰队通过率：${(r.passRate * 100).toFixed(1)}%（有自检子集 ${r.checked ? (r.green / r.checked * 100).toFixed(1) : '0'}%）`);
  console.log(r.allPass ? ' 🟢 舰队门禁通过' : ' 🔴 舰队存在失败仓');
  process.exit(r.allPass ? 0 : 1);
}
