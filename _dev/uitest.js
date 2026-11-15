/* Headless smoke test for the v5 UI: run app.js against a real snapshot with
 * a minimal DOM stub and inspect the generated HTML. No browser needed. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, '_dev/snapshot.json'), 'utf8'));
if (process.env.OPSHARE_TEST_EXTERNALS === '1') {
  data.meta = data.meta || {};
  data.meta.externals = [{ id: 'test_ap', name: '测试硬路由', uplink: 'immortalwrt',
    note: 'AP 模式，无法采集无线详情', clients: 3 }];
}
const els = {};
function mk(id) {
  if (els[id]) return els[id];
  return (els[id] = {
    id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, children: [], addEventListener() {}, setAttribute() {},
    getAttribute() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, appendChild() {}, focus() {}, select() {},
    insertBefore() {}, scrollHeight: 0
  });
}
const win = {
  __OPSHARE_NO_AUTO__: true, __OPSHARE_DATA__: data,
  addEventListener() {}, matchMedia() { return { matches: false }; },
  prompt() { return null; }, parent: null
};
win.parent = win;                       // notifyHeight() exits early
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, isFinite,
  parseInt, parseFloat, encodeURIComponent, RegExp, Error,
  document: {
    getElementById(id) { return id === 'err-box' ? (els[id] || null) : mk(id); },
    addEventListener() {}, hidden: false,
    querySelectorAll() { return []; }, querySelector() { return mk('.wrap'); },
    createElement() { return mk('__tmp' + Math.random()); },
    body: { setAttribute() {}, getAttribute() { return null; }, scrollHeight: 0 },
    documentElement: { scrollHeight: 0 }
  },
  window: win,
  localStorage: { getItem() { return null; }, setItem() {} },
  setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(root, 'src/www/opshare/app.js'), 'utf8');
vm.runInContext(SRC, sandbox);

const tr = els.traffic ? els.traffic.innerHTML : '';
const rows = els.rows ? els.rows.innerHTML : '';
const topo = els.topology ? els.topology.innerHTML : '';
const nodeCards = (topo.match(/class="topo-card/g) || []).length;
const nodeRows = (tr.match(/class="trow/g) || []).length;
const chips = (tr.match(/class="iface/g) || []).length;
const tags = [...rows.matchAll(/<tr([^>]*)>/g)].map(m => m[1]);
const firstOff = tags.findIndex(t => /\boff\b/.test(t));
const onlineAfterOff = tags.slice(firstOff + 1).filter(t => t && !/\boff\b/.test(t)).length;

/* The fixture must keep at least one non-RFC1918 WAN address. app.js decides
 * whether a node has an Internet uplink with isRfc1918(wan_ip). Sanitising
 * every IPv4 into 10.0.x.x once erased that distinction: the Internet cloud
 * vanished and the topology assertion failed with a symptom pointing at the
 * renderer, when the real culprit was the test data. Guard the input here.
 * This mirrors src/www/opshare/app.js isRfc1918() and _dev/sanitize.py is_lan().
 */
const wans = data.nodes.map(n => (n.node || {}).wan_ip || '').filter(Boolean);
const pubWans = wans.filter(w => {
  const p = w.split('.').map(Number);
  return !(p.length === 4 && (p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || p[0] === 127));
});

const checks = [
  ['夹具保留公网 WAN（拓扑推断的前提）', pubWans.length > 0,
    pubWans.length + ' public / ' + wans.length + ' wan: ' + wans.join(' / ')],
  ['一个节点一行', nodeRows === data.nodes.length, nodeRows + ' rows / ' + data.nodes.length + ' nodes'],
  ['接口 chip 存在', chips > 0, chips + ' chips'],
  ['无 SVG / 折线图', !/<svg|spark|polyline/.test(tr), ''],
  ['无速率/峰值/均值', !/Mbps|Kbps|峰值|均值|采样点/.test(tr), ''],
  ['有累计总量与增量', /↓/.test(tr) && /↑/.test(tr) && /\+/.test(tr), ''],
  ['有快照时间窗口', /→/.test(tr) && /\d+s）/.test(tr), ''],
  ['离线统一沉底', firstOff >= 0 && onlineAfterOff === 0,
    'firstOff=' + firstOff + ' totalRows=' + tags.length + ' onlineAfterOff=' + onlineAfterOff],
  ['有离线分组提示行', /group-off/.test(rows), ''],
  ['无「长时间无活动」误判', !/长时间无活动/.test(rows), ''],
  ['所有无线关联客户端在线', (function () {
    const a = data.nodes.reduce((acc, n) => acc.concat(n.clients || []), [])
      .filter(c => c.source !== 'wired' && typeof c.signal === 'number' && c.signal < 0);
    return a.length > 0 && a.every(c => c.online === 1);
  })(), ''],
  ['拓扑图 SVG 已绘制', /<svg[\s>]/.test(topo) && /viewBox=/.test(topo), ''],
  ['拓扑图节点数正确', nodeCards === data.nodes.length,
    nodeCards + ' cards / ' + data.nodes.length + ' nodes'],
  ['拓扑图有 Internet 与 WAN 链路', /topo-inet/.test(topo) && /class="topo-wire/.test(topo), ''],
  ['拓扑图有流动连线', /class="topo-flow/.test(topo), ''],
  ['拓扑图标出上级物理口', /lan2/.test(topo) && /有线 lan2/.test(topo), ''],
  ['拓扑图按介质分道', /class="topo-lane"[^>]*>有线/.test(topo) && /class="topo-lane"[^>]*>5G/.test(topo), ''],
  ['拓扑图终端可点击定位', /data-mac="/.test(topo), ''],
  ['终端卡片两行（名称+详情）', /class="cn"/.test(topo) && /class="cd"/.test(topo), ''],
  ['拓扑图：卡片到终端的接线', (topo.match(/class="topo-bus"/g) || []).length >= 2 &&
    /class="topo-branch"/.test(topo) && /class="topo-spine"/.test(topo) &&
    /class="topo-tick"/.test(topo),
    (topo.match(/class="topo-bus"/g) || []).length + ' bus, ' +
    (topo.match(/class="topo-tick"/g) || []).length + ' ticks'],
  /* a row with two chips must carry the port tick all the way to the second
   * one, otherwise the right-hand chip looks like a box floating in the shelf */
  ['拓扑图：同行多台都接在一条线上', (function () {
    const re = /class="topo-tick" d="M ([\d.]+) [\d.]+ L ([\d.]+)/g;
    let m, max = 0;
    while ((m = re.exec(topo))) max = Math.max(max, parseFloat(m[2]) - parseFloat(m[1]));
    return max >= 150;
  })(), ''],
  ['流量：上传在上、下载在下', (function () {
    const parts = tr.split('<span class="iface').slice(1);
    return parts.length > 0 && parts.every(p => /↑[^↓]*↓/.test(p));
  })(), (tr.split('<span class="iface').length - 1) + ' ifaces'],
  ['前端有独立计数器通道（live）', /function pollLive/.test(SRC) && /function applyLive/.test(SRC) &&
    /a=live/.test(SRC) && /live_ms/.test(SRC), ''],
  ['非法频宽已清洗', !/13216|13076/.test(rows), ''],
  ['接口类型覆盖 VPN / 拨号 / CPU 汇聚',
    /vpn: 'VPN'/.test(SRC) && /session: '拨号'/.test(SRC) && /cpu: 'CPU 汇聚'/.test(SRC), ''],
  ['汇聚口标注勿与物理口相加', /勿相加/.test(SRC), '']
];
if (process.env.OPSHARE_TEST_EXTERNALS === '1') {
  checks.push(['不可采集硬路由画成虚线节点',
    /topo-unmanaged/.test(topo) && /无法采集/.test(topo), '']);
}
/* The topology and the client list each have their own "show offline" toggle.
 * They used to share one state variable, so turning either off hid offline
 * devices in both views. Boot a fresh sandbox with a persistent store so we
 * can drive the real change handlers and then reopen the page. */
(function () {
  function boot(store) {
    const e = {};
    const el = (id) => (e[id] || (e[id] = {
      id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false,
      style: {}, children: [], _h: {},
      addEventListener(t, fn) { this._h[t] = fn; }, setAttribute() {},
      getAttribute() { return null; }, querySelector() { return null; },
      querySelectorAll() { return []; }, appendChild() {}, focus() {}, select() {},
      insertBefore() {}, offsetTop: 0, offsetHeight: 0, scrollHeight: 0
    }));
    const w = {
      __OPSHARE_NO_AUTO__: true,
      __OPSHARE_DATA__: JSON.parse(JSON.stringify(data)),
      addEventListener() {}, matchMedia() { return { matches: false }; },
      prompt() { return null; }, location: { origin: 'http://router' }, parent: null
    };
    w.parent = w;                              // notifyHeight() exits early
    const wrap = el('.wrap');
    const sb = {
      console, Date, Math, JSON, Number, String, Object, Array, isFinite,
      parseInt, parseFloat, encodeURIComponent, RegExp, Error,
      document: {
        getElementById(id) { return id === 'err-box' ? (e[id] || null) : el(id); },
        addEventListener() {}, hidden: false,
        querySelectorAll() { return []; }, querySelector() { return wrap; },
        createElement() { return el('__t' + Math.random()); },
        body: { setAttribute() {}, getAttribute() { return null; }, scrollHeight: 0 },
        documentElement: { scrollHeight: 0 }
      },
      window: w,
      localStorage: {
        getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem(k, v) { store[k] = String(v); }
      },
      setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }
    };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(SRC, sb);
    return { e, el, store };
  }
  const offChips = (h) => (h.match(/class="topo-chip off"/g) || []).length;
  const offRows  = (h) => (h.match(/<span class="tag off">离线<\/span>/g) || []).length;
  const click = (b, id, checked) => b.el(id)._h.change.call({ checked });

  const store = {};
  const a = boot(store);
  const chips0 = offChips(a.el('topology').innerHTML);
  const rows0 = offRows(a.el('rows').innerHTML);
  checks.push(['夹具里确实有离线终端', chips0 > 0 && rows0 > 0,
    chips0 + ' chips / ' + rows0 + ' rows']);

  click(a, 'chk-offline-topo', false);
  const chips1 = offChips(a.el('topology').innerHTML);
  const rows1 = offRows(a.el('rows').innerHTML);
  checks.push(['关拓扑离线只影响拓扑图', chips1 === 0 && rows1 === rows0,
    'chips ' + chips0 + '→' + chips1 + ', rows ' + rows0 + '→' + rows1]);

  click(a, 'chk-offline-list', false);
  checks.push(['关列表离线只影响客户端列表',
    offRows(a.el('rows').innerHTML) === 0 && offChips(a.el('topology').innerHTML) === 0,
    '']);
  checks.push(['两个开关各写各的键',
    store['opshare.showOfflineTopo'] === '0' && store['opshare.showOfflineList'] === '0',
    JSON.stringify(store)]);

  const b = boot(store);                     // reopen the page with the same store
  checks.push(['下次打开仍记住两个开关',
    b.el('chk-offline-topo').checked === false && b.el('chk-offline-list').checked === false,
    '']);
  click(b, 'chk-offline-topo', true);
  checks.push(['改一个不会顺带改另一个',
    store['opshare.showOfflineTopo'] === '1' && store['opshare.showOfflineList'] === '0',
    JSON.stringify(store)]);
})();

/* Regression: the LuCI frame must be told the *content* height. When the
 * message carried document.scrollHeight (inflated by the frame's own height)
 * the frame grew on every message and the page ended in a blank strip. */
(function () {
  const e = {};
  const el = (id) => (e[id] || (e[id] = {
    id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false,
    style: {}, children: [], addEventListener() {}, setAttribute() {},
    getAttribute() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, appendChild() {}, focus() {}, select() {},
    insertBefore() {}, offsetTop: 0, offsetHeight: 0, scrollHeight: 0
  }));
  const posted = [];
  const w = {
    __OPSHARE_NO_AUTO__: true,
    __OPSHARE_DATA__: JSON.parse(JSON.stringify(data)),
    addEventListener() {}, matchMedia() { return { matches: false }; },
    prompt() { return null; }, location: { origin: 'http://router' },
    parent: { postMessage(m) { posted.push(m); } }
  };
  const wrap = el('.wrap');
  wrap.offsetHeight = 1234;                    // real content height
  const sb = {
    console, Date, Math, JSON, Number, String, Object, Array, isFinite,
    parseInt, parseFloat, encodeURIComponent, RegExp, Error,
    document: {
      getElementById(id) { return id === 'err-box' ? (e[id] || null) : el(id); },
      addEventListener() {}, hidden: false,
      querySelectorAll() { return []; }, querySelector() { return wrap; },
      createElement() { return el('__t' + Math.random()); },
      body: { setAttribute() {}, getAttribute() { return null; }, scrollHeight: 9999 },
      documentElement: { scrollHeight: 9999 }
    },
    window: w, location: { origin: 'http://router' },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  const last = posted[posted.length - 1];
  checks.push(['iframe 按内容高度缩放（不用 scrollHeight）',
    !!last && last.opshareHeight === 1234,
    last ? 'posted ' + last.opshareHeight + ' / scrollHeight 9999' :
      'no message sent']);
})();

let bad = 0;
for (const [name, ok, extra] of checks) {
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (extra ? '  ' + extra : ''));
  if (!ok) bad++;
}
console.log('hint:', els['traffic-hint'] ? els['traffic-hint'].textContent : '-');
process.exit(bad ? 1 : 0);
