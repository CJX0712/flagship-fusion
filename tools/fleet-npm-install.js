#!/usr/bin/env node
/**
 * fleet-npm-install.js —— 舰队依赖自治安装器
 *
 * 背景：舰队源码以 GitHub tarball 收割，快照不含 node_modules，
 *       导致 19 个 npm 仓的测试全部报「缺依赖」而非真失败。
 * 本工具逐仓 npm install，如实记账：成功 / 失败 / 超时。
 *
 * 设计原则（对齐「自治修复一切依赖」授权）：
 *   - 逐仓隔离：一个仓装失败不影响其余仓
 *   - 硬超时：单仓 6 分钟，防止个别仓把整体拖死
 *   - 如实记账：不把「装不上」粉饰成「测试通过」
 *
 * 用法：node tools/fleet-npm-install.js [--list] [--only a,b,c]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FLEET = process.env.FUSION_FLEET || path.join(ROOT, '..', '.cache', 'fleet');
const PER_REPO_TIMEOUT = 6 * 60 * 1000;
const LOG = [];

const NPM_FLAGS = [
  'install',
  '--no-audit',
  '--no-fund',
  '--loglevel=error',
  '--prefer-offline'
];

function log(s) {
  const line = typeof s === 'string' ? s : JSON.stringify(s);
  LOG.push(line);
  process.stdout.write(line + '\n');
}

function npmCandidates() {
  if (!fs.existsSync(FLEET)) return [];
  return fs.readdirSync(FLEET, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const pkg = path.join(FLEET, name, 'package.json');
      if (!fs.existsSync(pkg)) return false;
      if (fs.existsSync(path.join(FLEET, name, 'node_modules'))) return false;
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        return !!(j.dependencies || j.devDependencies);
      } catch (_) { return false; }
    })
    .sort();
}

function installOne(name) {
  const dir = path.join(FLEET, name);
  const t0 = Date.now();
  const r = spawnSync('npm', NPM_FLAGS, {
    cwd: dir,
    timeout: PER_REPO_TIMEOUT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: true,
    env: Object.assign({}, process.env, {
      npm_config_yes: 'true',
      // 抑制 npm 对 CI 环境的告警噪音
      CI: 'false'
    })
  });
  const ms = Date.now() - t0;
  const out = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => l.trim());
  const tail = out.slice(-3).join(' | ').slice(0, 200);
  const ok = fs.existsSync(path.join(dir, 'node_modules'));
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { name, status: 'TIMEOUT', ms, tail: `超时 ${PER_REPO_TIMEOUT / 60000}min` };
  }
  return ok
    ? { name, status: 'OK', ms, tail }
    : { name, status: 'FAIL', ms, tail };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    const c = npmCandidates();
    c.forEach(n => console.log(n));
    console.log('total', c.length);
    return;
  }
  let only = null;
  const oi = argv.indexOf('--only');
  if (oi >= 0 && argv[oi + 1]) only = new Set(argv[oi + 1].split(',').filter(Boolean));

  const cands = npmCandidates().filter(n => !only || only.has(n));
  log(`[npm-install] 候选 ${cands.length} 仓`);

  const results = [];
  for (const name of cands) {
    process.stdout.write(`[npm-install] ${name} ... `);
    const r = installOne(name);
    results.push(r);
    log(`[npm-install] ${r.status.padEnd(8)} ${name.padEnd(32)} ${(r.ms / 1000).toFixed(1)}s  ${r.tail}`);
  }

  const by = {};
  results.forEach(r => { by[r.status] = (by[r.status] || 0) + 1; });
  log(`[npm-install] 完成 by=${JSON.stringify(by)}`);
  log(`[npm-install] 安装成功仓：${results.filter(r => r.status === 'OK').map(r => r.name).join(', ')}`);
}

if (require.main === module) main();
