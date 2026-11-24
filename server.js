// 无锡工艺职业技术学院 晚查寝打卡助手 — 本地服务
// 零依赖：只用 Node 内置模块。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ymd, inWindow, nextWindowStart, nextMidnight } = require('./lib/day');
const { DayKeeper } = require('./lib/daykeeper');

const APP_VERSION = require('./package.json').version;

// 控制台标题由 Node 设置，避免 bat 里出现中文导致的编码问题
try { process.title = '查寝打卡助手 - 后台运行中（别关本窗口）'; } catch (_) {}

const KAOQ = 'https://kaoq.wxgyxy.edu.cn';
const CAS = 'http://ca.wxgyxy.edu.cn';
const CLIENT_ID = 'dpJ3yifnJEKhZO2cHN';
const APPID = 'wxgycq';
const SECRET = 'wxgycq#2026';
const HARD_CHECK_TOKEN = '041l1iHa1QOqHL06TcJa1GrNig3l1iH1';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.44';

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data.json');
const LOG_FILE = path.join(ROOT, 'app.log');
const PORT = Number(process.env.PORT) || 8787;
const OPEN_BROWSER = !(process.argv.includes('--no-browser') || process.env.NO_BROWSER === '1');

// 学校站点证书链不完整，全局放行（仅本进程）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------------------------------------------------------------- 日志
const logLines = [];

function log(msg, kind = 'info') {
  const line = { t: Date.now(), msg: String(msg), kind };
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  console.log(`[${kind}] ${msg}`);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    const d = new Date(line.t);
    const ts = `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    fs.appendFileSync(LOG_FILE, `${ts} [${kind}] ${msg}\n`);
  } catch (_) { /* 日志写盘失败不影响主流程 */ }
}

// ---------------------------------------------------------------- 配置
const DEFAULTS = {
  username: '', password: '', token: '',
  selfie: '', selfieAt: 0,
  auto: false, lat: null, lon: null,
  lastCheckDate: '', lastResult: null,
};

function loadConfig() {
  let cfg;
  if (!fs.existsSync(DATA)) {
    cfg = { ...DEFAULTS };
  } else {
    try {
      cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
    } catch (e) {
      // 配置文件损坏时留档而不是直接崩掉服务
      const bak = `${DATA}.broken-${Date.now()}`;
      try { fs.renameSync(DATA, bak); } catch (_) {}
      log(`data.json 解析失败（${e.message}），已备份为 ${path.basename(bak)}，本次以空配置启动`, 'err');
      cfg = { ...DEFAULTS };
    }
  }
  // 整个文件夹被移动 / 改名后，旧绝对路径会失效，按文件名在本目录找一次
  if (cfg.selfie && !fs.existsSync(cfg.selfie)) {
    const local = path.join(ROOT, path.basename(cfg.selfie));
    if (fs.existsSync(local)) cfg.selfie = local;
  }
  return cfg;
}

const cfg = loadConfig();

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 120);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DATA + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, DATA);
  } catch (e) {
    log('保存配置失败：' + e.message, 'err');
  }
}

// ---------------------------------------------------------------- 工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tfetch(url, opts = {}, ms = 20000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

function friendlyError(e) {
  if (!e) return '未知错误';
  if (e.name === 'TimeoutError' || /aborted due to timeout/i.test(e.message || '')) return '请求超时，学校站点没有响应';
  if (/fetch failed/i.test(e.message || '')) return '网络不可达，检查校园网 / VPN 是否正常';
  return e.message || String(e);
}

// ---------------------------------------------------------------- CAS 登录
function newJar() {
  const jar = new Map();
  const wrap = async (url, opts = {}) => {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(opts.headers || {}),
    };
    if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await tfetch(url, { ...opts, headers, redirect: 'manual' }, opts.timeout || 20000);
    for (const c of res.headers.getSetCookie() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  };
  return wrap;
}

function rsaEncrypt(modulus, exponent, pwd) {
  const code = fs.readFileSync(path.join(ROOT, 'cas_security.js'), 'utf8');
  const win = {};
  new Function('window', code)(win);
  win.RSAUtils.setMaxDigits(130);
  return win.RSAUtils.encryptedString(new win.RSAUtils.getKeyPair(exponent, '', modulus), pwd.split('').reverse().join(''));
}

async function casLogin(username, password) {
  const rq = newJar();
  const redirectUri = KAOQ + '/spxyWeb/#/getCasCode';
  let res = await rq(`${CAS}/cas/oauth2.0/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`);

  let html = '';
  for (let hop = 0; hop < 6; hop++) {
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('CAS 跳转异常（缺少 Location）');
      res = await rq(new URL(loc, CAS).toString());
      continue;
    }
    html = await res.text();
    break;
  }
  const execution = (html.match(/name="execution" value="([^"]+)"/) || [])[1];
  if (!execution) throw new Error('CAS 页面解析失败，学校登录页可能已改版');

  const pkRes = await rq(`${CAS}/cas/v2/getPubKey`);
  const pk = await pkRes.json();
  const form = new URLSearchParams({
    username,
    password: rsaEncrypt(pk.modulus, pk.exponent, password),
    execution,
    _eventId: 'submit',
  });
  res = await rq(`${CAS}/cas/login?service=${encodeURIComponent(CAS + '/cas/oauth2.0/callbackAuthorize')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: CAS + '/cas/login' },
    body: form.toString(),
  });
  if (res.status === 200) {
    const body = await res.text();
    const err = (body.match(/id="errormsg"[^>]*>([\s\S]{0,200}?)<\/p>/) || [])[1];
    throw new Error('登录失败：' + String(err || '账号或密码错误').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }

  let code = null;
  for (let i = 0; i < 8; i++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const m = loc.match(/[?#&]code=([^&#]+)/);
    if (m) { code = decodeURIComponent(m[1]); break; }
    res = await rq(new URL(loc, CAS).toString());
  }
  if (!code) throw new Error('未取得 CAS 授权码');

  const out = await (await tfetch(`${KAOQ}/app-api/system/auth/cas-login-app`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: KAOQ,
      Referer: KAOQ + '/spxyWeb/',
      'User-Agent': UA,
    },
    body: JSON.stringify({ code }),
  })).json();
  if (out.code !== 0) throw new Error(out.msg || '换取 token 失败');
  if (out.data.userType !== '1') throw new Error('该账号不是学生账号');
  return out.data;
}

// ---------------------------------------------------------------- 签名 API
function signHeaders(rawBody) {
  const timestamp = Date.now().toString();
  const nonce = Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 8);
  const n = [`appId=${APPID}`, `timestamp=${timestamp}`, `nonce=${nonce}`].sort().join('&');
  return {
    appId: APPID,
    timestamp,
    nonce,
    sign: crypto.createHash('sha256').update(rawBody + n + SECRET).digest('hex'),
  };
}

async function api(method, p, body, retried = false) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    'User-Agent': UA,
    Origin: KAOQ,
    Referer: KAOQ + '/spxyWeb/',
    Authorization: 'Bearer ' + cfg.token,
    ...signHeaders(raw),
  };
  const opts = { method, headers, timeout: 20000 };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    opts.body = raw;
  }

  let res;
  try {
    res = await tfetch(KAOQ + p, opts);
  } catch (e) {
    throw new Error(friendlyError(e));
  }
  const text = await res.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch (_) {
    out = { code: res.status, msg: text.slice(0, 200) };
  }

  // token 过期 -> 用保存的账密重登一次
  if (out.code === 401 && !retried && cfg.username && cfg.password && p.indexOf('cas-login') < 0) {
    log('登录态失效，自动重新登录…', 'warn');
    let d;
    try {
      d = await casLogin(cfg.username, cfg.password);
    } catch (e) {
      cfg.token = '';
      saveNow();
      throw new Error('登录态已失效，请重新登录（' + friendlyError(e) + '）');
    }
    cfg.token = d.accessToken;
    saveNow();
    return api(method, p, body, true);
  }
  return out;
}

// ---------------------------------------------------------------- 地理围栏
function fenceCenter(fenceJson) {
  const pts = JSON.parse(fenceJson);
  if (!Array.isArray(pts) || !pts.length) throw new Error('围栏数据为空');
  const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const lon = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

// ---------------------------------------------------------------- 状态
const state = {
  busy: false,
  loggingIn: false,
  student: null,
  fence: null,
  startedAt: Date.now(),
};

// 今日状态按「日期 + 20 秒」缓存，跨天后自动失效
let todayCache = { key: '', data: null, at: 0 };

function todayData() {
  return todayCache.key === ymd() ? todayCache.data : null;
}

function isDoneToday() {
  const key = ymd();
  if (cfg.lastCheckDate === key && cfg.lastResult && cfg.lastResult.ok) return true;
  const t = todayData();
  return !!(t && t.checkFlag === 1);
}

async function refreshToday(force = false) {
  const key = ymd();
  if (!force && todayCache.key === key && Date.now() - todayCache.at < 20000) return todayCache.data;

  let data = null;
  let stale = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = await api('GET', '/app-api/attendance/check/getCheckInTodayStatus');
    if (st.code === 401) throw new Error('登录已失效，请重新登录');
    if (st.code !== 0) throw new Error(st.msg || '获取今日状态失败');
    data = st.data || null;
    // 零点刚过时后端可能还在返回昨天的记录，看到日期对不上就再等一会
    const d = data && (data.date || data.checkDate || data.attendanceDate || data.day);
    stale = !!(d && String(d).slice(0, 10) !== key);
    if (!stale) break;
    if (attempt < 2) await sleep(2500);
  }
  if (stale) {
    // 宁可当作「状态未知」，也不能把昨天的 checkFlag=1 当成今天已打卡
    log('学校接口返回的仍是昨天的记录，本次按状态未知处理', 'warn');
    data = null;
  }
  if (ymd() !== key) {
    // 请求期间正好跨天，这批数据属于旧的一天，不能写进新一天的缓存
    log('拉取今日状态时已跨天，丢弃本次结果', 'warn');
    return null;
  }
  todayCache = { key, data, at: Date.now() };
  return data;
}

async function refreshStudent() {
  const info = await api('GET', '/app-api/system/student/getInfo');
  if (info.code === 401) { cfg.token = ''; saveNow(); throw new Error('登录已失效，请重新登录'); }
  if (info.code !== 0) throw new Error(info.msg || '获取学生信息失败');
  state.student = { name: info.data.name, no: info.data.studentNo, grade: info.data.gradeName };
  try {
    state.fence = fenceCenter(info.data.fenceRule);
  } catch (_) {
    state.fence = null;
  }
  await refreshToday(true).catch((e) => log('获取今日打卡状态失败：' + e.message, 'warn'));
  return info.data;
}

// ---------------------------------------------------------------- 打卡
async function doCheckIn(source = '手动') {
  if (state.busy) return { ok: false, msg: '正在打卡中，请稍候' };
  if (!cfg.token) return { ok: false, msg: '请先登录' };
  if (!cfg.selfie || !fs.existsSync(cfg.selfie)) return { ok: false, msg: '请先上传一张自拍照' };
  if (isDoneToday()) return { ok: true, msg: '今日已打卡' };

  state.busy = true;
  const d = new Date();
  if (!inWindow(d)) log('当前不在 21:30-24:00 打卡窗口内，服务端可能会拒绝', 'warn');

  const lat = Number(cfg.lat ?? (state.fence && state.fence.lat) ?? 31.3364);
  const lon = Number(cfg.lon ?? (state.fence && state.fence.lon) ?? 119.8347);

  try {
    if (!state.fence) await refreshStudent().catch(() => {});
    log(`[${source}] 提交打卡 lat=${lat} lon=${lon}`);

    const pre = await api('POST', '/app-api/attendance/check/preCheckIn', { longitude: lon, latitude: lat });
    let checkToken = HARD_CHECK_TOKEN;
    if (pre.code === 0 && pre.data && pre.data.checkToken) checkToken = pre.data.checkToken;
    else log(`preCheckIn 未返回 checkToken，使用固定 token（${pre.msg || pre.code}）`, 'warn');

    const b64 = 'data:image/jpeg;base64,' + fs.readFileSync(cfg.selfie).toString('base64');
    const payload = {
      faceImageGg: b64.slice(0, 30) + 'KwLiSlaC' + b64.slice(30),
      addressRr: '无锡工艺职业技术学院',
      longitudeK: lon,
      latitudeL: lat,
      deviceInfoR: '手机',
      checkToken,
    };
    const r = await api('POST', '/app-api/attendance/check/studentChecKlnSecret', payload);
    if (r.code !== 0) {
      log('提交被拒：' + (r.msg || r.code), 'err');
      return { ok: false, msg: r.msg || ('提交失败 ' + r.code) };
    }

    const requestId = r.data && r.data.requestId;
    if (!requestId) return { ok: false, msg: '未返回业务流水号' };
    log('已提交，等待人脸/活体核验… requestId=' + requestId);

    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const st = await api('GET', '/app-api/attendance/check/status/' + requestId).catch((e) => ({ code: -1, msg: e.message }));
      const dd = st && st.data;
      if (!dd) continue;

      if (dd.status === 1) {
        log('✅ 打卡成功', 'ok');
        cfg.lastCheckDate = ymd();
        cfg.lastResult = { ok: true, msg: '打卡成功', t: Date.now(), date: ymd() };
        saveNow();
        await refreshStudent().catch(() => {});
        return { ok: true, msg: '打卡成功' };
      }
      if (dd.status === 2) {
        const m = dd.resultMsg || '打卡失败';
        if (dd.resultCode === 'ALREADY_CHECKED_IN') {
          log('今天已经打过了（' + m + '）', 'ok');
          cfg.lastCheckDate = ymd();
          cfg.lastResult = { ok: true, msg: '今日已打卡', t: Date.now(), date: ymd() };
          saveNow();
          await refreshStudent().catch(() => {});
          return { ok: true, msg: '今日已打卡' };
        }
        log('❌ ' + m, 'err');
        log('原始返回：' + JSON.stringify(dd), 'warn');
        cfg.lastResult = { ok: false, msg: m, t: Date.now(), date: ymd() };
        saveNow();
        return { ok: false, msg: m };
      }
    }
    log('查询超时，结果未知', 'warn');
    return { ok: false, msg: '核验超时，结果未知' };
  } catch (e) {
    const msg = friendlyError(e);
    log('异常：' + msg, 'err');
    return { ok: false, msg };
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- 自动打卡调度
const RETRY_MS = 3 * 60 * 1000;     // 失败后 3 分钟再试
const MAX_ATTEMPTS = 40;            // 单日上限，防止照片有问题时无限重试
const auto = { attempts: 0, nextAt: 0, running: false, exhausted: false };

function planIdle(d = new Date()) {
  if (!cfg.auto || !cfg.token || !cfg.selfie) return 0;
  if (!inWindow(d)) return nextWindowStart(d).getTime();
  if (isDoneToday()) return nextWindowStart(d).getTime();
  return Math.max(Date.now() + 5000, auto.nextAt || 0);
}

async function autoTick() {
  if (auto.running) return;
  const d = new Date();
  dayKeeper.check(); // 休眠 / 改系统时间后也能补上跨天

  if (!cfg.auto) { auto.nextAt = 0; return; }
  if (!cfg.token || !cfg.selfie) { auto.nextAt = 0; return; }
  if (!inWindow(d)) { auto.nextAt = nextWindowStart(d).getTime(); return; }
  if (isDoneToday()) { auto.nextAt = nextWindowStart(d).getTime(); return; }
  if (auto.attempts >= MAX_ATTEMPTS) {
    if (!auto.exhausted) {
      auto.exhausted = true;
      log(`自动打卡已达单日上限 ${MAX_ATTEMPTS} 次，今天不再重试`, 'err');
    }
    auto.nextAt = nextWindowStart(d).getTime();
    return;
  }
  if (Date.now() < auto.nextAt) return;

  auto.running = true;
  try {
    // 每次尝试前确认真实状态，避免用昨天的缓存判断今天
    const t = await refreshToday(true).catch(() => null);
    if (t && t.checkFlag === 1) {
      log('自动打卡：服务端显示今日已完成，今天不再提交', 'ok');
      auto.nextAt = nextWindowStart(d).getTime();
      return;
    }
    if (t && (t.leaveFlag === 1 || t.dormitoryFlag === 1)) {
      log(`自动打卡：${t.leaveFlag === 1 ? '今日请假' : '今日免查寝'}，跳过`, 'info');
      auto.nextAt = nextWindowStart(d).getTime();
      return;
    }

    auto.attempts++;
    auto.nextAt = Date.now() + RETRY_MS;
    log(`自动打卡：第 ${auto.attempts}/${MAX_ATTEMPTS} 次尝试`, 'info');

    const r = await doCheckIn('自动');
    if (r.ok) {
      auto.nextAt = nextWindowStart(new Date()).getTime();
      log('今日自动打卡完成，明天 21:30 继续', 'ok');
    } else {
      auto.nextAt = Date.now() + RETRY_MS;
      log(`自动打卡未成功：${r.msg}，${Math.round(RETRY_MS / 60000)} 分钟后重试`, 'warn');
    }
  } catch (e) {
    auto.nextAt = Date.now() + RETRY_MS;
    log('自动打卡异常：' + friendlyError(e), 'err');
  } finally {
    auto.running = false;
  }
}

function onRollover(prevKey, nextKey) {
  todayCache = { key: '', data: null, at: 0 };
  auto.attempts = 0;
  auto.nextAt = 0;
  auto.exhausted = false;
  // 昨天的「打卡成功」不再作为今天的状态展示
  if (cfg.lastCheckDate !== nextKey) cfg.lastResult = null;
  saveNow();
  log(`跨天刷新完成：${prevKey} → ${nextKey}，今日状态已重置`, 'ok');
  if (cfg.token) {
    // 零点刚过学校接口可能还在切日，等 5 秒再拉
    setTimeout(() => {
      refreshStudent().catch((e) => log('跨天后刷新状态失败：' + e.message, 'warn'));
    }, 5000).unref();
  }
}

const dayKeeper = new DayKeeper({
  onRollover,
  log: (m) => log(m, 'info'),
});
dayKeeper.start();

setInterval(autoTick, 10000).unref();

// ---------------------------------------------------------------- HTTP
function json(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw new Error('请求格式错误'); }
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['public/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

function serveStatic(res, rel, type) {
  try {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

function openBrowser() {
  if (!OPEN_BROWSER || process.platform !== 'win32') return;
  try {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) { /* 打不开浏览器不影响服务 */ }
}

function autoStatus() {
  return {
    auto: cfg.auto,
    nextAt: planIdle(),
    attempts: auto.attempts,
    maxAttempts: MAX_ATTEMPTS,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 只接受本机 Host，挡住 DNS rebinding
  const host = String(req.headers.host || '').toLowerCase();
  if (host && host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  // 所有写接口必须是 JSON：普通表单无法伪造这个 Content-Type，挡掉 CSRF
  if (req.method === 'POST' && p.startsWith('/api/') && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return json(res, { ok: false, msg: '请求格式错误' }, 415);
  }

  try {
    if (STATIC[p] && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveStatic(res, STATIC[p][0], STATIC[p][1]);
    }

    if (p === '/api/state' && req.method === 'GET') {
      const now = new Date();
      return json(res, {
        version: APP_VERSION,
        loggedIn: !!cfg.token,
        username: cfg.username,
        busy: state.busy,
        student: state.student,
        today: todayData(),
        fence: state.fence,
        selfie: !!(cfg.selfie && fs.existsSync(cfg.selfie)),
        selfieAt: cfg.selfieAt || 0,
        lat: cfg.lat,
        lon: cfg.lon,
        serverTime: now.getTime(),
        inWindow: inWindow(now),
        windowStart: nextWindowStart(now).getTime(),
        dayKey: ymd(now),
        nextRolloverAt: nextMidnight(now).getTime(),
        startedAt: state.startedAt,
        port: PORT,
        logs: logLines.slice(-80),
        autoStatus: autoStatus(),
        node: process.version,
      });
    }

    if (p === '/api/quit' && req.method === 'POST') {
      log('收到关闭指令，后台即将退出', 'warn');
      saveNow();
      json(res, { ok: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      }, 150);
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (state.loggingIn) return json(res, { ok: false, msg: '正在登录中，请稍候' });
      const { username, password } = await readJson(req);
      if (!username || !password) return json(res, { ok: false, msg: '请输入学号和密码' });
      state.loggingIn = true;
      try {
        log('正在登录 ' + username);
        const d = await casLogin(String(username).trim(), String(password));
        cfg.username = String(username).trim();
        cfg.password = String(password);
        cfg.token = d.accessToken;
        cfg.lastResult = null;
        cfg.lastCheckDate = '';
        saveNow();
        todayCache = { key: '', data: null, at: 0 };
        auto.attempts = 0;
        auto.nextAt = 0;
        auto.exhausted = false;
        try {
          await refreshStudent();
        } catch (e) {
          // 凭证已经拿到，学生信息拉取失败不该让登录整体失败
          log('登录成功，但拉取学生信息失败：' + e.message, 'warn');
        }
        log('登录成功：' + ((state.student && state.student.name) || cfg.username), 'ok');
        return json(res, { ok: true, student: state.student });
      } finally {
        state.loggingIn = false;
      }
    }

    if (p === '/api/logout' && req.method === 'POST') {
      cfg.token = '';
      cfg.password = '';
      cfg.lastResult = null;
      cfg.lastCheckDate = '';
      saveNow();
      state.student = null;
      todayCache = { key: '', data: null, at: 0 };
      log('已注销登录', 'warn');
      return json(res, { ok: true });
    }

    if (p === '/api/selfie' && req.method === 'POST') {
      const { b64 } = await readJson(req);
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(b64 || '');
      if (!m) return json(res, { ok: false, msg: '只支持 JPEG / PNG / WebP 图片' });
      const file = path.join(ROOT, 'selfie.' + (m[1] === 'jpeg' ? 'jpg' : m[1]));
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      // 换格式时清掉上一张，避免 selfie.jpg / selfie.png 同时残留
      if (cfg.selfie && cfg.selfie !== file && path.dirname(cfg.selfie) === ROOT
          && path.basename(cfg.selfie).startsWith('selfie.')) {
        try { fs.rmSync(cfg.selfie, { force: true }); } catch (_) {}
      }
      cfg.selfie = file;
      cfg.selfieAt = Date.now();
      // 新照片可能解决之前导致失败的问题，重新给满次数
      auto.attempts = 0;
      auto.exhausted = false;
      saveNow();
      log('打卡照片已更新');
      return json(res, { ok: true });
    }

    if (p === '/api/selfie' && req.method === 'GET') {
      if (!cfg.selfie || !fs.existsSync(cfg.selfie)) return json(res, { ok: false }, 404);
      const buf = fs.readFileSync(cfg.selfie);
      const ext = path.extname(cfg.selfie).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      return res.end(buf);
    }

    if (p === '/api/config' && req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.auto === 'boolean') {
        cfg.auto = b.auto;
        if (b.auto) {
          auto.attempts = 0;
          auto.nextAt = 0;
          auto.exhausted = false;
          log('自动打卡已开启', 'ok');
        } else {
          auto.nextAt = 0;
          log('自动打卡已关闭', 'warn');
        }
      }
      const coords = {};
      for (const [key, label, min, max] of [['lat', '纬度', -90, 90], ['lon', '经度', -180, 180]]) {
        if (b[key] === undefined) continue;
        if (b[key] === null || b[key] === '') { coords[key] = null; continue; }
        const v = Number(b[key]);
        if (!Number.isFinite(v) || v < min || v > max) {
          return json(res, { ok: false, msg: `${label}需要在 ${min} 到 ${max} 之间` });
        }
        coords[key] = v;
      }
      if ('lat' in coords) cfg.lat = coords.lat;
      if ('lon' in coords) cfg.lon = coords.lon;
      save();
      return json(res, { ok: true, autoStatus: autoStatus() });
    }

    if (p === '/api/checkin' && req.method === 'POST') {
      const r = await doCheckIn('手动');
      auto.nextAt = r.ok ? nextWindowStart(new Date()).getTime() : 0;
      return json(res, r);
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      await refreshStudent();
      return json(res, { ok: true, today: todayData() });
    }

    json(res, { ok: false, msg: 'not found' }, 404);
  } catch (e) {
    const msg = friendlyError(e);
    log('HTTP 错误：' + msg, 'err');
    if (!res.headersSent) json(res, { ok: false, msg }, 500);
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用，说明后台已经在运行。`);
    openBrowser();
    setTimeout(() => process.exit(0), 200);
  } else {
    console.error('服务启动失败：', e.message);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ============================================================');
  console.log('   查寝打卡助手已启动。窗口别关：关掉就停服，也不会再自动打卡。');
  console.log(`   页面地址：http://127.0.0.1:${PORT}`);
  console.log('  ============================================================');
  console.log('');
  log(`服务已启动 v${APP_VERSION} · http://127.0.0.1:${PORT}`);
  log(`跨天刷新已排定：每天 00:00 重置（下次 ${new Date(nextMidnight()).toLocaleString('zh-CN', { hour12: false })}）`);
  openBrowser();
  if (cfg.token) {
    refreshStudent().catch((e) => log('恢复会话失败：' + e.message, 'warn'));
  }
});

// ---------------------------------------------------------------- 进程守护
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('进程收到退出信号，保存配置后退出', 'warn');
    saveNow();
    process.exit(0);
  });
}

process.on('unhandledRejection', (e) => {
  log('未处理的异步错误：' + friendlyError(e), 'err');
});

process.on('uncaughtException', (e) => {
  // 后台服务宁可带伤继续跑，也不要因为一次异常错过当天的打卡
  log('未捕获异常：' + (e && e.stack ? e.stack : String(e)), 'err');
});

