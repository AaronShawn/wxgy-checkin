'use strict';

const { ymd, msUntilMidnight } = require('./day');

/**
 * 跨天看门狗。
 *
 * 解决两类问题：
 *  1. 服务长时间运行时，内存里的「今日状态」会一直停在前一天（原版的跨天 bug）；
 *  2. 电脑休眠 / 修改系统时间 / 定时器被节流后，零点那一刻的定时器可能不触发。
 *
 * 做法是「定时器 + 轮询」双保险：零点定时器负责准点重置，
 * 每 30 秒的看门狗用日期比较兜底，只要发现日期变了就补一次重置。
 */
class DayKeeper {
  constructor({ now = () => new Date(), onRollover = () => {}, log = () => {} } = {}) {
    this.now = now;
    this.onRollover = onRollover;
    this.log = log;
    this._key = ymd(this.now());
    this._timer = null;
    this._watch = null;
  }

  /** 检查是否跨天；跨了就在返回前完成重置 */
  check(reason = 'watchdog') {
    const d = this.now();
    const key = ymd(d);
    if (key === this._key) return false;

    const prev = this._key;
    this._key = key;
    this.log(`检测到跨天（${reason}）：${prev} → ${key}`);
    try {
      this.onRollover(prev, key, d, reason);
    } catch (e) {
      this.log('跨天重置回调出错：' + (e && e.message ? e.message : String(e)));
    }
    return true;
  }

  /** 距下一个零点的毫秒数 */
  msToNextDay() {
    return msUntilMidnight(this.now());
  }

  _arm() {
    clearTimeout(this._timer);
    // 多等 1.2 秒，确保系统时间已经真正进入新的一天
    const wait = this.msToNextDay() + 1200;
    this._timer = setTimeout(() => {
      const rolled = this.check('零点定时器');
      if (!rolled) {
        // 定时器提前触发（时钟被调整过），2 秒后再看一次
        this._timer = setTimeout(() => { this.check('零点重试'); this._arm(); }, 2000);
        return;
      }
      this._arm();
    }, wait);
    if (this._timer.unref) this._timer.unref();
  }

  start() {
    if (this._watch) return this;
    this._watch = setInterval(() => this.check('看门狗'), 30000);
    if (this._watch.unref) this._watch.unref();
    this._arm();
    return this;
  }
}

module.exports = { DayKeeper };
