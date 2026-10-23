#!/usr/bin/env node
/**
 * fleet-fetch.js —— 舰队源码快照收割器
 *
 * 背景：治理层的被测对象是 301 个旗舰仓的源码快照。README「数据来源」一节
 *       承诺 `node tools/fleet-fetch.js` 可重新生成 `.cache/fleet/`，
 *       本工具即为该承诺的实现——此前快照由会话内临时脚本产出，未入库，
 *       导致「可复现」链路断了一环。
 *
 * 收割方式（与快照既有属性一致）：
 *   - codeload tarball（codeload.github.com/<org>/<repo>/tar.gz/HEAD）
 *   - 解包后顶层目录恒为 `<repo>-HEAD/`，移至 fleet/<repo>/
 *   - tarball 不含 git submodule 内容（与既有快照结构一致，
 *     聚合仓的子模块空占位由 fleet-verify 的 substitute 机制代验）
 *
 * 设计原则：
 *   - 零依赖：仅 Node 标准库 + 系统 tar（Win10 17063+/Git Bash/macOS/Linux 均内置）
 *   - 并发池：默认 4 路，逐仓隔离，单仓 120s 硬超时
 *   - 如实记账：ok / skipped / notfound / error 四态分账，
 *     404（私有或已删）与网络失败分开记，绝不静默跳过
 *
 * 用法：
 *   node tools/fleet-fetch.js                 # 按 .cache/repos.json 全量收割
 *   node tools/fleet-fetch.js --list          # 只列将要收割的仓，不动网络
 *   node tools/fleet-fetch.js --only a,b,c    # 只收割指定仓
 *   node tools/fleet-fetch.js --force         # 重新下载已存在的仓
 *   node tools/fleet-fetch.js --json out.json # 结果落盘
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FLEET = process.env.FUSION_FLEET || path.join(ROOT, '..', '.cache', 'fleet');
const DEFAULT_MANIFEST = process.env.FUSION_MANIFEST || path.join(ROOT, '..', '.cache', 'repos.json');
const DEFAULT_ORG = 'CJX0712';
const PER_REPO_TIMEOUT = 120 * 1000;
const DEFAULT_CONCURRENCY = 4;

const LOG = [];
function log(s) {
  const line = typeof s === 'string' ? s : JSON.stringify(s);
  LOG.push(line);
  process.stdout.write(line + '\n');
}

/* ---------------------------------------------------------------------------
 * 参数解析
 * -------------------------------------------------------------------------*/
function parseArgs(argv) {
  const opts = {
    fleet: DEFAULT_FLEET, manifest: DEFAULT_MANIFEST, org: DEFAULT_ORG,
    only: [], force: false, list: false, dryRun: false, json: null,
    concurrency: DEFAULT_CONCURRENCY
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && argv[i + 1]) { opts.only.push(...argv[i + 1].split(',').filter(Boolean)); i++; }
    else if (a === '--force') opts.force = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json' && argv[i + 1]) { opts.json = argv[i + 1]; i++; }
    else if (a === '--org' && argv[i + 1]) { opts.org = argv[i + 1]; i++; }
    else if (a === '--concurrency' && argv[i + 1]) { opts.concurrency = Math.max(1, Number(argv[i + 1]) || 1); i++; }
    else if (a === '--fleet' && argv[i + 1]) { opts.fleet = argv[i + 1]; i++; }
    else if (a === '--manifest' && argv[i + 1]) { opts.manifest = argv[i + 1]; i++; }
    else if (a === '--help' || a === '-h') {
      log('用法：node tools/fleet-fetch.js [--list] [--only a,b,c] [--force] [--dry-run] [--json out.json] [--org NAME] [--concurrency N]');
      process.exit(0);
    }
  }
  return opts;
}

/* ---------------------------------------------------------------------------
 * 清单装载：.cache/repos.json（GitHub GraphQL 快照，301 仓）
 * 每条至少含 name；org 优先从 url 字段解析，回退 --org / 默认 CJX0712
 * -------------------------------------------------------------------------*/
function loadManifest(manifestPath, orgFallback) {
  if (!fs.existsSync(manifestPath)) {
    return { error: `清单不存在：${manifestPath}（可设 FUSION_MANIFEST 指向 repos.json）` };
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { error: `清单解析失败：${e.message}` }; }
  const arr = Array.isArray(raw) ? raw : (raw.repos || Object.values(raw));
  const repos = [];
  for (const item of arr) {
    const name = item.name || item.repo || item.full_name;
    if (!name) continue;
    let org = orgFallback;
    const m = typeof item.url === 'string' && item.url.match(/github\.com\/([^/]+)\//);
    if (m) org = m[1];
    repos.push({ name: String(name).replace(/^.*\//, ''), org });
  }
  return { repos };
}

/* ---------------------------------------------------------------------------
 * 下载：https 直连，跟随 3xx，写临时文件
 * -------------------------------------------------------------------------*/
function download(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, dest, timeoutMs));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`下载超时（>${timeoutMs}ms）`)));
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
  });
}

/* ---------------------------------------------------------------------------
 * 解包：系统 tar 解到 staging，把唯一顶层目录（<repo>-HEAD/）移到目标位
 * -------------------------------------------------------------------------*/
function extract(tgz, staging, name) {
  // Windows 陷阱（实测）：tar 会把含冒号的绝对路径（C:\...\x.tar.gz）当成
  // host:path 远程语法，报「Cannot connect to C: resolve failed」。
  // 规避：cwd 切到 tgz 所在目录，只传 basename —— 无冒号即无歧义。
  const base = path.dirname(tgz);
  const r = spawnSync('tar', ['-xzf', path.basename(tgz), '-C', path.basename(staging)], {
    encoding: 'utf8', timeout: 60000, cwd: base
  });
  if (r.status !== 0) {
    return { ok: false, error: `tar 解包失败：${(r.stderr || r.error || '').toString().trim().slice(0, 200)}` };
  }
  const tops = fs.readdirSync(staging).filter(f => fs.statSync(path.join(staging, f)).isDirectory());
  if (tops.length !== 1) {
    return { ok: false, error: `顶层目录数=${tops.length}，预期 1（tarball 结构异常）` };
  }
  const top = tops[0];
  if (!top.startsWith(`${name}-`)) {
    return { ok: false, error: `顶层目录 ${top} 与仓名 ${name} 不符` };
  }
  return { ok: true, top };
}

/* ---------------------------------------------------------------------------
 * 单仓收割（完整生命周期，任何一步失败都如实记账）
 * -------------------------------------------------------------------------*/
async function fetchOne(repo, opts) {
  const dest = path.join(opts.fleet, repo.name);
  if (!opts.force && fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return { name: repo.name, status: 'skipped', reason: '快照已存在' };
  }
  if (opts.dryRun) {
    return { name: repo.name, status: 'ok', reason: 'dry-run（未动网络）', dryRun: true };
  }
  const tmpTgz = path.join(os.tmpdir(), `fleet-fetch-${repo.name}-${process.pid}.tar.gz`);
  const staging = path.join(os.tmpdir(), `fleet-fetch-${repo.name}-${process.pid}-x`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    const url = `https://codeload.github.com/${repo.org}/${repo.name}/tar.gz/HEAD`;
    await download(url, tmpTgz, PER_REPO_TIMEOUT);
    const ex = extract(tmpTgz, staging, repo.name);
    if (!ex.ok) return { name: repo.name, status: 'error', reason: ex.error };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    // 跨盘 rename 会 EXDEV（tmp 与工作区常在不同卷）→ 回退递归拷贝
    try {
      fs.renameSync(path.join(staging, ex.top), dest);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(path.join(staging, ex.top), dest, { recursive: true });
    }
    const files = fs.readdirSync(dest).length;
    return { name: repo.name, status: 'ok', reason: `${files} 个顶层条目` };
  } catch (e) {
    const notFound = /HTTP 404/.test(e.message);
    return {
      name: repo.name,
      status: notFound ? 'notfound' : 'error',
      reason: notFound ? '404（私有仓、已删除或名称不符）' : e.message
    };
  } finally {
    try { fs.unlinkSync(tmpTgz); } catch (_) {}
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ---------------------------------------------------------------------------
 * 并发池：N 路 worker 从队列取活，逐仓隔离
 * -------------------------------------------------------------------------*/
async function runPool(items, n, worker) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const it = items[idx++];
      results.push(await worker(it));
    }
  });
  await Promise.all(runners);
  return results;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * -------------------------------------------------------------------------*/
(async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const loaded = loadManifest(opts.manifest, opts.org);
  if (loaded.error) { log(`✗ ${loaded.error}`); process.exit(2); }

  let repos = loaded.repos;
  if (opts.only.length) {
    const want = new Set(opts.only);
    repos = repos.filter(r => want.has(r.name));
    const missing = [...want].filter(w => !repos.some(r => r.name === w));
    if (missing.length) log(`⚠ 清单中不存在：${missing.join(', ')}`);
  }
  log(`清单 ${loaded.repos.length} 仓 → 本轮目标 ${repos.length} 仓（org 默认 ${opts.org}，并发 ${opts.concurrency}）`);

  if (opts.list) {
    for (const r of repos) log(`  ${r.org}/${r.name}`);
    log(`--list：仅列举，未动网络。目标目录 ${opts.fleet}`);
    process.exit(0);
  }
  if (opts.dryRun) log('--dry-run：不下载不解包，只走存在性判定。');

  const t0 = Date.now();
  const results = await runPool(repos, opts.concurrency, (r) => fetchOne(r, opts));
  const by = { ok: 0, skipped: 0, notfound: 0, error: 0 };
  for (const r of results) {
    by[r.status] = (by[r.status] || 0) + 1;
    const mark = { ok: '✓', skipped: '○', notfound: '✗', error: '!' }[r.status] || '?';
    if (r.status !== 'ok' || process.env.FUSION_VERBOSE) log(` ${mark} ${r.name} —— ${r.reason}`);
  }
  const bad = results.filter(r => r.status === 'error');
  log('');
  log(`收割完成（${((Date.now() - t0) / 1000).toFixed(1)}s）：✓${by.ok} 已收割 · ○${by.skipped} 已存在 · ✗${by.notfound} 404 · !${by.error} 错误`);
  if (bad.length) {
    log('');
    log('错误明细（需人工排查）：');
    for (const r of bad) log(`  ! ${r.name} —— ${r.reason}`);
  }
  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify({
      generatedAt: new Date().toISOString(), fleet: opts.fleet, manifest: opts.manifest,
      total: results.length, by, results
    }, null, 2));
    log(`结果已落盘：${opts.json}`);
  }
  process.exit(by.error > 0 ? 1 : 0);
})();
