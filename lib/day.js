'use strict';

// 统一的日期 / 打卡窗口计算。所有函数都接受一个 Date，方便测试注入时间。

const WINDOW_START_HOUR = 21;
const WINDOW_START_MINUTE = 30;
const WINDOW_START = WINDOW_START_HOUR * 60 + WINDOW_START_MINUTE;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 当天已过的分钟数（含秒的小数部分） */
function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** 服务端只在 21:30 - 24:00 收单 */
function inWindow(d = new Date()) {
  const m = minutesOfDay(d);
  return m >= WINDOW_START && m < 24 * 60;
}

/** 当天的 21:30（已过则为明天 21:30） */
function nextWindowStart(d = new Date()) {
  const t = new Date(d);
  t.setHours(WINDOW_START_HOUR, WINDOW_START_MINUTE, 0, 0);
  if (t.getTime() <= d.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/** 下一个零点（用 setHours(24) 让运行时自己处理月底 / 闰年 / 夏令时） */
function nextMidnight(d = new Date()) {
  const t = new Date(d);
  t.setHours(24, 0, 0, 0);
  return t;
}

/** 距下一个零点的毫秒数 */
function msUntilMidnight(d = new Date()) {
  return Math.max(0, nextMidnight(d).getTime() - d.getTime());
}

module.exports = { ymd, inWindow, nextWindowStart, nextMidnight, msUntilMidnight };
