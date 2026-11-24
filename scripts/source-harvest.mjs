#!/usr/bin/env node
/**
 * LibreTV 点播源自动采集脚本
 *
 * 流程：种子源列表 → 远程订阅拉取 → GitHub 搜索 → URL 规范化 →
 *       并发探活 → 去重排序 → 输出 LibreTV-SourceList JSON
 *
 * 零外部依赖，Node 18+ 即可运行（使用内置 fetch）。
 * 输出格式：{ name, sources: [{name, url, detail?, isAdult?}], liveSources?: [] }
 *
 * 用法：
 *   node scripts/source-harvest.mjs
 *   node scripts/source-harvest.mjs --config scripts/source-harvest.config.json
 *   node scripts/source-harvest.mjs --seed http://xxx/meowcf.json,http://yyy/libretv.json
 *   node scripts/source-harvest.mjs --probe-concurrency 15 --timeout 8000
 *   node scripts/source-harvest.mjs --no-github             # 跳过 GitHub 搜索
 *   node scripts/source-harvest.mjs --output out.json
 *   GITHUB_TOKEN=xxx node scripts/source-harvest.mjs       # 提高 GitHub API 速率限制
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 路径 & 常量 ────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'source-list.latest.json');
const DEFAULT_CONFIG = path.join(__dirname, 'source-harvest.config.json');
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

// Apple CMS API 特征（libretv 也用这个 pattern）
const CMS_API_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i;
const SPIDER_PATTERN = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i;

// ─── CLI 参数 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    seed: [],
    output: DEFAULT_OUTPUT,
    fromFile: null,            // 直接从已有 source-list JSON 转换（跳过采集）
    probeConcurrency: 10,
    timeout: 6000,
    probeLimit: 300,           // 最多探活多少个源（避免网络风暴）
    topN: 60,                  // 最终保留多少个最快的活源
    github: true,
    githubQueries: [
      'inurl:/api.php/provide/vod language:JSON',
      'inurl:/api.php/provide/vod 影视 采集',
      'api.php/provide/vod site:github.com',
    ],
    verbose: false,
  };
  // 兼容 --key=value 形式
  const flat = [];
  for (const a of argv) {
    const m = /^(--[a-z-]+)=(.+)$/.exec(a);
    if (m) flat.push(m[1], m[2]); else flat.push(a);
  }
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    switch (a) {
      case '--config': args.config = flat[++i]; break;
      case '--seed':   args.seed = flat[++i].split(',').map(s => s.trim()).filter(Boolean); break;
      case '--output': args.output = flat[++i]; break;
      case '--probe-concurrency': args.probeConcurrency = Number(flat[++i]); break;
      case '--timeout': args.timeout = Number(flat[++i]); break;
      case '--probe-limit': args.probeLimit = Number(flat[++i]); break;
      case '--top-n': args.topN = Number(flat[++i]); break;
      case '--from-file': args.fromFile = flat[++i]; break;
      case '--no-github': args.github = false; break;
      case '--verbose': args.verbose = true; break;
    }
  }
  return args;
}

// ─── 加载配置文件（可选） ─────────────────────────────────────────────────────
function loadConfig(cliArgs) {
  const cfgPath = cliArgs.config;
  if (fs.existsSync(cfgPath)) {
    try {
      const text = fs.readFileSync(cfgPath, 'utf-8');
      const cfg = JSON.parse(stripJsonArtifacts(text));
      return { ...cliArgs, ...cfg };
    } catch (e) {
      console.warn(`⚠ 配置文件解析失败：${e.message}，继续使用命令行参数`);
    }
  }
  return cliArgs;
}

// ─── 网络工具 ────────────────────────────────────────────────────────────────
async function fetchText(url, options = {}) {
  const headers = {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...options.headers,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 10000);
  try {
    const resp = await fetch(url, { ...options, headers, signal: controller.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── JSON 宽容解析 ───────────────────────────────────────────────────────────
// 来自 LibreTV tvbox-parser.ts 的策略：剥注释、剥尾随逗号
function stripJsonArtifacts(text) {
  return stripTrailingCommas(stripComments(text));
}
function stripComments(text) {
  let out = '', inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inLine) { if (ch === '\n' || ch === '\r') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { out += ch; if (ch === '\\') { out += next ?? ''; i++; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}
function stripTrailingCommas(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { out += ch; if (ch === '\\') { out += text[i + 1] ?? ''; i++; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') { let j = i + 1; while (j < text.length && /\s/.test(text[j])) j++; if (text[j] === '}' || text[j] === ']') continue; }
    out += ch;
  }
  return out;
}

// ─── URL 规范化 ───────────────────────────────────────────────────────────────
// 把散乱的 URL 统一成 /api.php/provide/vod（LibreTV 兼容的直连接口）
function normalizeVodUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  // 剥掉结尾空 ? # /
  u = u.replace(/[?#]+$/, '').replace(/\/+$/, '');
  // 已有完整路径则返回（注意避免 /at/xml 不兼容 LibreTV JSON 解析）
  if (CMS_API_PATTERN.test(u) && !/\/at\/xml/i.test(u)) return u;
  // 已经是 api.php 但没有 provide/vod —— 补上
  if (/api\.php$/i.test(u)) return u + '/provide/vod';
  // 否则默认补全
  return u + '/api.php/provide/vod';
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ─── 种子源（内置，避免 GitHub/配置文件都没有时空跑） ────────────────────────
const BUILTIN_SEEDS = [
  // LibreTV 官方订阅仓库（正在维护）
  'https://raw.githubusercontent.com/haojun19980728-prog/libretv-source-list/main/libretv-sources.json',
  // 知名 TVBOX 配置合集
  'https://freed.yuanhsing.cf/TVBox/meowcf.json',
  'https://wds.ecsxs.com/223843.txt',    // txt 可能不是 JSON，会被忽略
  'https://pastebin.com/raw/gtbKvnE1',
];

// ─── 阶段 1：从种子订阅拉取源列表 ────────────────────────────────────────────
async function fetchSubscriptionSources(url) {
  try {
    console.log(`  拉取订阅 ${url}`);
    const text = await fetchText(url, { timeout: 15000 });
    let json;
    try { json = JSON.parse(stripJsonArtifacts(text)); }
    catch { console.log(`    ✗ 非 JSON 格式，跳过`); return []; }

    const out = [];
    // LibreTV-SourceList 格式
    if (json && Array.isArray(json.sources)) {
      for (const s of json.sources) {
        if (!s?.url) continue;
        const norm = normalizeVodUrl(s.url);
        if (norm) out.push({ name: s.name || hostnameOf(norm), url: norm });
      }
    }
    // 裸数组（LibreTV 裸数组 或 接口目录 source-catalog）
    if (Array.isArray(json)) {
      for (const s of json) {
        if (!s || typeof s !== 'object') continue;
        const base = s.baseUrl || s.url;
        if (!base) continue;
        const norm = normalizeVodUrl(base);
        if (norm) out.push({ name: s.name || hostnameOf(norm), url: norm });
      }
    }
    // TVBOX 配置
    if (json && Array.isArray(json.sites)) {
      for (const site of json.sites) {
        const api = site.api;
        const type = site.type;
        if (!api) continue;
        // Spider / jar / js 跳过
        if (SPIDER_PATTERN.test(api)) continue;
        if (type === 0 && !CMS_API_PATTERN.test(api)) continue; // XML 接口跳过
        if (type === 3) continue; // Spider 跳过
        const norm = normalizeVodUrl(api);
        if (norm) out.push({ name: site.name || hostnameOf(norm), url: norm });
      }
    }
    console.log(`    ✓ 解析到 ${out.length} 个点播源`);
    return out;
  } catch (e) {
    console.log(`    ✗ 失败：${e.message}`);
    return [];
  }
}

// ─── 阶段 2：GitHub 搜索（可选） ──────────────────────────────────────────────
async function searchGitHubSources(queries, timeoutMs = 10000) {
  const candidates = new Set();
  const token = process.env.GITHUB_TOKEN;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  for (const q of queries) {
    try {
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=20`;
      const resp = await fetchText(url, { headers, timeout: timeoutMs });
      const json = JSON.parse(resp);
      if (!Array.isArray(json.items)) continue;
      for (const item of json.items) {
        // 直接拿到文件名里可能包含 api.php 路径的仓库
        const repoUrl = item.repository?.html_url || '';
        if (repoUrl) candidates.add(repoUrl);
      }
    } catch (e) {
      console.log(`    ⚠ GitHub 搜索 "${q}" 失败：${e.message}`);
    }
  }

  // 第二轮：尝试从仓库 README / code 搜索结果里直接抓 api.php URL
  // 简化做法：返回搜到的 repo 链接，作为种子继续尝试抓 raw 内容
  const rawCandidates = [];
  for (const repo of candidates) {
    // 尝试几个常见的配置文件名
    const repoMatch = repo.match(/github\.com\/([^/]+\/[^/]+)/);
    if (!repoMatch) continue;
    const rp = repoMatch[1];
    const guesses = [
      `https://raw.githubusercontent.com/${rp}/main/meowcf.json`,
      `https://raw.githubusercontent.com/${rp}/master/meowcf.json`,
      `https://raw.githubusercontent.com/${rp}/main/config.json`,
      `https://raw.githubusercontent.com/${rp}/master/config.json`,
      `https://raw.githubusercontent.com/${rp}/main/libretv-sources.json`,
      `https://raw.githubusercontent.com/${rp}/master/libretv-sources.json`,
    ];
    for (const g of guesses) rawCandidates.push(g);
  }
  return rawCandidates;
}

// ─── 阶段 3：并发探活 ─────────────────────────────────────────────────────────
async function probeOneSource(source, timeoutMs) {
  // 发搜索请求，用冷门关键词降低被误伤概率
  const probeUrl = `${source.url}${source.url.includes('?') ? '&' : '?'}ac=videolist&wd=孤勇者`;
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(probeUrl, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) return { ...source, ok: false, ms: Math.round(performance.now() - start), error: `HTTP ${resp.status}` };
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ...source, ok: false, ms: Math.round(performance.now() - start), error: '非 JSON 响应' };
    }
    const list = json?.list || json?.result?.list || [];
    const count = Array.isArray(list) ? list.length : 0;
    if (count === 0) {
      // 有些站点返回空 list 但接口本身正常，也算 OK（只是没搜到）
      return { ...source, ok: true, ms: Math.round(performance.now() - start), count };
    }
    return { ...source, ok: true, ms: Math.round(performance.now() - start), count };
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    return { ...source, ok: false, ms, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 简易并发队列
async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

// ─── 去重 ────────────────────────────────────────────────────────────────────
function dedupeByHostname(sources) {
  const seen = new Map(); // hostname -> {url, entry}
  for (const s of sources) {
    const host = hostnameOf(s.url);
    if (!seen.has(host)) { seen.set(host, s); continue; }
    // 同主机有多条 URL → 保留最完整的那条
    const existing = seen.get(host);
    if (s.url.length > existing.url.length) seen.set(host, s);
  }
  return [...seen.values()];
}

function dedupeByUrl(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

// ─── 多格式订阅输出（LibreTV / FongMi-TVBox / Selene-TV） ────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// 标准 Base58（无 checksum），对齐 Selene-TV util/Base58.kt
function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

// 不健康内容分类关键词（与 LibreTV cms-parser.ts、Selene ContentFilterService 保持一致）
const ADULT_KEYWORDS = [
  '伦理片', '伦理', '倫理片', '理论片', '福利', '福利片', '福利视频', '日本伦理', '日本福利',
  '韩国伦理', '港台三级', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒', '擦边',
  'cosplay', '黑丝诱惑', '无码', '有码', 'SWAG', '网红主播', '色情片', '同性片',
  '91视频', '自拍偷拍', 'mini传媒', '写真热舞', '三级',
];

function isAdultText(text) {
  if (!text) return false;
  const s = String(text).toLowerCase();
  return ADULT_KEYWORDS.some((k) => s.includes(k.toLowerCase()));
}

/** 拉取源站分类列表（ac=list），剔除不健康分类；失败返回 null（不写入 categories 字段）。 */
async function fetchSafeCategories(source, timeoutMs = 12000, attempt = 0) {
  const url = `${source.url}${source.url.includes('?') ? '&' : '?'}ac=list`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[attempt % USER_AGENTS.length], 'Accept': 'application/json,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = JSON.parse(await resp.text());
    const classes = json?.class || json?.classes || [];
    const names = classes
      .map((c) => c?.type_name)
      .filter((n) => typeof n === 'string' && n.trim())
      .filter((n) => !isAdultText(n));
    return names.length ? [...new Set(names)] : null;
  } catch {
    if (attempt < 1) return fetchSafeCategories(source, timeoutMs, attempt + 1);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 为所有源补充 categories（白名单：仅保留健康分类），并剔除成人向源站。 */
async function enrichWithCategories(sources, concurrency = 10) {
  const healthy = sources.filter((s) => !isAdultText(s.name) && !isAdultText(s.url));
  const dropped = sources.length - healthy.length;
  const cats = await runConcurrent(healthy, (s) => fetchSafeCategories(s), concurrency);
  healthy.forEach((s, i) => { if (cats[i]) s.categories = cats[i]; });
  return { sources: healthy, dropped, withCats: cats.filter(Boolean).length };
}

function buildTvbox(name, sources) {
  return {
    name,
    spider: '',
    sites: sources.map((s, i) => ({
      key: `cms${i}`,
      name: s.name,
      type: 1,
      api: s.url,
      searchable: 1,
      quickSearch: 1,
      // 分类白名单：仅暴露健康分类，FongMi 会据此隐藏「伦理/福利」等板块
      ...(s.categories?.length ? { categories: s.categories } : {}),
    })),
    parses: [],
    flags: [],
    lives: [],
    ads: [],
  };
}

// Selene-TV 订阅格式：Base58(JSON { api_site, lives })
function buildSelene(sources) {
  const api_site = {};
  sources.forEach((s, i) => {
    const key = `cms${i}`;
    api_site[key] = { key, name: s.name, api: s.url, detail: s.detail ?? '', from: 'myTV' };
  });
  return { api_site, lives: {} };
}

/** 写出三种订阅格式，返回路径。 */
function writeSubscriptions(args, name, sources, liveSources) {
  fs.writeFileSync(args.output, JSON.stringify({ name, sources, liveSources }, null, 2), 'utf-8');
  const dir = path.dirname(args.output);
  const tvboxPath = path.join(dir, 'tvbox.latest.json');
  const selenePath = path.join(dir, 'selene.latest.txt');
  fs.writeFileSync(tvboxPath, JSON.stringify(buildTvbox(name, sources), null, 2), 'utf-8');
  fs.writeFileSync(selenePath, base58Encode(Buffer.from(JSON.stringify(buildSelene(sources)), 'utf-8')), 'utf-8');
  return { tvboxPath, selenePath };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  // --from-file 是纯格式转换，不加载采集配置（避免 config 里的 output 覆盖 CLI）
  const args = rawArgs.fromFile ? rawArgs : loadConfig(rawArgs);
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          LibreTV 点播源采集脚本 v0.1                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // ── 0. 仅格式转换：从已有 source-list JSON 生成三种订阅格式 ──
  if (args.fromFile) {
    const list = JSON.parse(fs.readFileSync(args.fromFile, 'utf-8').replace(/^\uFEFF/, ''));
    let sources = (list.sources || [])
      .map(s => ({ name: s.name || hostnameOf(s.url || ''), url: normalizeVodUrl(s.url), detail: s.detail }))
      .filter(s => s.url);
    if (!sources.length) { console.error('❌ from-file 中没有可用点播源'); process.exit(1); }
    const en = await enrichWithCategories(sources);
    sources = en.sources;
    console.log(`\n🧹 不健康过滤：剔除源 ${en.dropped} 个，${en.withCats}/${sources.length} 个源已写入健康分类白名单`);
    const name = `LibreTV 精选源 ${new Date().toISOString().slice(0, 10)} (${sources.length}个)`;
    const { tvboxPath, selenePath } = writeSubscriptions(args, name, sources, list.liveSources || []);
    console.log(`\n📄 LibreTV: ${args.output}\n📄 FongMi/TVBox: ${tvboxPath}\n📄 Selene-TV: ${selenePath}`);
    return;
  }

  // ── 1. 收集种子订阅 URL ──
  const seedUrls = [...new Set([
    ...BUILTIN_SEEDS,
    ...(args.seed || []),
    ...(args.github ? await searchGitHubSources(args.githubQueries) : []),
  ])];
  console.log(`\n📥 种子订阅 ${seedUrls.length} 个`);

  // ── 2. 并发拉取订阅 ──
  let candidates = [];
  for (const url of seedUrls) {
    const batch = await fetchSubscriptionSources(url);
    candidates.push(...batch);
  }

  // ── 3. 归一化 + 去重 ──
  candidates = dedupeByUrl(candidates);
  candidates = dedupeByHostname(candidates);
  console.log(`\n🔧 规范化 + 去重后剩余 ${candidates.length} 个唯一源`);

  if (candidates.length === 0) {
    console.log('❌ 没有任何候选源可用，终止');
    process.exit(1);
  }

  // ── 4. 截断到 probeLimit ──
  if (candidates.length > args.probeLimit) {
    console.log(`   候选过多，截断到前 ${args.probeLimit} 个进行探活`);
    candidates = candidates.slice(0, args.probeLimit);
  }

  // ── 5. 并发探活 ──
  console.log(`\n🔍 开始探活（并发 ${args.probeConcurrency}，超时 ${args.timeout}ms）...`);
  const t0 = Date.now();
  const probeResults = await runConcurrent(candidates, async (s) => probeOneSource(s, args.timeout), args.probeConcurrency);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ── 6. 过滤活源 ──
  const alive = probeResults.filter(r => r.ok);
  const dead = probeResults.filter(r => !r.ok);
  alive.sort((a, b) => a.ms - b.ms);  // 越快越靠前

  console.log(`\n📊 探活完成（${elapsed}s）：`);
  console.log(`   ✅ 活源：${alive.length} 个`);
  console.log(`   ❌ 死源：${dead.length} 个`);

  // 活源 topN
  const topAlive = alive.slice(0, args.topN);
  console.log(`\n🏆 Top ${topAlive.length} 最快活源：`);
  for (const s of topAlive.slice(0, 10)) {
    console.log(`   ${s.ok ? '✅' : '❌'} ${s.ms}ms  ${s.name}  ${s.url}`);
  }
  if (topAlive.length > 10) console.log(`   ... 还有 ${topAlive.length - 10} 个`);

  // 死源前 5 示例
  if (dead.length > 0) {
    console.log(`\n💀 死源示例（前 5）：`);
    for (const s of dead.slice(0, 5)) {
      console.log(`   ❌ ${s.name} — ${s.error}`);
    }
  }

  // ── 6.5 不健康内容过滤：剔除成人向源站，并为每个源拉取「健康分类」白名单 ──
  console.log(`\n🧹 过滤不健康内容（成人分类关键词 ${ADULT_KEYWORDS.length} 个）...`);
  const en = await enrichWithCategories(topAlive);
  const healthySources = en.sources;
  console.log(`   剔除源站 ${en.dropped} 个，${en.withCats}/${healthySources.length} 个源已写入健康分类白名单`);

  // ── 7. 组装输出 ──
  const output = {
    name: `LibreTV 精选源 ${new Date().toISOString().slice(0, 10)} (${healthySources.length}个)`,
    _meta: {
      generatedAt: new Date().toISOString(),
      probeElapsedSec: Number(elapsed),
      probeConfig: { concurrency: args.probeConcurrency, timeoutMs: args.timeout },
      stats: { totalCandidates: candidates.length, alive: alive.length, dead: dead.length, droppedAdult: en.dropped, outputSources: healthySources.length },
      deadSources: dead.slice(0, 50).map(d => ({ name: d.name, url: d.url, error: d.error })),
    },
    sources: healthySources.map(s => ({ name: s.name, url: s.url, detail: `探活 ${s.ms}ms` })),
    liveSources: [],
  };
  // _meta 是内部字段，去掉保证纯订阅格式
  const clean = {
    name: output.name,
    sources: output.sources,
    liveSources: [],
  };
  fs.writeFileSync(args.output, JSON.stringify(clean, null, 2), 'utf-8');
  console.log(`\n📄 已写入 ${args.output}`);

  // 同步产出 FongMi(TVBox) / Selene(Base58) 订阅
  const { tvboxPath, selenePath } = writeSubscriptions(args, output.name, healthySources, []);
  console.log(`📄 FongMi/TVBox: ${tvboxPath}`);
  console.log(`📄 Selene-TV: ${selenePath}`);

  // 同时写一个带 meta 的完整报告（便于排查）
  const reportPath = args.output.replace(/\.json$/, '.report.json');
  if (reportPath !== args.output) {
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`📊 完整报告 ${reportPath}`);
  }

  // GitHub Actions GITHUB_OUTPUT —— 让 workflow 能拿到统计数据（格式：key=value）
  if (process.env.GITHUB_OUTPUT) {
    const summary = [
      `alive_count=${healthySources.length}`,
      `dead_count=${dead.length}`,
      `candidate_count=${candidates.length}`,
      `dropped_adult=${en.dropped}`,
      `total_ms=${elapsed}`,
      `top_n=${args.topN}`,
      `summary=采集完成：${healthySources.length} 活源 / ${dead.length} 死源 / 剔除成人源 ${en.dropped}（耗时 ${elapsed}s）`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, summary + '\n');
    console.log(`\n🔧 GITHUB_OUTPUT 已写入：alive=${healthySources.length} dead=${dead.length} elapsed=${elapsed}s`);
  }

  // 退出码：没活源 → 非 0（让 CI 标记为失败）
  if (healthySources.length === 0) {
    console.error('\n❌ 没有任何活源，退出码 2');
    process.exit(2);
  }
}

main().catch(err => {
  console.error('❌ 脚本崩溃：', err);
  process.exit(1);
});
