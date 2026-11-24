'use strict';

/* ============================================================
   查寝打卡助手 — 前端逻辑
   轮询 /api/state（2s），本地时钟插值（1s）。
   ============================================================ */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

let S = null;              // 最近一次 /api/state
let offset = 0;            // 服务器时间 - 本地时间
let logKey = '';           // 日志渲染指纹
let logClearedAt = 0;      // 手动清屏的时间点，之后只显示新日志
let logPaused = false;
let photoKey = '';
let polling = false;

const now = () => new Date(Date.now() + offset);
const ymd = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtHMS = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const fmtDur = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
};
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ---------------------------------------------------------- 网络 */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, msg: '服务没有返回有效数据' }));
  if (!res.ok && data.ok !== false) throw new Error(data.msg || `请求失败（${res.status}）`);
  return data;
}

async function pull() {
  const res = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('state');
  S = await res.json();
  offset = S.serverTime - Date.now();
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    await pull();
    setLive(true);
    render();
  } catch (_) {
    setLive(false);
  } finally {
    polling = false;
    setTimeout(loop, 2000);
  }
}

/* ---------------------------------------------------------- 提示 */
function toast(message, tone = 'ok') {
  const box = document.createElement('div');
  box.className = `toast ${tone}`;
  box.textContent = message;
  $('toasts').appendChild(box);
  requestAnimationFrame(() => box.classList.add('in'));
  setTimeout(() => {
    box.classList.remove('in');
    box.classList.add('out');
    setTimeout(() => box.remove(), 250);
  }, 3200);
}

/* ---------------------------------------------------------- 确认框 */
function confirmDialog({ title, text, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('modal');
    $('modalTitle').textContent = title;
    $('modalText').textContent = text;
    $('modalOk').textContent = okText;
    $('modalOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    $('modalCancel').textContent = '取消';
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));

    const close = (value) => {
      modal.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
      setTimeout(() => { modal.hidden = true; }, 180);
      $('modalOk').onclick = null;
      $('modalCancel').onclick = null;
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const onBackdrop = (e) => { if (e.target === modal) close(false); };

    $('modalOk').onclick = () => close(true);
    $('modalCancel').onclick = () => close(false);
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
    setTimeout(() => $('modalCancel').focus(), 60);
  });
}

/* ---------------------------------------------------------- 在线状态 */
function setLive(on) {
  const box = $('live');
  box.dataset.state = on ? 'on' : 'off';
  $('liveText').textContent = on ? '后台运行中' : '后台已断开';
  if (on) {
    $('liveSub').textContent = S ? `已运行 ${fmtDur(now().getTime() - S.startedAt)}` : '';
  } else {
    $('liveSub').textContent = '双击 启动.bat 重新启动';
  }
}

/* ---------------------------------------------------------- 渲染 */
function render() {
  if (!S) return;
  const logged = !!S.loggedIn;
  $('loginView').hidden = logged;
  $('appView').hidden = !logged;
  $('versionChip').textContent = 'v' + S.version;
  $('footVersion').textContent = 'v' + S.version;
  $('footNode').textContent = String(S.node || '').replace(/^v/, '');
  $('footPort').textContent = S.port;
  if (!logged) return;

  renderHero();
  renderProfile();
  renderSettings();
  renderLog();
}

function renderHero() {
  const t = S.today || {};
  const done = t.checkFlag === 1;
  const leave = t.leaveFlag === 1;
  const free = t.dormitoryFlag === 1;
  const busy = !!S.busy;
  const d = now();

  $('heroDate').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEK[d.getDay()]}`;

  let tone = 'idle';
  let text = '今日未打卡';
  if (busy) { tone = 'wait'; text = '正在核验…'; }
  else if (leave) { tone = 'wait'; text = '今日请假'; }
  else if (free) { tone = 'wait'; text = '今日免查寝'; }
  else if (done) { tone = 'ok'; text = '今日已打卡'; }
  else if (S.inWindow) { tone = 'wait'; text = '待打卡 · 窗口已开放'; }
  else { tone = 'idle'; text = '今日未打卡'; }
  $('dayBadge').dataset.tone = tone;
  $('dayBadgeText').textContent = text;

  const go = $('goBtn');
  go.classList.toggle('is-done', !!done && !busy);
  if (busy) { go.textContent = '核验中…'; go.disabled = true; }
  else if (done) { go.textContent = '今日已完成'; go.disabled = true; }
  else if (leave || free) { go.textContent = '今日无需打卡'; go.disabled = true; }
  else { go.textContent = '立即打卡'; go.disabled = false; }

  let count = '';
  if (leave) count = '今日请假，自动打卡会跳过';
  else if (free) count = '今日免查寝，不需要打卡';
  else if (done) count = `今日已完成 · 距跨天刷新 ${fmtHMS(S.nextRolloverAt - d.getTime())}`;
  else if (S.inWindow) count = `窗口开放中 · 距 24:00 重置 ${fmtHMS(S.nextRolloverAt - d.getTime())}`;
  else count = `距打卡窗口开放 ${fmtHMS(S.windowStart - d.getTime())}`;
  $('countdown').textContent = count;

  const sw = $('autoSw');
  sw.setAttribute('aria-checked', S.autoStatus && S.autoStatus.auto ? 'true' : 'false');

  const st = S.autoStatus || {};
  let sub = '每天 21:30 起自动重试';
  if (!st.auto) sub = '已关闭，到点不会自动提交';
  else if (done) sub = '今日已完成，明天继续';
  else if (!S.selfie) sub = '先上传一张打卡照片';
  else if (st.nextAt && st.nextAt > d.getTime()) sub = `下次尝试 ${fmtTime(new Date(st.nextAt))} · 已试 ${st.attempts || 0}/${st.maxAttempts || 0} 次`;
  else if (!S.inWindow) sub = '等待今晚 21:30 窗口';
  else sub = '准备提交…';
  $('autoSub').textContent = sub;

  $('nextAuto').textContent = !st.auto ? '—' : fmtNext(st.nextAt);

  $('dayChip').textContent = S.dayKey || '—';
  $('rolloverCount').textContent = `距零点 ${fmtHMS(S.nextRolloverAt - d.getTime())}`;
}

function fmtNext(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const sameDay = ymd(d) === ymd(now());
  return `${sameDay ? '' : '明天 '}${fmtTime(d)}`;
}

function renderProfile() {
  const stu = S.student || {};
  const name = stu.name || S.username || '—';
  $('avatar').textContent = (stu.name && stu.name.slice(-1)) || '·';
  $('whoName').textContent = stu.name || S.username || '—';
  const meta = [];
  if (stu.no) meta.push(`学号 ${stu.no}`);
  if (stu.grade) meta.push(stu.grade);
  $('whoMeta').textContent = meta.join(' · ') || '已登录';

  const t = S.today || {};
  let status = '未获取';
  if (t.checkFlag === 1) status = '已打卡';
  else if (t.leaveFlag === 1) status = '请假';
  else if (t.dormitoryFlag === 1) status = '免查寝';
  else if (S.today) status = '未打卡';
  $('kvStatus').textContent = status;

  if (S.lat != null || S.lon != null) {
    $('kvGeo').textContent = `${Number(S.lat).toFixed(4)}, ${Number(S.lon).toFixed(4)}`;
  } else if (S.fence) {
    $('kvGeo').textContent = `${S.fence.lat.toFixed(4)}, ${S.fence.lon.toFixed(4)}`;
  } else {
    $('kvGeo').textContent = '围栏中心未获取';
  }

  const key = `${S.selfie ? 1 : 0}:${S.selfieAt || 0}`;
  if (key !== photoKey) {
    photoKey = key;
    const img = $('thumb');
    if (S.selfie) {
      img.src = `/api/selfie?t=${S.selfieAt || Date.now()}`;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }
  $('photoTime').textContent = S.selfieAt
    ? `更新于 ${new Date(S.selfieAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
    : '未上传';
}

function renderSettings() {
  if (document.activeElement !== $('lat')) $('lat').value = S.lat ?? '';
  if (document.activeElement !== $('lon')) $('lon').value = S.lon ?? '';
}

function renderLog() {
  const logs = ((S && S.logs) || []).filter((l) => l.t > logClearedAt);
  const key = `${logs.length}|${logs.length ? logs[logs.length - 1].t : 0}|${logClearedAt}`;
  if (key === logKey) return;
  logKey = key;

  const box = $('log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const prevTop = box.scrollTop;
  box.textContent = '';

  if (!logs.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = logClearedAt ? '已清空（服务端日志仍保留）' : '还没有日志。';
    box.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const line of logs) {
    const row = document.createElement('div');
    row.className = 'log-line';
    const time = document.createElement('span');
    time.className = 'log-time';
    const td = new Date(line.t);
    time.textContent = fmtClock(td);
    const msg = document.createElement('span');
    msg.className = `log-msg ${line.kind || 'info'}`;
    msg.textContent = line.msg;
    row.append(time, msg);
    frag.appendChild(row);
  }
  box.appendChild(frag);
  if (logPaused) box.scrollTop = prevTop;
  else if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------------------------------------------------- 动作 */
async function refreshNow() {
  try {
    await pull();
    setLive(true);
  } catch (_) {
    setLive(false);
  }
  render();
}

async function doLogin(e) {
  e.preventDefault();
  const username = $('u').value.trim();
  const password = $('pw').value;
  const btn = $('loginBtn');
  const msg = $('loginMsg');
  if (!username || !password) {
    msg.className = 'msg';
    msg.textContent = '请输入学号和密码';
    return;
  }
  btn.disabled = true;
  btn.textContent = '登录中…';
  msg.className = 'msg';
  msg.textContent = '正在通过统一身份认证登录，通常需要几秒…';
  try {
    const r = await post('/api/login', { username, password });
    if (!r.ok) throw new Error(r.msg || '登录失败');
    $('pw').value = '';
    msg.textContent = '';
    await refreshNow();
    toast('登录成功');
  } catch (err) {
    msg.className = 'msg';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function toggleAuto() {
  const sw = $('autoSw');
  const next = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  try {
    const r = await post('/api/config', { auto: next });
    if (!r.ok) throw new Error(r.msg || '设置失败');
    toast(next ? '自动打卡已开启' : '自动打卡已关闭', next ? 'ok' : 'info');
    await refreshNow();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    sw.disabled = false;
  }
}

async function checkIn() {
  const btn = $('goBtn');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await post('/api/checkin');
    toast(r.msg || (r.ok ? '完成' : '失败'), r.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    await refreshNow();
  }
}

async function refreshStatus() {
  try {
    const r = await post('/api/refresh');
    if (!r.ok) throw new Error(r.msg || '刷新失败');
    await refreshNow();
    toast('状态已刷新');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function logout() {
  const yes = await confirmDialog({
    title: '退出登录？',
    text: '退出后本地保存的登录凭证会被清除，自动打卡也会停下来。',
    okText: '退出',
    danger: true,
  });
  if (!yes) return;
  await post('/api/logout').catch(() => {});
  await refreshNow();
  toast('已退出登录', 'info');
}

async function quitApp() {
  const yes = await confirmDialog({
    title: '关闭后台？',
    text: '关闭后不再自动打卡，明天也不会自己启动。需要时重新双击 启动.bat 即可。',
    okText: '关闭后台',
    danger: true,
  });
  if (!yes) return;
  try { await post('/api/quit'); } catch (_) { /* 进程可能已经退出 */ }
  setLive(false);
  toast('后台已停止', 'info');
}

/* ---------------------------------------------------------- 照片 */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

function shrinkImage(file, max = 900) {
  return new Promise(async (resolve, reject) => {
    try {
      const url = await readAsDataURL(file);
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > max) { h = Math.round(h * max / w); w = max; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => reject(new Error('图片无法解码'));
      img.src = url;
    } catch (e) { reject(e); }
  });
}

async function handleFile(file) {
  if (!file) return;
  const pick = $('pickBtn');
  pick.disabled = true;
  const label = pick.textContent;
  pick.textContent = '处理中…';
  try {
    const b64 = await shrinkImage(file);
    const r = await post('/api/selfie', { b64 });
    if (!r.ok) throw new Error(r.msg || '保存失败');
    toast('打卡照片已更新');
    await refreshNow();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    pick.disabled = false;
    pick.textContent = label;
  }
}

/* ---------------------------------------------------------- 绑定 */
function bind() {
  $('loginForm').addEventListener('submit', doLogin);
  $('autoSw').addEventListener('click', toggleAuto);
  $('goBtn').addEventListener('click', checkIn);
  $('refreshBtn').addEventListener('click', refreshStatus);
  $('logoutBtn').addEventListener('click', logout);
  $('quitBtn').addEventListener('click', quitApp);

  $('pickBtn').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    await handleFile(file);
  });
  $('lat').addEventListener('change', saveCoords);
  $('lon').addEventListener('change', saveCoords);
  $('geoReset').addEventListener('click', async () => {
    $('lat').value = '';
    $('lon').value = '';
    await saveCoords();
    toast('已改回围栏中心', 'info');
  });

  $('clrBtn').addEventListener('click', () => {
    logClearedAt = now().getTime();
    logKey = '';
    renderLog();
  });
  $('logPause').addEventListener('click', () => {
    logPaused = !logPaused;
    $('logPause').setAttribute('aria-pressed', String(logPaused));
    $('logPause').textContent = logPaused ? '恢复滚动' : '暂停滚动';
    if (!logPaused) {
      const box = $('log');
      box.scrollTop = box.scrollHeight;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshNow();
    }
  });
}

async function saveCoords() {
  const lat = $('lat').value.trim();
  const lon = $('lon').value.trim();
  try {
    const r = await post('/api/config', { lat: lat === '' ? null : lat, lon: lon === '' ? null : lon });
    if (!r.ok) throw new Error(r.msg || '保存失败');
    toast('坐标已保存');
    await refreshNow();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------------------------------------------------- 启动 */
function tickClock() {
  if (S && S.loggedIn) $('clock').textContent = fmtClock(now());
}

function boot() {
  bind();
  $('clock').textContent = fmtClock(new Date());
  setInterval(tickClock, 1000);
  loop();
}

boot();
