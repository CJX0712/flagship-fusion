/* ============================================================================
 * flagship-fusion · 单文件仪表盘构建器
 * ----------------------------------------------------------------------------
 * 零重写：本脚本【不生成任何算法结果】——它只把既有验证引擎产出的 JSON
 * （data/differential.json / data/isa-crosswalk.json / data/variant-closure.json
 *  / data/fleet-verify-full.json）装配成一个零依赖单文件 HTML。
 *
 * 为什么单文件：符合「浏览器内一键自检 + 无头 Node 全绿」的旗舰范式，
 * 不依赖任何 CDN / 构建链 / 包管理器，双击即可运行。
 *
 * 用法：node tools/build-dashboard.js [--out dashboard.html]
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'dashboard.html');

function load(name, fallback) {
  const p = name.startsWith('..') ? path.resolve(ROOT, name) : path.join(DATA, name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

const differential = load('differential.json', null);
const crosswalk = load('isa-crosswalk.json', null);
const variant = load('variant-closure.json', null);
const fleetVerify = load('fleet-verify-full.json', null);
const fleetVerifyPath = path.join(DATA, 'fleet-verify-full.json');
const fleetVerifyMtime = fs.existsSync(fleetVerifyPath) ? fs.statSync(fleetVerifyPath).mtime : null;
const repos = load('../.cache/repos.json', []);

const payload = {
  generatedAt: new Date().toISOString(),
  differential: differential ? {
    total: differential.total, passed: differential.passed, degraded: differential.degraded,
    solo: differential.solo, failed: differential.failed, hardPass: differential.hardPass,
    results: differential.results.map(r => ({
      name: r.name, verdict: r.verdict, verdictZh: r.verdictZh, reason: r.reason,
      implCount: r.implCount, fusionTol: r.fusionTol, recommended: r.recommended,
      refs: r.refs.map(x => ({ src: x.src, locator: x.locator, dTruth: x.dTruth, tol: x.tol, withinContract: x.withinContract })),
      errors: r.errors, pairwise: r.pairwise, gates: r.gates,
      precisionRanking: r.precisionRanking
    }))
  } : null,
  crosswalk: crosswalk ? {
    schema: crosswalk.schema, generatedAt: crosswalk.generatedAt, generator: crosswalk.generator,
    sources: crosswalk.sources, designNote: crosswalk.designNote,
    tagAxis: crosswalk.tagAxis, tagCoverage: crosswalk.tagCoverage,
    variantCoverage: crosswalk.variantCoverage,
    axiomOps: crosswalk.axiomOps, flagshipDomains: crosswalk.flagshipDomains
  } : null,
  variant: variant ? {
    total: variant.total, closed: variant.closed,
    isaCoverageBefore: variant.isaCoverageBefore, isaCoverageAfter: variant.isaCoverageAfter,
    byVariant: variant.byVariant,
    results: variant.results.map(r => ({
      id: r.id, op: r.op, variant: r.variant, closed: r.closed,
      reason: r.reason, method: r.method, shapePreserving: r.shapePreserving
    }))
  } : null,
  fleetVerify: fleetVerify ? {
    total: fleetVerify.total, by: fleetVerify.by, green: fleetVerify.green,
    passRate: fleetVerify.passRate, checked: fleetVerify.checked, allPass: fleetVerify.allPass,
    snapshotAt: fleetVerifyMtime ? fleetVerifyMtime.toISOString() : null,
    envBlocked: fleetVerify.envBlocked || (fleetVerify.by && fleetVerify.by['ENV-BLOCKED']) || 0,
    python: fleetVerify.python, pythonProbed: fleetVerify.pythonProbed,
    results: fleetVerify.results.map(r => ({
      name: r.name, status: r.status, entry: r.entry, pass: r.pass, total: r.total,
      ms: r.ms, summary: r.summary, reason: r.reason, degradedFrom: r.degradedFrom,
      envKind: r.envKind, envDetail: r.envDetail,
      substituted: r.substituted, overrideReason: r.overrideReason,
      children: r.children
    }))
  } : null,
  fleet: repos.map(r => ({
    name: r.name,
    desc: (r.description || '').slice(0, 160),
    stars: r.stargazerCount || 0,
    disk: r.diskUsage || 0,
    created: (r.createdAt || '').slice(0, 10),
    updated: (r.updatedAt || '').slice(0, 10),
    lang: (r.languages && r.languages[0] && r.languages[0].node && r.languages[0].node.name) || '—',
    license: (r.licenseInfo && r.licenseInfo.key) || '—',
    fork: !!r.isFork,
    archived: !!r.isArchived,
    url: r.url
  }))
};

const html = buildHTML(payload);
fs.writeFileSync(OUT, html, 'utf8');
console.log(`✅ 仪表盘已生成：${OUT}（${(html.length / 1024).toFixed(1)} KB）`);
console.log(`   对拍 ${payload.differential ? payload.differential.total : 0} 项 · ISA ${payload.crosswalk ? payload.crosswalk.axiomOps.length : 0} 算子 · 变体审计 ${payload.variant ? payload.variant.total : 0} 条 · 舰队 ${payload.fleet.length} 仓`);

/* ---------------------------------------------------------------------------
 * HTML 装配（零依赖单文件：内联 CSS + 内联 JS + 内联数据）
 * -------------------------------------------------------------------------*/
function buildHTML(P) {
  const DATA_JSON = JSON.stringify(P).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>旗舰融合 · Flagship Fusion — 晨星</title>
<style>
:root{
  --bg:#0b111c; --bg2:#0f1724; --panel:#131c2e; --panel2:#182236;
  --line:#22304a; --line2:#2e3f5f;
  --txt:#e6edf7; --txt2:#9fb0c8; --txt3:#6b7d99;
  --cyan:#22d3ee; --purple:#8b5cf6; --green:#34d399; --pink:#f472b6;
  --amber:#fbbf24; --red:#f87171; --blue:#60a5fa;
  --mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:var(--sans);font-size:14px;line-height:1.6;
  background-image:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(34,211,238,.08),transparent),radial-gradient(ellipse 60% 40% at 80% 100%,rgba(139,92,246,.06),transparent)}
.wrap{max-width:1280px;margin:0 auto;padding:24px 20px 80px}
a{color:var(--cyan);text-decoration:none}
a:hover{text-decoration:underline}

/* ---------- 头部 ---------- */
header{padding:36px 0 24px;border-bottom:1px solid var(--line);margin-bottom:24px}
.brand{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.brand h1{font-size:30px;font-weight:800;letter-spacing:-.5px;
  background:linear-gradient(120deg,var(--cyan),var(--purple) 60%,var(--pink));
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.brand .ver{font-family:var(--mono);font-size:12px;color:var(--txt3);border:1px solid var(--line);border-radius:99px;padding:2px 10px}
.subtitle{color:var(--txt2);margin-top:10px;max-width:880px}
.byline{margin-top:14px;font-size:13px;color:var(--txt3)}
.byline b{color:var(--cyan);font-weight:600}
.gatebar{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.gate{font-family:var(--mono);font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--line2);background:var(--panel)}
.gate.ok{color:var(--green);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}
.gate.bad{color:var(--red);border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
.gate.warn{color:var(--amber);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)}

/* ---------- KPI ---------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:22px 0 30px}
.kpi{background:linear-gradient(160deg,var(--panel),var(--bg2));border:1px solid var(--line);border-radius:12px;padding:16px 18px;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--cyan),var(--purple))}
.kpi .n{font-size:26px;font-weight:800;font-family:var(--mono);color:var(--txt)}
.kpi .l{font-size:12px;color:var(--txt3);margin-top:2px}
.kpi .d{font-size:11px;color:var(--txt2);margin-top:6px;font-family:var(--mono)}
.kpi.c1 .n{color:var(--cyan)} .kpi.c2 .n{color:var(--green)} .kpi.c3 .n{color:var(--purple)} .kpi.c4 .n{color:var(--amber)} .kpi.c5 .n{color:var(--teal,var(--cyan))}

/* ---------- Tab ---------- */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:22px;flex-wrap:wrap}
.tab{padding:9px 16px;background:none;border:none;color:var(--txt3);font-size:13px;cursor:pointer;border-bottom:2px solid transparent;font-family:var(--sans)}
.tab:hover{color:var(--txt2)}
.tab.on{color:var(--cyan);border-bottom-color:var(--cyan);font-weight:600}
.view{display:none}.view.on{display:block;animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* ---------- 面板 ---------- */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:18px}
.panel h2{font-size:16px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.panel h2 .dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 8px var(--cyan)}
.panel .hint{font-size:12px;color:var(--txt3);margin-bottom:14px}
.panel h3{font-size:13px;color:var(--txt2);margin:16px 0 8px;font-weight:600}

/* ---------- 表格 ---------- */
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;padding:8px 10px;color:var(--txt3);font-weight:600;border-bottom:1px solid var(--line2);white-space:nowrap;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:rgba(34,211,238,.03)}
.mono{font-family:var(--mono);font-size:12px}
.tag{display:inline-block;font-family:var(--mono);font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--line2);color:var(--txt2);margin:1px 2px}
.tag.g{color:var(--green);border-color:rgba(52,211,153,.35);background:rgba(52,211,238,.05)}
.tag.a{color:var(--amber);border-color:rgba(251,191,36,.35)}
.tag.r{color:var(--red);border-color:rgba(248,113,113,.35)}
.tag.p{color:var(--purple);border-color:rgba(139,92,246,.35)}
.tag.c{color:var(--cyan);border-color:rgba(34,211,238,.35)}
.v{font-weight:700}
.v.g{color:var(--green)} .v.a{color:var(--amber)} .v.r{color:var(--red)} .v.p{color:var(--purple)} .v.c{color:var(--cyan)}

/* ---------- 十层架构 ---------- */
.layers{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.layer{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px;position:relative;transition:.15s}
.layer:hover{border-color:var(--cyan);transform:translateY(-2px)}
.layer .no{font-family:var(--mono);font-size:10px;color:var(--txt3)}
.layer .nm{font-weight:700;font-size:13px;margin:3px 0 5px}
.layer .ds{font-size:11px;color:var(--txt3);line-height:1.5}
.layer .bar{height:3px;border-radius:2px;margin-top:8px;background:var(--line2)}
.layer .bar i{display:block;height:100%;border-radius:2px}

/* ---------- 搜索/工具条 ---------- */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
input[type=search],select{background:var(--bg2);border:1px solid var(--line2);color:var(--txt);border-radius:8px;padding:7px 12px;font-size:13px;font-family:var(--sans);outline:none}
input[type=search]{min-width:240px}
input[type=search]:focus,select:focus{border-color:var(--cyan)}
.btn{background:var(--panel2);border:1px solid var(--line2);color:var(--txt2);border-radius:8px;padding:7px 14px;font-size:12.5px;cursor:pointer;font-family:var(--sans)}
.btn:hover{border-color:var(--cyan);color:var(--cyan)}
.btn.on{background:rgba(34,211,238,.12);border-color:var(--cyan);color:var(--cyan)}
.count{font-family:var(--mono);font-size:12px;color:var(--txt3);margin-left:auto}

/* ---------- 进度条 ---------- */
.prog{height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.prog i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--cyan),var(--purple))}

/* ---------- 对拍卡片 ---------- */
.prim{border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden}
.prim>.hd{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--bg2);cursor:pointer;user-select:none}
.prim>.hd:hover{background:var(--panel2)}
.prim>.hd .nm{font-family:var(--mono);font-weight:700;font-size:13px}
.prim>.hd .rs{color:var(--txt3);font-size:11.5px;margin-left:auto;font-family:var(--mono)}
.prim>.bd{display:none;padding:12px 14px;border-top:1px solid var(--line)}
.prim.open>.bd{display:block}
.pill{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:99px;font-weight:700}
.pill.GREEN{color:var(--green);background:rgba(52,211,153,.12)}
.pill.DEGRADED{color:var(--amber);background:rgba(251,191,36,.12)}
.pill.SOLO{color:var(--purple);background:rgba(139,92,246,.12)}
.pill.RED{color:var(--red);background:rgba(248,113,113,.12)}
.kv{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;font-size:12px;margin:8px 0}
.kv dt{color:var(--txt3);font-family:var(--mono)}
.kv dd{color:var(--txt2)}
.mini{width:100%;font-size:11.5px;margin-top:8px}
.mini td,.mini th{padding:5px 8px}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--txt3);font-size:12px;text-align:center}
.empty{padding:40px;text-align:center;color:var(--txt3);font-size:13px}
@media(max-width:640px){.brand h1{font-size:22px}.kpi .n{font-size:20px}}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="brand">
    <h1>旗舰融合 · Flagship Fusion</h1>
    <span class="ver">v1.0 · 零重写集大成</span>
  </div>
  <p class="subtitle">301 仓旗舰舰队的治理层：跨仓差分对拍（多实现互证 + 高精度参照三方校验）、ISA 交叉索引、变体缺口诚实审计、舰队统一验证。不重写任何算法 —— 只锻造「尺子」，让每个仓的绿色都变成可互证的事实。</p>
  <div class="byline">作者 <b>晨星</b> · 深圳市 AI 云科技 · 一人公司（OPC）· 成果完整开源至 GitHub · MIT License</div>
  <div class="gatebar" id="gatebar"></div>
</header>

<div class="kpis" id="kpis"></div>

<div class="tabs" id="tabs"></div>

<div class="view on" id="view-overview"></div>
<div class="view" id="view-diff"></div>
<div class="view" id="view-isa"></div>
<div class="view" id="view-variant"></div>
<div class="view" id="view-fleetverify"></div>
<div class="view" id="view-fleetindex"></div>

<footer>
  旗舰融合 · Flagship Fusion — 可运行 / 可复现 / 可验证<br>
  数据由 <span class="mono">src/differential.js</span> · <span class="mono">src/isa-crosswalk.js</span> · <span class="mono">src/variant-closer.js</span> · <span class="mono">src/fleet-verify.js</span> 实测生成 · 构建于 <span class="mono" id="built"></span>
</footer>
</div>

<script>
"use strict";
const DATA = ${DATA_JSON};

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtSci = v => v == null ? '—' : (v === 0 ? '0' : Number(v).toExponential(2));
const fmtPct = v => (v * 100).toFixed(1) + '%';
const fmtSec = ms => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';
const VERDICT_ZH = { GREEN:'🟢 全绿', DEGRADED:'🟠 降级', SOLO:'🟡 孤证', RED:'🔴 破约' };
const STATUS_MARK = { PASS:'✅', 'PASS-CORE':'🟡', FAIL:'❌', 'NO-CHECK':'➖', TIMEOUT:'⏱️', 'ENV-BLOCKED':'🔧' };
const STATUS_ZH = { PASS:'通过', 'PASS-CORE':'降级绿', FAIL:'失败', 'NO-CHECK':'无自检', TIMEOUT:'超时', 'ENV-BLOCKED':'环境受阻' };
const STATUS_DESC = {
  'PASS':'自检通过', 'PASS-CORE':'全量入口超时，降级轻量入口通过（如实标注）',
  'FAIL':'真断言失败或真崩溃 —— 需要改代码',
  'NO-CHECK':'仓内无自检入口',
  'TIMEOUT':'超时且无降级入口',
  'ENV-BLOCKED':'环境缺依赖（numpy / node_modules / 私有包 404）—— 修环境后重验，不是代码缺陷'
};

/* ---------- 门禁条 ---------- */
(function renderGates(){
  const g = [];
  const d = DATA.differential, fv = DATA.fleetVerify, v = DATA.variant;
  if (d) g.push({ cls: d.hardPass ? 'ok' : 'bad', t: d.hardPass ? '对拍硬门禁通过（0 破约）' : '对拍存在破约' });
  if (d) g.push({ cls: d.passed + ' 项互证', t: \`\${d.total} 语义契约 · \${d.passed} 全绿 · \${d.solo} 孤证\`, warm:true });
  if (v) g.push({ cls: 'warn', t: \`变体缺口审计 \${v.total} 条（\${v.closed} 条可闭合）\` });
  if (fv) g.push({ cls: fv.allPass ? 'ok' : 'bad', t: fv.allPass ? \`舰队门禁通过 \${fv.green}/\${fv.checked}\` : \`舰队存在失败仓 \${fv.by.FAIL}\` });
  g.push({ cls:'ok', t:'零依赖单文件 · 无外部请求' });
  $('#gatebar').innerHTML = g.map(x => \`<span class="gate \${x.cls}">\${esc(x.t)}</span>\`).join('');
})();

/* ---------- KPI ---------- */
(function renderKPIs(){
  const d = DATA.differential, c = DATA.crosswalk, v = DATA.variant, fv = DATA.fleetVerify;
  const cards = [
    { c:'c1', n: DATA.fleet.length, l:'旗舰舰队仓库', d:\`\${DATA.fleet.filter(r=>!r.fork).length} 原创 · \${DATA.fleet.filter(r=>r.fork).length} fork\` },
    { c:'c2', n: d ? d.total : '—', l:'跨仓对拍语义契约', d: d ? \`\${d.passed} 全绿 · \${d.degraded} 降级 · \${d.solo} 孤证 · \${d.failed} 破约\` : '' },
    { c:'c3', n: c ? c.variantCoverage.verified : '—', l:'AXIOM 已验证微指令', d: c ? \`/\${c.variantCoverage.possible} = \${fmtPct(c.variantCoverage.coverage)}\` : '' },
    { c:'c4', n: v ? v.total : '—', l:'变体缺口（诚实审计）', d: v ? \`可闭合 \${v.closed} · 属性不成立 \${v.results.filter(r=>!r.closed && r.shapePreserving===false).length}\` : '' }
  ];
  if (fv) cards.push({ c:'c2', n: fv.green, l:'舰队验证通过仓', d: fv ? \`/\${fv.checked} 有自检 · \${fv.by['NO-CHECK']} 无入口 · \${fv.by['ENV-BLOCKED']||0} 环境受阻\` : '' });
  $('#kpis').innerHTML = cards.map(k => \`<div class="kpi \${k.c}"><div class="n">\${esc(k.n)}</div><div class="l">\${esc(k.l)}</div><div class="d">\${esc(k.d)}</div></div>\`).join('');
})();

/* ---------- Tab 框架 ---------- */
const TABS = [
  ['overview','总览'], ['diff','跨仓对拍'], ['isa','ISA 交叉索引'],
  ['variant','变体审计'], ['fleetverify','舰队验证'], ['fleetindex','舰队索引']
];
$('#tabs').innerHTML = TABS.map((t,i) => \`<button class="tab \${i===0?'on':''}" data-v="\${t[0]}">\${t[1]}</button>\`).join('');
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(x => x.classList.remove('on'));
  $('#view-' + b.dataset.v).classList.add('on');
});
$('#built').textContent = (DATA.generatedAt || '').replace('T',' ').slice(0,19);

/* ============================================================================
 * 视图 1 · 总览：十层架构 + 设计说明
 * ==========================================================================*/
(function renderOverview(){
  const LAYERS = [
    ['L0','引导层','进程/沙箱/确定性种子 · 零依赖启动'],
    ['L1','数学内核','线代 / 微积分 / 数值 · 机器精度契约'],
    ['L2','概率统计','分布 / 贝叶斯 / 信息论 · 散度非负'],
    ['L3','监督学习','回归 / 分类 / SVM / 树 · 残差⊥X'],
    ['L4','无监督学习','聚类 / 降维 / 密度 · SSE 单调不增'],
    ['L5','深度学习','前向 / 反向 / 注意力 · 梯度检验 1e-7'],
    ['L6','序列与生成','RNN/Transformer/扩散 · 对数似然单调'],
    ['L7','强化学习','MDP / 价值 / 策略 · Bellman 残差→0'],
    ['L8','概率图模型','推断 / 采样 / EM · 后验和=1'],
    ['L9','编排层','管线 / 调度 / 自适应 · 端到端复现'],
    ['L10','微指令 ISA','1024 微指令 × 4 变体 · 不变量门禁'],
    ['治理','融合层','对拍 / 交叉索引 / 变体闭合 / 舰队验证']
  ];
  const COLORS = ['#22d3ee','#38bdf8','#60a5fa','#818cf8','#8b5cf6','#a78bfa','#c084fc','#f472b6','#fb7185','#fbbf24','#34d399','#34d399'];
  $('#view-overview').innerHTML = \`
  <div class="panel">
    <h2><span class="dot"></span>十层架构 × 1024 微指令 × 4 变体</h2>
    <div class="hint">两套 ISA 设计正交：AXIOM 回答「有哪些算子」，flagship-ai L10 回答「哪些代数律成立」。融合层把两者对齐为可互证的整体。</div>
    <div class="layers">
      \${LAYERS.map((l,i) => \`
        <div class="layer">
          <div class="no">\${l[0]}</div>
          <div class="nm">\${l[1]}</div>
          <div class="ds">\${l[2]}</div>
          <div class="bar"><i style="width:\${Math.round((i+1)/LAYERS.length*100)}%;background:\${COLORS[i]}"></i></div>
        </div>\`).join('')}
    </div>
  </div>

  <div class="panel">
    <h2><span class="dot" style="background:var(--purple);box-shadow:0 0 8px var(--purple)"></span>融合层做了什么（零重写）</h2>
    <div class="hint">不新写任何算法；只把各仓【已经写好的】实现放在一起对拍、对齐、审计。</div>
    <table>
      <thead><tr><th>能力</th><th>解决的问题</th><th>实测结果</th><th>不变量</th></tr></thead>
      <tbody>
        <tr><td class="mono">differential.js</td><td>同名不同义：gelu 精确/tanh 近似、crossEntropy log2/log、layernorm 按行/展平、erf 近似精度差 8 个数量级</td><td class="mono">\${DATA.differential ? DATA.differential.total : 0} 项语义契约 · \${DATA.differential ? DATA.differential.failed : 0} 破约</td><td>多实现两两互证 + 高精度参照三方校验</td></tr>
        <tr><td class="mono">isa-crosswalk.js</td><td>两套 ISA 无映射，无法回答「这个算子有没有对应实现」</td><td class="mono">\${DATA.crosswalk ? DATA.crosswalk.axiomOps.length : 0} 算子 × 4 变体对齐</td><td>每算子恰 4 变体 · 每族恰 64 条</td></tr>
        <tr><td class="mono">variant-closer.js</td><td>213 条 spec-only 缺口，无法判断「缺算法」还是「属性不成立」</td><td class="mono">\${DATA.variant ? DATA.variant.total : 0} 条逐条审计 · \${DATA.variant ? DATA.variant.closed : 0} 条可闭合</td><td>原地结果 ≡ out-of-place 逐位一致</td></tr>
        <tr><td class="mono">fleet-verify.js</td><td>301 仓各自绿，但看不到舰队整体健康度</td><td class="mono">\${DATA.fleetVerify ? DATA.fleetVerify.green + '/' + DATA.fleetVerify.checked : '—'} 有自检仓通过</td><td>单命令聚合 + 门禁退出码 + 超时降级如实记账</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel">
    <h2><span class="dot" style="background:var(--green);box-shadow:0 0 8px var(--green)"></span>范式锚定（世界顶级成果）</h2>
    <div class="hint">每个治理能力都站在成熟范式之上，而非自创。</div>
    <table>
      <thead><tr><th>治理能力</th><th>范式来源</th><th>核心思想</th></tr></thead>
      <tbody>
        <tr><td>跨仓差分对拍</td><td>NIST 随机数检测套件 / 数值软件资格认证（如 GSL 的 reference implementations）</td><td>同一数学对象多个独立实现必须互证，单一实现只能算孤证</td></tr>
        <tr><td>三级判决 + 精度契约</td><td>IEEE 754 容差判据 / numpy.allclose 混合容差</td><td>绝对容差 OR 相对容差；纯相对误差在真值趋零处失真</td></tr>
        <tr><td>舰队统一验证</td><td>pytest / jest workspace runner + Bazel target aggregation</td><td>聚合既有 target，不重写测试</td></tr>
        <tr><td>变体缺口审计</td><td>编译器 ISA 完备性检查 / 属性测试（Hypothesis、QuickCheck）</td><td>区分「未实现」与「属性本不成立」</td></tr>
        <tr><td>超时降级</td><td>CI 的分层测试策略（full → smoke → unit）</td><td>如实标记降级，绝不把超时粉饰成通过</td></tr>
      </tbody>
    </table>
  </div>\`;
})();

/* ============================================================================
 * 视图 2 · 跨仓对拍
 * ==========================================================================*/
(function renderDiff(){
  const d = DATA.differential;
  if (!d) { $('#view-diff').innerHTML = '<div class="empty">无对拍数据</div>'; return; }
  const rows = d.results.map((r,i) => \`
    <div class="prim" data-i="\${i}">
      <div class="hd">
        <span class="pill \${r.verdict}">\${VERDICT_ZH[r.verdict]}</span>
        <span class="nm">\${esc(r.name)}</span>
        <span class="tag c">\${r.implCount} 实现</span>
        <span class="tag g">契约 \${fmtSci(r.fusionTol)}</span>
        \${r.recommended ? \`<span class="tag p">★ \${esc(r.recommended)}</span>\` : ''}
        <span class="rs">\${esc(r.reason || '')}</span>
      </div>
      <div class="bd">
        <dl class="kv">
          <dt>语义契约</dt><dd>最优精度档 \${fmtSci(r.fusionTol)} · \${r.implCount} 个独立实现参与</dd>
          <dt>融合推荐</dt><dd>\${r.recommended ? esc(r.recommended) + '（精度排序第一）' : '—（孤证，暂无互证）'}</dd>
          <dt>硬门禁</dt><dd>G1 多实现=\${r.gates.G1_multi_impl} · G2 两两一致=\${r.gates.G2_pairwise} · G3 契约内=\${r.gates.G3_contract} · G4 相对误差=\${r.gates.G4_rel}</dd>
        </dl>
        <h3>各仓实现 vs 高精度参照（Δ 与契约容差）</h3>
        <table class="mini"><thead><tr><th>仓库</th><th>定位符</th><th>Δ参照</th><th>契约</th><th>判定</th></tr></thead><tbody>
          \${r.refs.map(x => \`<tr><td class="mono">\${esc(x.src)}</td><td class="mono">\${esc(x.locator)}</td><td class="mono v \${x.dTruth===0?'g':(x.dTruth<=x.tol?'':'r')}">\${fmtSci(x.dTruth)}</td><td class="mono">\${fmtSci(x.tol)}</td><td>\${x.withinContract?'<span class="tag g">契约内</span>':'<span class="tag r">破约</span>'}</td></tr>\`).join('')}
        </tbody></table>
        \${r.pairwise && r.pairwise.length ? \`<h3>两两对拍（\${r.pairwise.length} 组）</h3>
        <table class="mini"><thead><tr><th>对</th><th>Δ</th><th>容差</th><th>判定</th></tr></thead><tbody>
        \${r.pairwise.slice(0,12).map(p => \`<tr><td class="mono">\${esc(p.a)} ↔ \${esc(p.b)}</td><td class="mono v \${p.d===0?'g':(p.ok?'':'r')}">\${fmtSci(p.d)}</td><td class="mono">\${fmtSci(p.tol)}</td><td>\${p.ok?'<span class="tag g">✓</span>':'<span class="tag r">✗</span>'}</td></tr>\`).join('')}
        \${r.pairwise.length>12?'<tr><td colspan="4" style="color:var(--txt3)">… 其余 '+(r.pairwise.length-12)+' 组</td></tr>':''}
        </tbody></table>\` : ''}
        \${r.errors && r.errors.length ? \`<h3>适配异常（如实记账）</h3>\${r.errors.map(e => \`<div class="mono" style="color:var(--amber);font-size:11.5px">⚠ \${esc(e.src)}: \${esc(e.error)}</div>\`).join('')}\` : ''}
        \${r.precisionRanking && r.precisionRanking.length>1 ? \`<h3>精度排序（Δ 参照越小越准）</h3><div class="mono" style="font-size:11.5px;color:var(--txt2)">\${r.precisionRanking.map(p=>esc(p.src)+'('+fmtSci(p.dTruth)+')').join(' <span style="color:var(--txt3)">&gt;</span> ')}</div>\` : ''}
      </div>
    </div>\`).join('');
  $('#view-diff').innerHTML = \`
  <div class="panel">
    <h2><span class="dot"></span>跨仓差分对拍 · \${d.total} 项语义契约</h2>
    <div class="hint">各仓自测全绿 ≠ 跨仓一致。同名不同义（gelu 精确/tanh、crossEntropy log2/log、erf 近似精度）只有对拍才看得出。判据：多实现两两互证 + 高精度参照三方校验；G4 采用 numpy.allclose 混合容差（绝对 OR 相对），纯相对误差在真值趋零处会失真。</div>
    <div class="toolbar">
      <button class="btn on" data-f="all">全部 \${d.total}</button>
      <button class="btn" data-f="GREEN">🟢 全绿 \${d.byVerdict.GREEN}</button>
      <button class="btn" data-f="DEGRADED">🟠 降级 \${d.byVerdict.DEGRADED}</button>
      <button class="btn" data-f="SOLO">🟡 孤证 \${d.byVerdict.SOLO}</button>
      <button class="btn" data-f="RED">🔴 破约 \${d.byVerdict.RED}</button>
      <span class="count" id="diffcount"></span>
    </div>
    <div id="diffrows">\${rows}</div>
  </div>\`;
  $('#view-diff .toolbar').addEventListener('click', e => {
    const b = e.target.closest('.btn'); if (!b) return;
    $('#view-diff .toolbar').querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
    const f = b.dataset.f;
    document.querySelectorAll('#diffrows .prim').forEach(p => {
      const v = DATA.differential.results[+p.dataset.i].verdict;
      p.style.display = (f === 'all' || v === f) ? '' : 'none';
    });
    $('#diffcount').textContent = f === 'all' ? d.total + ' 项' : d.byVerdict[f] + ' 项';
  });
  $('#diffrows').addEventListener('click', e => {
    const hd = e.target.closest('.prim > .hd'); if (!hd) return;
    hd.parentElement.classList.toggle('open');
  });
  $('#diffcount').textContent = d.total + ' 项';
})();

/* ============================================================================
 * 视图 3 · ISA 交叉索引
 * ==========================================================================*/
(function renderISA(){
  const c = DATA.crosswalk;
  if (!c) { $('#view-isa').innerHTML = '<div class="empty">无交叉索引数据</div>'; return; }
  const vc = c.variantCoverage;
  const groups = {};
  c.axiomOps.forEach(o => { (groups[o.group] = groups[o.group] || []).push(o); });
  const gkeys = Object.keys(groups).sort();

  $('#view-isa').innerHTML = \`
  <div class="panel">
    <h2><span class="dot"></span>AXIOM 1024 微指令 × flagship-ai 十层 ISA 交叉索引</h2>
    <div class="hint">\${esc(c.designNote || '')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0">
      \${['base','batched','fused','inplace'].map(v => \`
        <div style="background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px">
          <div style="font-size:11px;color:var(--txt3);font-family:var(--mono)">\${v}</div>
          <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:\${v==='inplace'?'var(--amber)':'var(--cyan)'}">\${vc.perVariant[v]}</div>
          <div class="prog" style="margin-top:6px"><i style="width:\${(vc.perVariant[v]/vc.possible*100).toFixed(1)}%"></i></div>
        </div>\`).join('')}
    </div>
    <div class="mono" style="font-size:12px;color:var(--txt2)">合计 <b style="color:var(--cyan)">\${vc.verified}</b> / \${vc.possible} = <b style="color:var(--green)">\${fmtPct(vc.coverage)}</b></div>
  </div>

  <div class="panel">
    <h2><span class="dot" style="background:var(--purple);box-shadow:0 0 8px var(--purple)"></span>算子族分布（\${gkeys.length} 族 × 每族 64 条）</h2>
    <div class="hint">每族恰 64 条微指令 = 16 算子 × 4 变体（base / batched / fused / inplace）。</div>
    <div class="toolbar">
      <input type="search" id="isaq" placeholder="搜索算子 / 不变量关键词…">
      <select id="isag">
        <option value="">全部 \${gkeys.length} 族</option>
        \${gkeys.map(g => \`<option value="\${esc(g)}">\${esc(g)}（\${groups[g].length}）</option>\`).join('')}
      </select>
      <span class="count" id="isacount"></span>
    </div>
    <div style="overflow-x:auto">
    <table><thead><tr><th>ID</th><th>算子</th><th>语义</th><th>标签</th><th>base</th><th>batched</th><th>fused</th><th>inplace</th><th>硬不变量</th></tr></thead>
    <tbody id="isabody"></tbody></table>
    </div>
  </div>

  <div class="panel">
    <h2><span class="dot" style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></span>flagship-ai 十层域覆盖</h2>
    <div class="hint">L10 以「代数律」为轴：每域 128 槽，覆盖对应标签族的算子。</div>
    <table><thead><tr><th>域</th><th>槽位</th><th>已实现</th><th>覆盖标签</th></tr></thead><tbody>
      \${c.flagshipDomains.map(d => \`<tr><td class="mono v c">\${esc(d.domain)}</td><td class="mono">\${d.slots}</td><td class="mono v \${d.impl===d.slots?'g':'a'}">\${d.impl}</td><td>\${(d.tags||[]).map(t=>\`<span class="tag">\${esc(t)}</span>\`).join('')}</td></tr>\`).join('')}
    </tbody></table>
  </div>\`;

  const vpill = st => st === 'verified' ? '<span class="tag g">✓</span>' : '<span class="tag a">spec</span>';
  function drawISA(){
    const q = ($('#isaq').value || '').toLowerCase();
    const g = $('#isag').value;
    const rows = c.axiomOps.filter(o => {
      if (g && o.group !== g) return false;
      if (!q) return true;
      return (o.key + ' ' + (o.opZh||'') + ' ' + (o.invariant||'') + ' ' + (o.tags||[]).join(' ')).toLowerCase().includes(q);
    });
    $('#isabody').innerHTML = rows.slice(0, 300).map(o => \`
      <tr>
        <td class="mono" style="color:var(--txt3)">\${esc(o.variants.base.id)}</td>
        <td class="mono v c">\${esc(o.key)}</td>
        <td>\${esc(o.opZh || '')}</td>
        <td>\${(o.tags||[]).map(t=>\`<span class="tag">\${esc(t)}</span>\`).join('')}</td>
        <td>\${vpill(o.variants.base.status)}</td>
        <td>\${vpill(o.variants.batched.status)}</td>
        <td>\${vpill(o.variants.fused.status)}</td>
        <td>\${vpill(o.variants.inplace.status)}</td>
        <td style="color:var(--txt2);font-size:11.5px">\${esc(o.invariant || '')}</td>
      </tr>\`).join('') + (rows.length > 300 ? \`<tr><td colspan="9" style="color:var(--txt3)">… 其余 \${rows.length-300} 条已折叠（共 \${rows.length} 条命中）</td></tr>\` : '');
    $('#isacount').textContent = rows.length + ' / ' + c.axiomOps.length + ' 算子';
  }
  $('#isaq').addEventListener('input', drawISA);
  $('#isag').addEventListener('change', drawISA);
  drawISA();
})();

/* ============================================================================
 * 视图 4 · 变体审计
 * ==========================================================================*/
(function renderVariant(){
  const v = DATA.variant;
  if (!v) { $('#view-variant').innerHTML = '<div class="empty">无变体审计数据</div>'; return; }
  const byReason = {};
  v.results.forEach(r => {
    const k = r.closed ? '可闭合（逐位一致）' :
      (r.shapePreserving === false ? '形状不守恒 → 原地语义本不成立' :
      (r.reason || '').replace(/[:：].*$/, '').slice(0, 40) || '其他');
    (byReason[k] = byReason[k] || []).push(r);
  });
  $('#view-variant').innerHTML = \`
  <div class="panel">
    <h2><span class="dot" style="background:var(--amber);box-shadow:0 0 8px var(--amber)"></span>213 条 spec-only 缺口的诚实审计</h2>
    <div class="hint">关键结论：缺口【不等于】缺算法。审计逐条判定「可闭合」vs「属性本不成立」，绝不把形状不守恒的算子（reshape / QR / eig / concat / split）粉饰成待实现。</div>
    <div class="kpis" style="margin:14px 0">
      <div class="kpi c4"><div class="n">\${v.total}</div><div class="l">审计缺口总数</div><div class="d">inplace \${v.byVariant.inplace.total} · batched \${v.byVariant.batched.total} · fused \${v.byVariant.fused.total}</div></div>
      <div class="kpi c2"><div class="n">\${v.closed}</div><div class="l">可闭合（已通过逐位一致）</div><div class="d">收割既有 base 实现组合</div></div>
      <div class="kpi c1"><div class="n">\${v.results.filter(r=>r.shapePreserving===false).length}</div><div class="l">形状不守恒（属性判定）</div><div class="d">原地语义本就不成立</div></div>
      <div class="kpi c3"><div class="n">\${fmtPct(v.isaCoverageAfter.coverage || v.isaCoverageAfter)}</div><div class="l">闭合后 ISA 覆盖</div><div class="d">从 \${fmtPct(v.isaCoverageBefore.coverage || v.isaCoverageBefore)}</div></div>
    </div>
    <h3>按审计结论分组</h3>
    <table><thead><tr><th>审计结论</th><th>条数</th><th>性质</th></tr></thead><tbody>
      \${Object.keys(byReason).sort((a,b)=>byReason[b].length-byReason[a].length).map(k => \`
        <tr><td>\${esc(k)}</td><td class="mono v">\${byReason[k].length}</td><td>\${byReason[k][0].closed ? '<span class="tag g">可闭合</span>' : (byReason[k][0].shapePreserving===false ? '<span class="tag a">属性不成立</span>' : '<span class="tag r">缺签名表/样本</span>')}</td></tr>\`).join('')}
    </tbody></table>
  </div>
  <div class="panel">
    <h2><span class="dot"></span>逐条明细</h2>
    <div class="toolbar">
      <input type="search" id="vq" placeholder="搜索算子 / 原因…">
      <button class="btn on" data-vf="all">全部 \${v.total}</button>
      <button class="btn" data-vf="closed">可闭合 \${v.closed}</button>
      <button class="btn" data-vf="shape">形状不守恒 \${v.results.filter(r=>r.shapePreserving===false).length}</button>
      <span class="count" id="vcount"></span>
    </div>
    <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>算子</th><th>变体</th><th>方法</th><th>审计结论</th></tr></thead><tbody id="vbody"></tbody></table></div>
  </div>\`;
  function drawV(){
    const q = ($('#vq').value || '').toLowerCase();
    const f = $('#view-variant .toolbar .btn.on') ? $('#view-variant .toolbar .btn.on').dataset.vf : 'all';
    const rows = v.results.filter(r => {
      if (f === 'closed' && !r.closed) return false;
      if (f === 'shape' && r.shapePreserving !== false) return false;
      if (!q) return true;
      return (r.op + ' ' + (r.reason||'') + ' ' + (r.method||'')).toLowerCase().includes(q);
    });
    $('#vbody').innerHTML = rows.slice(0, 300).map(r => \`
      <tr>
        <td class="mono" style="color:var(--txt3)">\${esc(r.id)}</td>
        <td class="mono v c">\${esc(r.op)}</td>
        <td><span class="tag p">\${esc(r.variant)}</span></td>
        <td style="font-size:11.5px;color:var(--txt2)">\${esc(r.method || '—')}</td>
        <td style="font-size:11.5px">\${r.closed ? '<span class="tag g">'+esc(r.reason)+'</span>' : (r.shapePreserving===false ? '<span class="tag a">'+esc(r.reason)+'</span>' : '<span class="tag r">'+esc(r.reason)+'</span>')}</td>
      </tr>\`).join('') + (rows.length>300 ? \`<tr><td colspan="5" style="color:var(--txt3)">… 其余 \${rows.length-300} 条已折叠</td></tr>\` : '');
    $('#vcount').textContent = rows.length + ' / ' + v.total;
  }
  $('#vq').addEventListener('input', drawV);
  $('#view-variant .toolbar').addEventListener('click', e => {
    const b = e.target.closest('.btn'); if (!b) return;
    $('#view-variant .toolbar').querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
    drawV();
  });
  drawV();
})();

/* ============================================================================
 * 视图 5 · 舰队验证
 * ==========================================================================*/
(function renderFleetVerify(){
  const fv = DATA.fleetVerify;
  if (!fv) {
    $('#view-fleetverify').innerHTML = \`<div class="panel"><h2><span class="dot"></span>舰队统一验证</h2>
      <div class="empty">全舰队验证仍在后台运行（210 仓，慢仓需数分钟）。<br>完成后执行 <span class="mono">node src/fleet-verify.js --json data/fleet-verify-full.json</span> 再重建本仪表盘。</div></div>\`;
    return;
  }
  const order = { FAIL:0, TIMEOUT:1, 'ENV-BLOCKED':2, 'PASS-CORE':3, 'NO-CHECK':4, PASS:5 };
  const rows = fv.results.slice().sort((a,b) => (order[a.status]-order[b.status]) || a.name.localeCompare(b.name));
  $('#view-fleetverify').innerHTML = \`
  <div class="panel">
    <h2><span class="dot"></span>舰队统一验证 · \${fv.total} 仓</h2>
    <div class="hint">单命令聚合各仓既有自检入口（npm test / node test/run.js / src/verify.js）。超时降级到轻量入口并如实标记 PASS-CORE，绝不把超时粉饰成通过。退出码 0 = 全体绿。</div>
    <div class="hint" style="margin-top:6px">📌 基线快照：\${fv.snapshotAt ? new Date(fv.snapshotAt).toLocaleString('zh-CN') : '时间未知'} —— 早于依赖自治修复（venv 栈 / npm install / 入口覆盖），故 FAIL 中含大量「环境受阻」而非代码缺陷的仓；修复后对 6 个关键仓抽查 <b>6/6 全绿</b>（明细见 README「依赖自治与诚实记账」与 data/spot-check.json）。</div>
    <div class="kpis" style="margin:14px 0">
      <div class="kpi c2"><div class="n">\${fv.by.PASS}</div><div class="l">✅ 全量通过</div></div>
      <div class="kpi c4"><div class="n">\${fv.by['PASS-CORE']}</div><div class="l">🟡 降级绿（全量超时）</div></div>
      <div class="kpi c1"><div class="n">\${fv.by.FAIL}</div><div class="l">❌ 失败</div></div>
      <div class="kpi c3"><div class="n">\${fv.by.TIMEOUT}</div><div class="l">⏱️ 超时（无降级）</div></div>
      <div class="kpi c5"><div class="n">\${fv.by['ENV-BLOCKED']||0}</div><div class="l">🔧 环境受阻（非代码缺陷）</div></div>
      <div class="kpi"><div class="n">\${fv.by['NO-CHECK']}</div><div class="l">➖ 无自检入口</div></div>
    </div>
    <div class="mono" style="font-size:12px;color:var(--txt2);margin-bottom:10px">有自检子集通过率 <b style="color:var(--green)">\${fv.checked ? fmtPct(fv.green/fv.checked) : '—'}</b> · 门禁 <b style="color:\${fv.allPass?'var(--green)':'var(--red)'}">\${fv.allPass?'通过':'未通过'}</b>\${fv.python ? ' · Python ' + fv.python.split(/[\\\\/]/).pop() + (fv.pythonProbed ? '（依赖栈已验证）' : '（⚠️ 依赖栈未就绪）') : ''}</div>
    <div class="toolbar">
      <input type="search" id="fvq" placeholder="搜索仓库…">
      <button class="btn on" data-s="all">全部 \${fv.total}</button>
      <button class="btn" data-s="notpass">非全绿 \${fv.total - fv.by.PASS}</button>
      <span class="count" id="fvcount"></span>
    </div>
    <div style="overflow-x:auto"><table><thead><tr><th>状态</th><th>仓库</th><th>入口</th><th>通过/总数</th><th>耗时</th><th>摘要</th></tr></thead><tbody id="fvbody"></tbody></table></div>
  </div>\`;
  function drawFV(){
    const q = ($('#fvq').value || '').toLowerCase();
    const s = $('#view-fleetverify .toolbar .btn.on').dataset.s;
    const rr = rows.filter(r => {
      if (s === 'notpass' && r.status === 'PASS') return false;
      if (!q) return true;
      return (r.name + ' ' + (r.entry||'') + ' ' + (r.summary||'')).toLowerCase().includes(q);
    });
    $('#fvbody').innerHTML = rr.map(r => \`
      <tr title="\${(STATUS_DESC[r.status]||'').replace(/"/g,'&quot;')}\${r.overrideReason ? ' · ' + r.overrideReason.replace(/"/g,'&quot;') : ''}">
        <td>\${STATUS_MARK[r.status]} <span class="tag \${r.status==='PASS'?'g':(r.status==='PASS-CORE'?'a':(r.status==='FAIL'||r.status==='TIMEOUT'?'r':(r.status==='ENV-BLOCKED'?'a':'')))}">\${STATUS_ZH[r.status]}</span>\${r.substituted?' <span class="tag a" title="聚合仓子模块为空占位，由兄弟仓代行验证">代行</span>':''}</td>
        <td class="mono v">\${esc(r.name)}</td>
        <td class="mono" style="font-size:11px;color:var(--txt3)">\${esc(r.entry || '—')}</td>
        <td class="mono">\${r.pass != null ? r.pass + '/' + r.total : '—'}</td>
        <td class="mono">\${fmtSec(r.ms)}</td>
        <td style="font-size:11.5px;color:var(--txt2)">\${esc(r.summary || r.reason || '')}\${r.degradedFrom ? ' <span style="color:var(--amber)">（降级自 '+esc(r.degradedFrom)+'）</span>' : ''}</td>
      </tr>\`).join('');
    $('#fvcount').textContent = rr.length + ' / ' + fv.total;
  }
  $('#fvq').addEventListener('input', drawFV);
  $('#view-fleetverify .toolbar').addEventListener('click', e => {
    const b = e.target.closest('.btn'); if (!b) return;
    $('#view-fleetverify .toolbar').querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
    drawFV();
  });
  drawFV();
})();

/* ============================================================================
 * 视图 6 · 舰队索引
 * ==========================================================================*/
(function renderFleetIndex(){
  const F = DATA.fleet;
  $('#view-fleetindex').innerHTML = \`
  <div class="panel">
    <h2><span class="dot" style="background:var(--pink);box-shadow:0 0 8px var(--pink)"></span>旗舰舰队索引 · \${F.length} 仓</h2>
    <div class="hint">GitHub 元数据快照（\${esc(DATA.generatedAt.slice(0,10))}）。「零重写」第一步：先知道舰队里已经有什么。</div>
    <div class="toolbar">
      <input type="search" id="fq" placeholder="搜索仓库名 / 描述…">
      <select id="fsort">
        <option value="updated">最近更新</option>
        <option value="created">创建时间</option>
        <option value="stars">Star 数</option>
        <option value="disk">体积</option>
        <option value="name">名称</option>
      </select>
      <span class="count" id="fcount"></span>
    </div>
    <div style="overflow-x:auto"><table><thead><tr><th>仓库</th><th>主语言</th><th>许可</th><th>★</th><th>体积 KB</th><th>创建</th><th>更新</th><th>描述</th></tr></thead><tbody id="fbody"></tbody></table></div>
  </div>\`;
  function drawF(){
    const q = ($('#fq').value || '').toLowerCase();
    const s = $('#fsort').value;
    const rr = F.filter(r => !q || (r.name + ' ' + r.desc).toLowerCase().includes(q));
    const cmp = {
      updated: (a,b) => (b.updated||'').localeCompare(a.updated||''),
      created: (a,b) => (b.created||'').localeCompare(a.created||''),
      stars: (a,b) => b.stars - a.stars,
      disk: (a,b) => b.disk - a.disk,
      name: (a,b) => a.name.localeCompare(b.name)
    }[s];
    rr.sort(cmp);
    $('#fbody').innerHTML = rr.slice(0, 400).map(r => \`
      <tr>
        <td class="mono"><a href="\${esc(r.url)}" target="_blank" rel="noopener">\${esc(r.name)}</a>\${r.fork?' <span class="tag">fork</span>':''}\${r.archived?' <span class="tag r">归档</span>':''}</td>
        <td><span class="tag">\${esc(r.lang)}</span></td>
        <td class="mono" style="font-size:11px;color:var(--txt3)">\${esc(r.license)}</td>
        <td class="mono">\${r.stars || ''}</td>
        <td class="mono">\${r.disk || ''}</td>
        <td class="mono" style="font-size:11px;color:var(--txt3)">\${esc(r.created)}</td>
        <td class="mono" style="font-size:11px;color:var(--txt3)">\${esc(r.updated)}</td>
        <td style="font-size:11.5px;color:var(--txt2)">\${esc(r.desc)}</td>
      </tr>\`).join('') + (rr.length>400 ? \`<tr><td colspan="8" style="color:var(--txt3)">… 其余 \${rr.length-400} 仓已折叠</td></tr>\` : '');
    $('#fcount').textContent = rr.length + ' / ' + F.length;
  }
  $('#fq').addEventListener('input', drawF);
  $('#fsort').addEventListener('change', drawF);
  drawF();
})();
</script>
</body>
</html>`;
}
