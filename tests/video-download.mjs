import assert from 'node:assert/strict';
import vm from 'node:vm';
import {restoreVideoDownload} from '../browser/draft-page.js';

const marker = '12345678-1234-1234-1234-123456789012';
const pageURL = 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=draft';
const groupSelector = '[class^="download-content-"],[class*=" download-content-"]';

// fixture 在独立 VM 执行真正被 Chrome 序列化的函数，DOM 夹具只暴露标准接口。
// 假时钟控制浏览器事件和页面异步提交；禁止实现直接写 checked 或调用私有处理器。
function fixture(options = {}) {
  let now = 0, timerID = 0, programmaticClicks = 0;
  const timers = new Map(), allGroups = [], clickTimes = [], observedEvents = [], listenerChanges = [];
  const schedule = (delay, callback) => { const id = ++timerID; timers.set(id, {at: now + delay, callback}); return id; };
  const element = (patch = {}) => ({
    hidden: false, classList: [], attributes: {}, style: {display: 'block', visibility: 'visible'},
    getClientRects() { return this.collapsed ? [] : [{}]; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute() { throw Error('Must not alter native attributes'); },
    dispatchEvent() { throw Error('Must use standard click, not fabricated change events'); },
    ...patch,
  });
  const makeGroup = (selected = false) => {
    const listeners = new Map(), state = {deny: selected, allow: !selected};
    const group = element({classList: ['download-content-Lci5tL']});
    const denyLabel = element({textContent: '不允许', attributes: {'data-checked': String(selected)}});
    const allowLabel = element({textContent: '允许', attributes: {'data-checked': String(!selected)}});
    const deny = element(), allow = element();
    for (const [name, input] of [['deny', deny], ['allow', allow]]) {
      Object.defineProperty(input, 'checked', {get: () => state[name], set() { throw Error('Must not assign checked'); }});
      Object.defineProperty(input, 'defaultChecked', {get() { throw Error('defaultChecked is not current state'); }});
    }
    group.setState = selected => {
      state.deny = selected; state.allow = !selected;
      denyLabel.attributes['data-checked'] = String(selected);
      allowLabel.attributes['data-checked'] = String(!selected);
    };
    group.setCheckedOnly = selected => { state.deny = selected; state.allow = !selected; };
    group.emit = (type, isTrusted) => {
      observedEvents.push({type, isTrusted, at: now});
      for (const callback of [...(listeners.get(type) || [])]) callback({type, isTrusted});
    };
    group.addEventListener = (type, callback, capture) => {
      assert.equal(capture, true); listenerChanges.push({action: 'add', type, group});
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    };
    group.removeEventListener = (type, callback, capture) => {
      assert.equal(capture, true); listenerChanges.push({action: 'remove', type, group});
      assert.ok(listeners.get(type)?.delete(callback), 'remove the exact installed callback');
    };
    deny.click = () => {
      assert.equal(deny.checked, false, 'never click an already selected checkbox');
      programmaticClicks++; clickTimes.push(now);
      group.emit('click', false);
      if (options.onClick) options.onClick(group, {schedule, now, clicks: programmaticClicks});
      else group.setState(true);
      // 浏览器默认激活可能产生可信 input/change；它们不应被误判成人工接管。
      group.emit('input', true); group.emit('change', true);
    };
    allow.click = () => { throw Error('Must never enable download'); };
    denyLabel.click = allowLabel.click = () => { throw Error('Click the exact native input only'); };
    denyLabel.querySelector = selector => selector === 'input[type="checkbox"][value="0"]' ? deny : null;
    allowLabel.querySelector = selector => selector === 'input[type="checkbox"][value="1"]' ? allow : null;
    group.labels = [denyLabel, allowLabel];
    group.querySelectorAll = selector => {
      assert.equal(selector, 'label');
      if (group.queryFailure) throw Error('simulated detached DOM failure');
      return group.labels;
    };
    Object.assign(group, {deny, allow, denyLabel, allowLabel, listeners});
    allGroups.push(group); return group;
  };
  const group = makeGroup(options.selected), groups = [group];
  const dataset = {lumaDirectDraftMarker: marker, lumaDirectDraftURL: pageURL};
  const shadowRoot = {querySelectorAll(selector) { return selector === groupSelector ? groups : []; }};
  const statusHost = {id: 'luma-import-status', shadowRoot: {querySelectorAll() { throw Error('Must not inspect own status panel'); }}};
  const document = {
    documentElement: {dataset},
    querySelectorAll(selector) {
      assert.ok([groupSelector, '*'].includes(selector));
      if (selector === '*') return options.shadow ? [{shadowRoot}, statusHost] : [statusHost];
      return options.shadow ? [] : groups;
    },
  };
  const context = vm.createContext({URL, document, location: new URL(pageURL), Date: class {static now() { return now; }},
    getComputedStyle: node => node.style, setTimeout: (callback, delay) => schedule(delay, callback), marker});
  let settled = false, result, failure, started = false;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const advanceTo = async target => {
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    now = target; await flush();
  };
  return {group, groups, allGroups, dataset, context, timers, clickTimes, observedEvents, listenerChanges, makeGroup, schedule, advanceTo,
    get now() { return now; }, get clicks() { return programmaticClicks; }, get settled() { return settled; },
    start(value = marker) {
      assert.equal(started, false); started = true; context.marker = value;
      const promise = vm.runInContext(`(${restoreVideoDownload.toString()})(marker)`, context);
      promise.then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
    },
    async finish() {
      await flush();
      for (let turns = 0; !settled && turns < 1000; turns++) {
        assert.ok(timers.size, 'pending operation must have a scheduled wakeup');
        await advanceTo(Math.min(...[...timers.values()].map(timer => timer.at)));
      }
      assert.equal(settled, true, 'operation must terminate within its deadline');
      if (failure) throw failure;
      return result;
    },
    assertClean() {
      assert.equal(timers.size, 0, 'no ongoing correction timer after completion');
      for (const current of allGroups) for (const callbacks of current.listeners.values()) assert.equal(callbacks.size, 0, 'all DOM listeners removed');
      assert.equal(listenerChanges.filter(item => item.action === 'add').length, listenerChanges.filter(item => item.action === 'remove').length);
    },
  };
}

// 标准 click 经页面受控状态提交，需经历完整稳定窗口；隐藏的自有状态面板不能参与查找。
const normal = fixture({shadow: true}); normal.start();
assert.equal(normal.clicks, 1);
await normal.advanceTo(2500); assert.equal(normal.settled, false);
const normalResult = await normal.finish();
assert.equal(normalResult.ok, true); assert.equal(normal.now, 2750);
assert.equal(normal.group.deny.checked, true); assert.equal(normal.group.allow.checked, false);
assert.ok(normal.observedEvents.some(event => event.type === 'change' && event.isTrusted));
assert.deepEqual(normal.listenerChanges.filter(item => item.action === 'add').map(item => item.type), ['pointerdown', 'keydown', 'click']);
normal.assertClean();
normal.group.setState(false); normal.group.emit('pointerdown', true);
await normal.advanceTo(10000);
assert.equal(normal.clicks, 1); assert.equal(normal.group.deny.checked, false, 'handoff ends automatic enforcement');

const already = fixture({selected: true}); already.start();
assert.equal((await already.finish()).ok, true); assert.equal(already.clicks, 0); assert.equal(already.now, 2500); already.assertClean();

// 原生异步重置会重新计稳定窗口，有限重试且每次点击之间至少间隔一秒。
const reset = fixture(); reset.schedule(1250, () => reset.group.setState(false)); reset.start();
assert.equal((await reset.finish()).ok, true);
assert.deepEqual(reset.clickTimes, [0, 1250]); assert.equal(reset.now, 4000); reset.assertClean();
const repeated = fixture({onClick(group, {schedule}) { group.setState(true); schedule(500, () => group.setState(false)); }}); repeated.start();
const repeatedResult = await repeated.finish();
assert.equal(repeatedResult.ok, false); assert.match(repeatedResult.error, /反复重置/);
assert.deepEqual(repeated.clickTimes, [0, 1000, 2000]); assert.equal(repeated.now, 3000); repeated.assertClean();

// checkbox 当前值和受控标签暂时不同步时等待；不能靠 checked 或 defaultChecked 单独报成功。
const lagging = fixture({onClick(group, {schedule}) { group.setCheckedOnly(true); schedule(1500, () => group.setState(true)); }}); lagging.start();
await lagging.advanceTo(3750); assert.equal(lagging.settled, false);
assert.equal((await lagging.finish()).ok, true); assert.equal(lagging.now, 4000); assert.equal(lagging.clicks, 1); lagging.assertClean();
const stale = fixture({onClick(group) { group.setCheckedOnly(true); }}); stale.start();
assert.equal((await stale.finish()).ok, false); assert.equal(stale.now, 30000); assert.equal(stale.clicks, 1); stale.assertClean();

// 未找到唯一、可见且合法的控件组时不点任何元素；禁用可能只标在 label，input.disabled 不够。
for (const invalid of ['hidden-group', 'display-none', 'visibility-hidden', 'duplicate-group', 'duplicate-label', 'hidden-label', 'hidden-input', 'missing-input']) {
  const check = fixture();
  if (invalid === 'hidden-group') check.group.collapsed = true;
  if (invalid === 'display-none') check.group.style.display = 'none';
  if (invalid === 'visibility-hidden') check.group.style.visibility = 'hidden';
  if (invalid === 'duplicate-group') check.groups.push(check.makeGroup());
  if (invalid === 'duplicate-label') check.group.labels.push(check.group.denyLabel);
  if (invalid === 'hidden-label') check.group.denyLabel.hidden = true;
  if (invalid === 'hidden-input') check.group.deny.collapsed = true;
  if (invalid === 'missing-input') check.group.denyLabel.querySelector = () => null;
  check.start(); assert.equal((await check.finish()).ok, false, invalid); assert.equal(check.clicks, 0, invalid); check.assertClean();
}
for (const target of ['group', 'denyLabel', 'allowLabel', 'deny', 'allow']) {
  for (const kind of ['attribute', 'property', 'class']) {
    const check = fixture(), node = check.group[target] || check.group;
    if (kind === 'attribute') node.attributes['aria-disabled'] = 'true';
    if (kind === 'property') node.disabled = true;
    if (kind === 'class') node.classList.push('disabled-Iwz49E');
    check.start(); const result = await check.finish();
    assert.equal(result.ok, false); assert.match(result.error, /不允许调整/); assert.equal(check.clicks, 0); check.assertClean();
  }
}

// 页面重渲染替换组后重查节点并重新计时，旧组的事件监听也必须最终被清理。
const replaced = fixture(); replaced.schedule(1000, () => { replaced.groups[0] = replaced.makeGroup(); }); replaced.start();
assert.equal((await replaced.finish()).ok, true); assert.deepEqual(replaced.clickTimes, [0, 1000]);
assert.equal(replaced.now, 3750); replaced.assertClean();

// 绑定失效、进入作品编辑模式或导航离开，立即停止；不能继续修正同页中别的作品。
for (const change of ['marker', 'marker-url', 'origin', 'path', 'iid', 'mid', 'vid', 'draft_id', 'type']) {
  const check = fixture();
  check.schedule(500, () => {
    if (change === 'marker') delete check.dataset.lumaDirectDraftMarker;
    else if (change === 'marker-url') check.dataset.lumaDirectDraftURL += '#changed';
    else if (change === 'origin') check.context.location = new URL('https://example.com/creator-micro/content/post/video');
    else if (change === 'path') check.context.location.pathname = '/creator-micro/home';
    else { check.context.location.searchParams.set(change, change === 'type' ? 'new' : 'other'); check.dataset.lumaDirectDraftURL = check.context.location.href; }
  });
  check.start(); const result = await check.finish();
  assert.equal(result.ok, false, change); assert.match(result.error, /页面已变化/); assert.equal(check.now, 500); assert.equal(check.clicks, 1); check.assertClean();
}
const invalidMarker = fixture(); invalidMarker.start('invalid');
assert.equal((await invalidMarker.finish()).ok, false); assert.equal(invalidMarker.clicks, 0); invalidMarker.assertClean();

// 只把真实指针、键盘和点击视作人工接管；程序 click 与默认激活的可信 change 不触发接管。
for (const type of ['pointerdown', 'keydown', 'click']) {
  const manual = fixture();
  manual.schedule(500, () => { manual.group.setState(false); manual.group.emit(type, true); }); manual.start();
  const result = await manual.finish(); assert.equal(result.ok, false); assert.match(result.error, /手动调整/);
  assert.equal(manual.now, 500); assert.equal(manual.clicks, 1); manual.assertClean();
}
const synthetic = fixture(); synthetic.schedule(500, () => synthetic.group.emit('pointerdown', false)); synthetic.start();
assert.equal((await synthetic.finish()).ok, true); assert.equal(synthetic.clicks, 1); synthetic.assertClean();

// 即便浏览器节点调用抛异常，也不能泄漏监听器而在交接后继续干预用户。
const throwing = fixture({onClick() { throw Error('simulated native click failure'); }}); throwing.start();
await assert.rejects(throwing.finish(), /simulated native click failure/); throwing.assertClean();
const detached = fixture(); detached.group.queryFailure = true; detached.start();
await assert.rejects(detached.finish(), /simulated detached DOM failure/); detached.assertClean();

console.log('PASS video download standard click, stable controlled-state readback, bounded reset recovery, scoped selectors, manual takeover and cleanup');
