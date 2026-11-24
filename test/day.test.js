'use strict';

const test = require('node:test');
const assert = require('node:assert');

const day = require('../lib/day');
const { DayKeeper } = require('../lib/daykeeper');

function at(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, 0);
}

test('ymd 使用本地时区并补零', () => {
  assert.equal(day.ymd(at(2026, 1, 5, 23, 59)), '2026-01-05');
  assert.equal(day.ymd(at(2026, 12, 31, 0, 0)), '2026-12-31');
});

test('打卡窗口边界：21:29:59 不算，21:30:00 开始，23:59:59 仍算', () => {
  assert.equal(day.inWindow(at(2026, 11, 23, 21, 29, 59)), false);
  assert.equal(day.inWindow(at(2026, 11, 23, 21, 30, 0)), true);
  assert.equal(day.inWindow(at(2026, 11, 23, 23, 59, 59)), true);
  assert.equal(day.inWindow(at(2026, 11, 24, 0, 0, 0)), false);
  assert.equal(day.inWindow(at(2026, 11, 23, 12, 0, 0)), false);
});

test('nextWindowStart：窗口前指向当天 21:30，窗口内与窗口后指向明天', () => {
  assert.equal(day.nextWindowStart(at(2026, 11, 23, 20, 0)).getTime(), at(2026, 11, 23, 21, 30).getTime());
  assert.equal(day.nextWindowStart(at(2026, 11, 23, 21, 30, 0)).getTime(), at(2026, 11, 24, 21, 30).getTime());
  assert.equal(day.nextWindowStart(at(2026, 11, 23, 23, 59, 59)).getTime(), at(2026, 11, 24, 21, 30).getTime());
});

test('零点按本地时间计算，跨月正确', () => {
  assert.equal(day.nextMidnight(at(2026, 11, 30, 23, 59, 59)).getTime(), at(2026, 12, 1, 0, 0, 0).getTime());
  assert.equal(day.msUntilMidnight(at(2026, 12, 31, 23, 59, 0)), 60000);
});

test('DayKeeper：日期变了才触发一次重置', () => {
  let now = at(2026, 11, 23, 23, 59, 58);
  const calls = [];
  const keeper = new DayKeeper({
    now: () => now,
    onRollover: (prev, next, d, reason) => calls.push({ prev, next, reason, at: d.getTime() }),
  });

  assert.equal(keeper.check('t1'), false, '同一天不应触发');
  assert.equal(calls.length, 0);

  now = at(2026, 11, 24, 0, 0, 2);
  assert.equal(keeper.check('t2'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prev, '2026-11-23');
  assert.equal(calls[0].next, '2026-11-24');

  keeper.check('t3');
  assert.equal(calls.length, 1, '同一天重复检查不应重复触发');
});

test('DayKeeper：休眠跨多天只记一次', () => {
  let now = at(2026, 11, 23, 22, 0, 0);
  const calls = [];
  const keeper = new DayKeeper({ now: () => now, onRollover: (p, n) => calls.push([p, n]) });
  now = at(2026, 11, 26, 9, 0, 0);
  keeper.check('wake');
  assert.deepEqual(calls, [['2026-11-23', '2026-11-26']]);
});

test('DayKeeper：onRollover 抛错不会中断看门狗', () => {
  let now = at(2026, 11, 23, 23, 0, 0);
  const logs = [];
  const keeper = new DayKeeper({
    now: () => now,
    onRollover: () => { throw new Error('boom'); },
    log: (m) => logs.push(m),
  });
  now = at(2026, 11, 24, 0, 0, 1);
  assert.equal(keeper.check('midnight'), true);
  assert.ok(logs.some((m) => m.includes('boom')));
});
