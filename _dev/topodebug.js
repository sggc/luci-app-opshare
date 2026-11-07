/* Dump topology geometry from the generated SVG so layout bugs are obvious. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, '_dev/snapshot.json'), 'utf8'));
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
const win = { __OPSHARE_NO_AUTO__: true, __OPSHARE_DATA__: data,
  addEventListener() {}, matchMedia() { return { matches: false }; },
  prompt() { return null; }, parent: null };
win.parent = win;
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
vm.runInContext(fs.readFileSync(path.join(root, 'src/www/opshare/app.js'), 'utf8'), sandbox);

const svg = els.topology.innerHTML;
const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
console.log('viewBox', vb && vb[1], vb && vb[2]);

const cards = [...svg.matchAll(/<g class="topo-card[^"]*" data-nodekey="([^"]+)">[\s\S]*?<rect class="cbg" x="([\d.]+)" y="([\d.]+)"/g)]
  .map(m => ({ key: m[1], x: +m[2], y: +m[3] }));
const shelves = [...svg.matchAll(/<rect class="topo-shelf" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
const lanes = [...svg.matchAll(/<text class="topo-lane" x="([\d.]+)" y="([\d.]+)" fill="[^"]*">([^<]+)/g)]
  .map(m => ({ x: +m[1], y: +m[2], t: m[3] }));
const chips = [...svg.matchAll(/<g class="topo-chip[^"]*" data-mac="([^"]*)">\s*<title>([^<]*)<\/title>\s*<rect class="chipbg" x="([\d.]+)" y="([\d.]+)"/g)]
  .map(m => ({ mac: m[1], tip: m[2], x: +m[3], y: +m[4] }));

console.log('\nCARDS'); cards.forEach(c => console.log(' ', c));
console.log('\nSHELVES'); shelves.forEach(s => console.log(' ', s));
console.log('\nLANES'); lanes.forEach(l => console.log(' ', l));
console.log('\nCHIPS'); chips.forEach(c => console.log(' ', c.x, c.y, c.tip.slice(0, 46)));
console.log('\n<text class=cn> names:');
[...svg.matchAll(/<text class="cn"[^>]*>([^<]*)</g)].forEach(m => console.log('  ', m[1]));
console.log('\nhint:', els['topology-hint'].textContent);
