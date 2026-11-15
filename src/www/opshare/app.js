/* opshare UI v3 - no framework, no CDN, no build step.
 * Data sources: window.__OPSHARE_DATA__ (server injected) or, in order,
 *   /cgi-bin/luci/admin/status/opshare/data[?sync=1]   (LuCI-authenticated)
 *   /opshare/all.json                                  (public_data=1)
 *   /cgi-bin/opshare?a=all                             (token CGI)
 *
 * v3: continuous session timers with a disconnect grace period, neutral
 * role labels, iframe auto-height, visibility-aware polling, cheap signatures.
 * v5: interface traffic is just cumulative counters + a delta between two
 * timestamped snapshots (no bps / chart / history), one compact row per node;
 * offline clients are always sorted into one block at the very bottom.
 */
(function () {
	'use strict';

	var PALETTE = ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444',
		'#06b6d4', '#ec4899', '#84cc16'];
	var LSK = { aliases: 'opshare.aliases', names: 'opshare.nodeNames',
		colors: 'opshare.nodeColors', refresh: 'opshare.refreshMs',
		realtime: 'opshare.realtime',
		offline: 'opshare.showOffline',          // legacy single toggle, migrated once
		offlineTopo: 'opshare.showOfflineTopo', offlineList: 'opshare.showOfflineList',
		roles: 'opshare.roleOverrides' };

	function $(id) { return document.getElementById(id); }
	function lsGet(k, d) {
		try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }
		catch (e) { return d; }
	}
	function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function has(v) { return typeof v === 'number' && isFinite(v); }
	function dash(v) { return (v === undefined || v === null || v === '') ? '—' : v; }
	function n(v) { return (v === undefined || v === null || v === '') ? null : Number(v); }
	function validMac(m) { return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(m || '')); }
	function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : null; }
	function hash(s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; }

	var state = {
		data: null, clients: [], source: '', timer: null, tickTimer: null,
		sig: '', rendered: false, busy: false, inflight: false, lastCheck: 0,
		grace: 60, lastHeight: 0, searchTimer: null,
		aliases: lsGet(LSK.aliases, {}), nodeNames: lsGet(LSK.names, {}),
		nodeColors: lsGet(LSK.colors, {}), roleOverrides: lsGet(LSK.roles, {}),
		refreshMs: lsGet(LSK.refresh, null), realtime: lsGet(LSK.realtime, null),
		showOfflineTopo: lsGet(LSK.offlineTopo, null),
		showOfflineList: lsGet(LSK.offlineList, null)
	};

	function bandLabel(b) {
		if (!b) return '—';
		if (/6g|6ghz/i.test(b)) return '6 GHz';
		if (/5g|5ghz/i.test(b)) return '5 GHz';
		if (/2g|2\.4/i.test(b)) return '2.4 GHz';
		return b;
	}
	function roleLabel(r) {
		if (!r || r === 'node' || r === 'auto') return '节点';
		if (r === 'master') return '主节点';
		if (r === 'slave') return '从节点';
		if (r === 'bridge') return '桥接 AP';
		if (r === 'aggregator') return '汇聚节点';
		if (r === 'member') return '被汇聚节点';
		return String(r);                 // free-form custom label
	}
	function suggestLabel(r) {
		if (r === 'bridge') return '桥接 AP';
		if (r === 'aggregator') return '汇聚节点';
		if (r === 'member') return '被汇聚节点';
		return '—';
	}
	function rate(kbps) {
		var v = n(kbps);
		if (v === null || !isFinite(v) || v <= 0) return '—';
		return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + ' Mbps';
	}
	function fmtBytes(v) {
		var b = n(v);
		if (b === null || !isFinite(b) || b < 0) return '—';
		if (b < 1024) return b + ' B';
		if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
		if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
		return (b / 1073741824).toFixed(2) + ' GB';
	}
	function fmtDelta(v) {
		var b = n(v);
		if (b === null || !isFinite(b) || b < 0) return '—';
		return b === 0 ? '0' : '+' + fmtBytes(b);
	}
	function fmtMhz(v) {
		var x = n(v);
		return (x !== null && [5, 10, 20, 40, 80, 160, 320].indexOf(x) >= 0)
			? x + ' MHz' : '';
	}
	function duration(sec) {
		var v = n(sec);
		if (v === null || !isFinite(v) || v < 0) return '—';
		v = Math.floor(v);
		var d = Math.floor(v / 86400), h = Math.floor(v % 86400 / 3600),
			m = Math.floor(v % 3600 / 60), s = v % 60;
		if (d) return d + '天' + h + '小时';
		if (h) return h + '小时' + m + '分';
		if (m) return m + '分' + s + '秒';
		return s + '秒';
	}
	function timeStr(ts) {
		var v = n(ts); if (!v) return '—';
		var d = new Date(v * 1000);
		function p(x) { return x < 10 ? '0' + x : '' + x; }
		return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
	}
	function signalInfo(sig) {
		var v = n(sig);
		if (v === null || !isFinite(v) || v >= 0) return null;
		var pct = Math.max(4, Math.min(100, Math.round((v + 100) * 2)));
		var color = v >= -55 ? 'var(--green)' : v >= -67 ? 'var(--teal)' :
			v >= -75 ? 'var(--amber)' : 'var(--red)';
		var label = v >= -55 ? '极好' : v >= -67 ? '良好' : v >= -75 ? '一般' : '较弱';
		return { pct: pct, color: color, label: label, value: v };
	}
	function shortV6(csv) {
		if (!csv) return '';
		var a = String(csv).split(',')[0];
		if (!a) return '';
		return a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-8) : a;
	}

	function nodeKey(node, i) {
		var m = node._meta || {}, inf = node.node || {};
		return inf.hostname || m.host || ('node' + i);
	}
	function colorFor(node, i) {
		var k = nodeKey(node, i), m = node._meta || {};
		return validColor(state.nodeColors[k]) || validColor(m.color) || PALETTE[i % PALETTE.length];
	}
	function nameFor(node, i) {
		var k = nodeKey(node, i), m = node._meta || {}, inf = node.node || {};
		return state.nodeNames[k] || m.name || inf.id || inf.hostname || ('节点 ' + (i + 1));
	}
	function aliasFor(mac) {
		if (!mac) return null;
		return state.aliases[String(mac).toLowerCase()] || null;
	}

	function globalIdentity(data) {
		var map = {};
		(data.nodes || []).forEach(function (nd) {
			(nd.leases || []).forEach(function (l) {
				if (l.mac) map[String(l.mac).toLowerCase()] = l;
			});
		});
		return map;
	}

	function flatten(data) {
		var out = [], gid = globalIdentity(data);
		var nodes = data.nodes || [];
		for (var i = 0; i < nodes.length; i++) {
			var nd = nodes[i] || {}, m = nd._meta || {}, inf = nd.node || {};
			var nm = nameFor(nd, i), col = colorFor(nd, i), key = nodeKey(nd, i);
			var list = nd.clients || [];
			for (var j = 0; j < list.length; j++) {
				var c = {}, k;
				for (k in list[j]) if (Object.prototype.hasOwnProperty.call(list[j], k)) c[k] = list[j][k];
				c._node = nm; c._color = col; c._nodeKey = key;
				c._node_online = m.online === undefined ? 1 : m.online;
				c._section = m.section || key;
				c._node_role = state.roleOverrides[c._section] || m.role || inf.role || 'node';
				c._node_basis = m.role_basis || inf.role_basis || '';
				c._suggested = inf.suggested_role || '';
				c._node_fetched = m.fetched_at;
				c._node_time = inf.time;
				c._node_stale = m.stale;
				var g = gid[String(c.mac || '').toLowerCase()];
				if (g) { if (!c.ip) c.ip = g.ip; if (!c.hostname) c.hostname = g.hostname; }
				c._display = aliasFor(c.mac) || c.hostname || c.ip ||
					(validMac(c.mac) ? c.mac : '未知设备');
				out.push(c);
			}
		}
		return out;
	}

	/* Group by hostname (or MAC) so a phone that roamed with a randomised MAC
	 * does not keep a stale "connected" row on the old node. */
	function dedup(clients) {
		var groups = {}, i;
		for (i = 0; i < clients.length; i++) {
			var c = clients[i];
			var key = String(c.hostname || '').trim().toLowerCase();
			if (!key) key = 'mac:' + (validMac(c.mac) ? String(c.mac).toLowerCase() : 'u' + i);
			(groups[key] = groups[key] || []).push(c);
		}
		function score(c) {
			return (c.online === 1 ? 10000 : 0) +
				(has(c.signal) ? c.signal + 200 : 0) +
				(c._node_online === 1 ? 50 : 0) +
				(c.type === 'wifi' ? 20 : 0);
		}
		for (var k in groups) if (Object.prototype.hasOwnProperty.call(groups, k)) {
			var g = groups[k];
			if (g.length < 2) continue;
			g.sort(function (a, b) { return score(b) - score(a); });
			g[0]._duplicates = g.length - 1;
			for (i = 1; i < g.length; i++) {
				g[i]._moved = 1;
				g[i].online = 0;
				g[i].reason = g[i].reason || '已在其它节点出现（漫游）';
			}
		}
		return clients;
	}

	/* Connection timer: the collector keeps sessions alive across short gaps,
	 * here we compensate for the time elapsed since that node was sampled.
	 * If a node has been unreachable for longer than the grace period the timer
	 * freezes at its last known value instead of jumping or restarting. */
	/* Live duration = now - session_start. The collector keeps session_start
	 * across short dropouts, so the number never jumps back to zero. If the
	 * whole node has been unreachable for longer than the grace period we
	 * freeze at the last known value instead of silently counting the outage. */
	// Router clock + time elapsed on the client since the last fetch: avoids
	// wrong durations when the PC and the router clocks are not in sync.
	function routerNowSec() {
		var base = (state.data && n(state.data.updated)) || 0;
		if (!base) return Math.floor(Date.now() / 1000);
		var extra = state.lastCheck ? (Date.now() - state.lastCheck) / 1000 : 0;
		return Math.floor(base + extra);
	}
	function sessionSeconds(base, start, fetched, online, nodeOnline) {
		var now = routerNowSec();
		if (online !== 1) return base;
		if (start > 0) {
			if (nodeOnline !== 1 && fetched > 0 && (now - fetched) > (state.grace || 60))
				return base;
			var s = now - start;
			return s > 0 ? s : 0;
		}
		var delta = now - (fetched || 0);
		if (!isFinite(delta) || delta < 0) delta = 0;
		if (delta > 300) delta = 300;
		if (nodeOnline !== 1 && delta > (state.grace || 60)) delta = 0;
		return base + delta;
	}
	function sessionDuration(c) {
		var base = n(c.connected_time);
		if (base === null) base = n(c.driver_connected_time);
		if (base === null) return '—';
		return duration(sessionSeconds(base, n(c.session_start) || 0,
			n(c._node_fetched) || 0, c.online, c._node_online));
	}

	function renderStats(data, clients) {
		var nodes = data.nodes || [], online = 0, wifi = 0, wired = 0, off = 0, i;
		for (i = 0; i < clients.length; i++) {
			if (clients[i].online !== 1) { off++; continue; }
			if (clients[i].type === 'wired') wired++; else wifi++;
		}
		for (i = 0; i < nodes.length; i++)
			if (!nodes[i]._meta || nodes[i]._meta.online !== 0) online++;
		var meta = data.meta || {}, ui = data.ui || {};
		var cards = [
			['拓扑', esc(meta.topology || '—')],
			['在线节点', online + ' <small>/ ' + nodes.length + '</small>'],
			['在线设备', (wifi + wired)],
			['无线 / 有线', wifi + ' <small>/ ' + wired + '</small>'],
			['离线 / 残留', off],
			['断联容忍', (state.grace || 60) + ' <small>s</small>'],
			['采集周期', esc(dash(ui.interval || 30)) + ' <small>s</small>'],
			['数据时间', timeStr(data.updated)]
		];
		var html = '';
		for (i = 0; i < cards.length; i++)
			html += '<div class="stat"><div class="k">' + cards[i][0] +
				'</div><div class="v">' + cards[i][1] + '</div></div>';
		$('stats').innerHTML = html;
	}

	function roleOptions(cur) {
		var opts = [['', '节点（中性）'], ['master', '主节点'], ['slave', '从节点'],
			['bridge', '桥接 AP'], ['aggregator', '汇聚节点'], ['member', '被汇聚节点']];
		var h = '', i, found = false;
		for (i = 0; i < opts.length; i++) {
			if (opts[i][0] === cur) found = true;
			h += '<option value="' + opts[i][0] + '"' +
				(opts[i][0] === cur ? ' selected' : '') + '>' + esc(opts[i][1]) + '</option>';
		}
		if (!found && cur)
			h = '<option value="' + esc(cur) + '" selected>' + esc(cur) + '（自定义）</option>' + h;
		return h + '<option value="__custom__">自定义…</option>';
	}

	function renderNodes(data) {
		var nodes = data.nodes || [], html = '';
		for (var i = 0; i < nodes.length; i++) {
			var nd = nodes[i] || {}, m = nd._meta || {}, inf = nd.node || {};
			var off = m.online === 0, col = colorFor(nd, i), key = nodeKey(nd, i);
			var sec = m.section || key;
			var role = state.roleOverrides[sec] || m.role || inf.role || 'node';
			var v6 = [inf.lan_ipv6, inf.wan_ipv6].filter(function (x) { return !!x; }).join(' · ');
			var basis = m.role_basis || inf.role_basis || '可在页面自由设置角色';
			var sugg = inf.suggested_role || m.suggested_role || '';
			var up = has(inf.uptime) ? duration(inf.uptime) : '';
			html += '<div class="node' + (off ? ' offline' : '') + '" data-nodekey="' + esc(key) +
				'" style="border-left-color:' + col + '">' +
				'<div class="nh"><span class="nn"><span class="dot" style="background:' + col + '"></span>' +
				'<span class="nname" data-name="' + esc(key) + '">' + esc(nameFor(nd, i)) + '</span>' +
				'<button class="edit-btn" data-edit-node="' + esc(key) + '" title="重命名节点">✎</button></span>' +
				'<span class="badge role" title="' + esc(basis) + '">' + esc(roleLabel(role)) + '</span>' +
				'<span class="badge' + (off ? ' off' : '') + '">' + (off ? '离线 · 缓存' : '在线') + '</span></div>' +
				'<div class="meta">' +
				esc(inf.model || inf.hostname || '') +
				(inf.distribution || inf.version ? '<br>' + esc((inf.distribution || '') + ' ' + (inf.version || '')) : '') +
				'<br>DHCP ' + esc(dash(inf.dhcp)) + ' · LAN ' + esc(dash(inf.lan_ip)) +
				(inf.wan_ip ? ' · WAN ' + esc(inf.wan_ip) : '') +
				(v6 ? '<br>IPv6 ' + esc(v6) : '') +
				'<br>客户端 ' + (nd.clients || []).length + ' 台 · 采集于 ' + timeStr(m.fetched_at || inf.time) +
				(off && m.stale ? ' · 过期 ' + duration(m.stale) : '') +
				(up ? '<br>开机时长 ' + up + (inf.load ? ' · 负载 ' + esc(inf.load) : '') : '') +
				'<br><span class="role-basis">角色依据：' + esc(basis) + '</span>' +
				(sugg ? '<br><span class="role-basis">自动建议：' + esc(suggestLabel(sugg)) +
					'（仅供参考，不决定主从）</span>' : '') +
				'</div>' +
				'<div class="node-actions"><label>角色 <select class="role-sel" data-role-sec="' +
				esc(sec) + '" title="角色可自由设置，与拓扑无关">' + roleOptions(role) +
				'</select></label> <label>配色 <input type="color" data-color="' +
				esc(key) + '" value="' + col + '"></label></div></div>';
		}
		$('nodes').innerHTML = html || '<div class="node"><div class="meta">暂无节点数据，请确认同步服务已启动。</div></div>';
		$('role-hint').textContent = (data.meta && data.meta.role_rule) ||
			'角色是完全自由的标签，拓扑不决定主从：自动判定只给建议，可在每个节点卡片上自由设置';
	}

	/* ----------------------------------------------------------------------
	 * Network topology (v7).
	 *
	 * Structure = a tree of "units": every node owns a unit made of an info
	 * card on the left plus a terminal shelf on the right. The shelf groups
	 * terminals into lanes by physical medium (wired / 2.4G / 5G / 6G) so the
	 * attachment of every device is readable without opening the table.
	 *
	 * Links are elbow connectors sized like an org chart, drawn twice: a faint
	 * solid base plus an animated dash overlay that flows parent -> child.
	 * Plain SVG, theme-aware CSS classes, no library, any number of nodes.
	 * -------------------------------------------------------------------- */
	var TOPO = {
		W: 1120, PAD: 22, CARD_W: 300, CARD_H: 106, IND: 20, VGAP: 40,
		SHELF_GAP: 26, LANE_LABEL: 52, LANE_GAP: 7, SHELF_PAD: 9, BRACKET: 18,
		/* CHIP_GAP doubles as the visible bit of the port tick between two
		 * chips in the same row: 6px read as "disconnected", 20px reads as a
		 * cable. The chip lost 10px of width to pay for it. */
		CHIP_W: 142, CHIP_H: 34, CHIP_GAP: 20, MAX_LANE: 8, CLOUD_H: 34
	};
	var LINK_COLOR = {
		wired: '#64748b', '2g': '#d98324', '5g': '#0d8fc4', '6g': '#8b5cf6',
		wan: '#2563eb', unknown: '#94a3b8'
	};
	var LANE_TEXT = { wired: '有线', '2g': '2.4G', '5g': '5G', '6g': '6G', '': '其它' };
	var LANE_ORDER = ['wired', '2g', '5g', '6g', ''];

	function bandKind(b) {
		var s = String(b || '').toLowerCase();
		if (!s) return '';
		if (s.indexOf('6') >= 0) return '6g';
		if (s.indexOf('5') >= 0) return '5g';
		if (s.indexOf('2') >= 0) return '2g';
		return '';
	}
	function ipParts(ip) {
		var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
		return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
	}
	function isRfc1918(ip) {
		var p = ipParts(ip);
		return !!p && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
			(p[0] === 192 && p[1] === 168) || p[0] === 127);
	}
	function sameLan(a, b) {
		var x = ipParts(a), y = ipParts(b);
		return !!x && !!y && x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
	}
	function svgText(s, max) {
		s = String(s == null ? '' : s);
		if (max && s.length > max) s = s.slice(0, max - 1) + '…';
		return esc(s);
	}
	// Rough advance width: CJK glyphs are ~1em, latin ~0.56em. Good enough to
	// size pills and to decide when a label must be ellipsised.
	function textW(s, px) {
		var w = 0, i;
		s = String(s == null ? '' : s);
		for (i = 0; i < s.length; i++) w += s.charCodeAt(i) > 255 ? px : px * 0.56;
		return w;
	}
	function clipText(s, maxW, px) {
		s = String(s == null ? '' : s);
		if (textW(s, px) <= maxW) return s;
		var out = '', w = 0, i, cw;
		for (i = 0; i < s.length; i++) {
			cw = s.charCodeAt(i) > 255 ? px : px * 0.56;
			if (w + cw > maxW - px) break;
			out += s.charAt(i); w += cw;
		}
		return out + '…';
	}
	function rgba(hex, a) {
		var h = String(hex || '').replace('#', '');
		if (h.length !== 6) return 'rgba(148,163,184,' + a + ')';
		return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) +
			',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
	}
	// Polyline with rounded corners -> the soft elbow look of a real diagram.
	function roundedPath(pts, r) {
		var d = 'M ' + pts[0][0] + ' ' + pts[0][1], i;
		for (i = 1; i < pts.length - 1; i++) {
			var p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
			var v1x = p1[0] - p0[0], v1y = p1[1] - p0[1];
			var v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
			var l1 = Math.sqrt(v1x * v1x + v1y * v1y), l2 = Math.sqrt(v2x * v2x + v2y * v2y);
			if (!l1 || !l2) continue;
			var rr = Math.min(r, l1 / 2, l2 / 2);
			var ax = p1[0] - v1x / l1 * rr, ay = p1[1] - v1y / l1 * rr;
			var bx = p1[0] + v2x / l2 * rr, by = p1[1] + v2y / l2 * rr;
			d += ' L ' + ax.toFixed(1) + ' ' + ay.toFixed(1) +
				' Q ' + p1[0] + ' ' + p1[1] + ' ' + bx.toFixed(1) + ' ' + by.toFixed(1);
		}
		var e = pts[pts.length - 1];
		return d + ' L ' + e[0] + ' ' + e[1];
	}

	function shortDuration(sec) {
		var v = n(sec);
		if (v === null || !isFinite(v) || v < 0) return '—';
		v = Math.floor(v);
		var d = Math.floor(v / 86400), h = Math.floor(v % 86400 / 3600),
			m = Math.floor(v % 3600 / 60);
		if (d) return d + '天' + (h ? h + '小时' : '');
		if (h) return h + '小时' + (m ? m + '分' : '');
		return m + '分';
	}

	function chipDetail(c) {
		if (c.type === 'wired') {
			var s = c.port ? String(c.port) : '有线口';
			if (c.port_speed) s += ' · ' + c.port_speed + 'M';
			if (c.port_duplex === 'full') s += ' 全双工';
			else if (c.port_duplex === 'half') s += ' 半双工';
			return s;
		}
		var out = [];
		if (n(c.tx_rate) > 0) out.push(rate(c.tx_rate));
		else if (n(c.rx_rate) > 0) out.push(rate(c.rx_rate));
		if (has(c.signal)) out.push(c.signal + ' dBm');
		return out.join(' · ') || (c.ifname || '无线');
	}

	// How THIS node reaches its parent: derive it from the parent's own client
	// table (port + negotiated speed for wired, band + rate + signal for a
	// wireless backhaul). Falls back to the WAN address when unknown.
	function uplinkOf(n, parent) {
		if (!parent) {
			if (n.parent === 'internet')
				return { kind: 'wan', text: '拨号 ' + (n.wan || 'WAN') + ' · 公网出口' };
			return { kind: 'unknown', text: n.wan ? '上行未识别 · ' + n.wan : '无上行信息' };
		}
		var up = null;
		(parent.rawClients || []).forEach(function (c) { if (c.ip && c.ip === n.wan) up = c; });
		var from = ' · 上级 ' + parent.name;
		if (!up) return { kind: 'unknown', text: '链路类型未知' + from };
		if (up.type === 'wired') {
			var s = '有线 ' + (up.port || 'LAN');
			if (up.port_speed) s += ' · ' + up.port_speed + 'M' +
				(up.port_duplex === 'full' ? ' 全双工' : up.port_duplex === 'half' ? ' 半双工' : '');
			return { kind: 'wired', text: s + from };
		}
		var k = bandKind(up.band) || 'unknown';
		var s2 = (bandLabel(up.band) || '无线') + ' 回程';
		if (n(up.tx_rate) > 0) s2 += ' · ' + rate(up.tx_rate);
		if (has(up.signal)) s2 += ' · ' + up.signal + ' dBm';
		return { kind: k, text: s2 + from };
	}

	function buildLanes(n, skip) {
		var cl = (state.clients || []).filter(function (c) {
			return c._node === n.name && !c._moved &&
				(state.showOfflineTopo === 1 || c.online === 1) &&
				!skip['ip:' + (c.ip || '')] && !skip[String(c.mac || '').toLowerCase()];
		});
		var buckets = {};
		cl.forEach(function (c) {
			var k = c.type === 'wired' ? 'wired' : (bandKind(c.band) || '');
			(buckets[k] = buckets[k] || []).push(c);
		});
		var lanes = [];
		LANE_ORDER.forEach(function (k) {
			var arr = buckets[k];
			if (!arr || !arr.length) return;
			arr.sort(function (a, b) {
				var ao = a.online === 1 ? 1 : 0, bo = b.online === 1 ? 1 : 0;
				if (ao !== bo) return bo - ao;
				var as = has(a.signal) ? a.signal : -999, bs = has(b.signal) ? b.signal : -999;
				if (as !== bs) return bs - as;
				return String(a._display) < String(b._display) ? -1 : 1;
			});
			lanes.push({
				key: k, label: LANE_TEXT[k], total: arr.length, chips: arr,
				color: LINK_COLOR[k] || LINK_COLOR.unknown
			});
		});
		return lanes;
	}

	function buildTopoModel(data) {
		var nodes = (data.nodes || []).map(function (nd, i) {
			var inf = nd.node || {}, m = nd._meta || {};
			return {
				id: m.section || ('n' + i), name: nameFor(nd, i), color: colorFor(nd, i),
				lan: inf.lan_ip || '', wan: inf.wan_ip || '', dhcp: inf.dhcp || '',
				online: m.online !== 0, dist: inf.distribution || '', ver: inf.version || '',
				model: inf.model || '', uptime: inf.uptime, load: inf.load,
				self: m.self === 1,
				role: state.roleOverrides[m.section || ('n' + i)] || m.role || inf.role || 'node',
				rawClients: nd.clients || [], parent: null, children: [], lanes: [],
				depth: 0, x: 0, y: 0, h: 0, shelfH: 0, perRow: 3, link: null
			};
		});
		var byId = {};
		nodes.forEach(function (n) { byId[n.id] = n; });
		nodes.forEach(function (n) {
			if (!ipParts(n.wan)) return;
			if (!isRfc1918(n.wan)) { n.parent = 'internet'; return; }
			var p = null;
			nodes.forEach(function (o) { if (o !== n && sameLan(n.wan, o.lan)) p = o; });
			if (p) n.parent = p.id;
		});
		nodes.forEach(function (n) {
			var p = n.parent && byId[n.parent];
			n.link = uplinkOf(n, p || null);
		});
		return { nodes: nodes, byId: byId, externals: (data.meta && data.meta.externals) || [] };
	}

	function renderTopology(data) {
		var model = buildTopoModel(data), nodes = model.nodes;
		var ext = model.externals || [];
		if (!nodes.length && !ext.length) {
			$('topology').innerHTML = '<div class="empty">暂无节点数据</div>';
			return;
		}

		/* ---- 1. tree structure (parent -> children), cycle safe ---- */
		var roots = [], order = [], seen = {};
		nodes.forEach(function (n) {
			if (!n.parent || n.parent === 'internet' || !model.byId[n.parent]) roots.push(n);
			else model.byId[n.parent].children.push(n);
		});
		function walk(n, depth) {
			if (seen[n.id]) return;
			seen[n.id] = 1; n.depth = depth; order.push(n);
			n.children.forEach(function (c) { walk(c, depth + 1); });
		}
		roots.forEach(function (r) { walk(r, 0); });
		nodes.forEach(function (n) { if (!seen[n.id]) { n.depth = 0; n.orphan = true; order.push(n); } });

		/* ---- 2. terminals are shown once, on the node that owns them.
		 * A child node also appears in its parent's client list: skip it
		 * there, it is drawn as a card + link instead of a chip. ---- */
		var skip = {};
		nodes.forEach(function (n) {
			if (!n.parent || !model.byId[n.parent]) return;
			skip['ip:' + n.wan] = 1;                 // the child is a node, not a terminal
			var p = model.byId[n.parent];
			(p.rawClients || []).forEach(function (c) {
				if (c.ip && c.ip === n.wan && validMac(c.mac))
					skip[String(c.mac).toLowerCase()] = 1;
			});
		});
		nodes.forEach(function (n) { n.lanes = buildLanes(n, skip); });

		/* ---- 3. geometry: one unit per row, indented by depth ---- */
		var W = TOPO.W, y = TOPO.PAD;
		var hasCloud = roots.some(function (r) { return r.parent === 'internet'; });
		var cloudY = y;
		if (hasCloud) y += TOPO.CLOUD_H + 36;

		order.forEach(function (n) {
			n.x = TOPO.PAD + n.depth * TOPO.IND;
			n.y = y;
			var shelfX = n.x + TOPO.CARD_W + TOPO.SHELF_GAP;
			n.shelfW = Math.max(240, W - shelfX - TOPO.PAD);
			var inner = n.shelfW - TOPO.LANE_LABEL - TOPO.SHELF_PAD * 2 - 6 - TOPO.BRACKET;
			n.perRow = Math.max(1, Math.floor((inner + TOPO.CHIP_GAP) /
				(TOPO.CHIP_W + TOPO.CHIP_GAP)));
			var sh = 0;
			n.lanes.forEach(function (ln) {
				var over = ln.total > TOPO.MAX_LANE;
				ln.shown = over ? TOPO.MAX_LANE - 1 : ln.total;
				ln.rows = Math.ceil((ln.shown + (over ? 1 : 0)) / n.perRow) || 1;
				ln.h = ln.rows * TOPO.CHIP_H + (ln.rows - 1) * TOPO.CHIP_GAP;
				ln.top = sh;
				sh += ln.h + TOPO.LANE_GAP;
			});
			n.shelfH = n.lanes.length ? sh - TOPO.LANE_GAP + TOPO.SHELF_PAD * 2 : 0;
			/* shrink the panel to what it actually holds instead of leaving a
			 * wide empty tray next to a node with one terminal */
			if (n.lanes.length) {
				var maxCols = 1;
				n.lanes.forEach(function (ln) {
					// columns actually occupied = chips in the widest row
					var c = Math.min(ln.shown + (ln.total > ln.shown ? 1 : 0), n.perRow);
					if (c > maxCols) maxCols = c;
				});
				var needW = TOPO.SHELF_PAD * 2 + TOPO.LANE_LABEL + TOPO.BRACKET +
					maxCols * (TOPO.CHIP_W + TOPO.CHIP_GAP) - TOPO.CHIP_GAP + 8;
				if (needW > 236 && needW < n.shelfW) n.shelfW = needW;
			}
			n.h = Math.max(TOPO.CARD_H, n.shelfH);
			y += n.h + TOPO.VGAP;
		});
		var H = y + 6;

		/* ---- 3b. bus geometry ---------------------------------------------
		 * A straight line from the card to every chip is impossible: chips sit
		 * in a grid, so any line would cut through the ones in between. Instead
		 * each node gets ONE vertical bus in the gap next to its card, fed by a
		 * short cable from the card, and every medium taps it in its own colour.
		 */
		order.forEach(function (n) {
			if (!n.lanes.length) { n.hasBus = 0; return; }
			var sy = n.y, pad = TOPO.SHELF_PAD;
			var first = n.lanes[0], lastL = n.lanes[n.lanes.length - 1];
			var c0 = sy + pad + first.top + first.h / 2;
			var cN = sy + pad + lastL.top + lastL.h / 2;
			var mid = n.y + TOPO.CARD_H / 2;
			n.hasBus = 1;
			n.railX = n.x + TOPO.CARD_W + TOPO.SHELF_GAP + 3;
			n.railMid = mid;
			n.railY1 = Math.min(c0, mid);
			n.railY2 = Math.max(cN, mid);
			n.chipX = n.x + TOPO.CARD_W + TOPO.SHELF_GAP + pad + TOPO.LANE_LABEL + TOPO.BRACKET;
			n.spineX = n.chipX - 9;
		});

		/* ---- 4. connectors ---- */
		function wirePath(d, kind, dashed, raw) {
			var col = raw || LINK_COLOR[kind] || LINK_COLOR.unknown;
			return '<path class="topo-wire" d="' + d + '" stroke="' + col + '"' +
				(dashed ? ' stroke-dasharray="6 6"' : '') + '/>' +
				'<path class="topo-flow" d="' + d + '" stroke="' + col + '"/>';
		}
		function wire(pts, kind, dashed) {
			return wirePath(roundedPath(pts, 12), kind, dashed);
		}
		function curve(x1, y1, x2, y2) {
			var my = (y1 + y2) / 2;
			return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + my + ', ' + x2 + ' ' + my +
				', ' + x2 + ' ' + y2;
		}
		function tree(ax, ay, kids) {
			if (!kids.length) return '';
			var out = '', trunkX = kids[0].x - 14;
			if (kids.length === 1) {
				var k = kids[0];
				return wirePath(curve(ax, ay, k.x + 34, k.y), k.link.kind);
			}
			var lastMid = kids[kids.length - 1].y + TOPO.CARD_H / 2;
			out += wire([[ax, ay], [trunkX, ay], [trunkX, lastMid]], 'unknown', true);
			kids.forEach(function (k) {
				var mid = k.y + TOPO.CARD_H / 2;
				out += wire([[trunkX, mid], [k.x, mid]], k.link.kind);
			});
			return out;
		}

		var lines = '';
		if (hasCloud) {
			var inet = roots.filter(function (r) { return r.parent === 'internet'; });
			lines += tree(inet[0].x + 34, cloudY + TOPO.CLOUD_H, inet);
		}
		order.forEach(function (n) {
			if (!n.children.length) return;
			lines += tree(n.x + 34, n.y + TOPO.CARD_H, n.children);
		});

		/* ---- 5. body ---- */
		var body = '';
		if (hasCloud) {
			body += '<g class="topo-inet">' +
				'<rect x="' + TOPO.PAD + '" y="' + cloudY + '" width="212" height="' + TOPO.CLOUD_H +
				'" rx="17"/>' +
				'<circle cx="' + (TOPO.PAD + 20) + '" cy="' + (cloudY + TOPO.CLOUD_H / 2) + '" r="5"/>' +
				'<text x="' + (TOPO.PAD + 34) + '" y="' + (cloudY + 21) + '">Internet · 运营商出口</text></g>';
		}

		order.forEach(function (n) {
			var x = n.x, cy = n.y, ok = n.online;
			var online = 0, total = 0;
			n.lanes.forEach(function (ln) {
				total += ln.total;
				ln.chips.forEach(function (c) { if (c.online === 1) online++; });
			});
			var nameW = TOPO.CARD_W - 76 - (n.self ? 34 : 0);
			var head = clipText(n.name, nameW, 13.5);

			body += '<g class="topo-card' + (ok ? '' : ' off') + '" data-nodekey="' + esc(n.name) + '">' +
				'<rect class="cbg" x="' + x + '" y="' + cy + '" width="' + TOPO.CARD_W +
				'" height="' + TOPO.CARD_H + '" rx="10" filter="url(#topoSh)"/>' +
				'<rect x="' + x + '" y="' + cy + '" width="4" height="' + TOPO.CARD_H +
				'" rx="2" fill="' + n.color + '"/>' +
				'<circle class="cdot" cx="' + (x + 16) + '" cy="' + (cy + 17) + '" r="3.6" ' +
				(ok ? '' : 'style="fill:var(--muted)"') + '/>' +
				'<text class="ct" x="' + (x + 26) + '" y="' + (cy + 21) + '">' + esc(head) + '</text>';

			if (n.self)
				body += '<text class="ctag" x="' + (x + 26 + textW(head, 16) + 8) + '" y="' + (cy + 20) +
					'">本机</text>';

			var roleTxt = roleLabel(n.role);
			if (roleTxt && roleTxt !== '节点')
				body += '<text class="crole" x="' + (x + TOPO.CARD_W - 12) + '" y="' + (cy + 20) +
					'" text-anchor="end">' + esc(clipText(roleTxt, 74, 10)) + '</text>';

			var sub = ((n.model || n.dist || '') + ' ' + (n.ver || '')).trim() || 'OpenWrt';
			body += '<text class="cm" x="' + (x + 14) + '" y="' + (cy + 39) + '">' +
				svgText(sub, 34) + '</text>';
			body += '<text class="cm" x="' + (x + 14) + '" y="' + (cy + 55) + '">LAN ' + esc(n.lan || '—') +
				(n.wan ? '  ·  WAN ' + esc(n.wan) : '') + '</text>';

			var lk = n.link || { kind: 'unknown', text: '—' };
			var lc = LINK_COLOR[lk.kind] || LINK_COLOR.unknown;
			var ltxt = clipText(lk.text, TOPO.CARD_W - 32, 9.5);
			body += '<rect class="cup" x="' + (x + 12) + '" y="' + (cy + 63) + '" width="' +
				(textW(ltxt, 9.5) + 16).toFixed(0) + '" height="17" rx="8.5" fill="' + rgba(lc, .16) +
				'" stroke="' + rgba(lc, .42) + '"/>' +
				'<text class="cup-t" x="' + (x + 20) + '" y="' + (cy + 75) + '" fill="' + lc + '">' +
				esc(ltxt) + '</text>';

			var tail = '终端 ' + online + ' / ' + total;
			if (n.children.length) tail += '  ·  下挂 ' + n.children.length + ' 节点';
			if (has(n.uptime)) tail += '  ·  运行 ' + shortDuration(n.uptime);
			body += '<text class="cm" x="' + (x + 14) + '" y="' + (cy + 95) + '">' +
				esc(clipText(tail, TOPO.CARD_W - 26, 10)) + '</text></g>';

			/* shelf */
			if (!n.lanes.length) return;
			var sx = x + TOPO.CARD_W + TOPO.SHELF_GAP, sy = cy;
			body += '<rect class="topo-shelf" x="' + sx + '" y="' + sy + '" width="' + n.shelfW +
				'" height="' + n.shelfH + '" rx="10"/>' +
				/* cable out of the card + the rail it feeds. Painted after the
				 * panel background so the rail is visible inside the panel. */
				'<path class="topo-bus" stroke="' + (n.color || LINK_COLOR.unknown) + '" d="M ' +
				(x + TOPO.CARD_W) + ' ' + n.railMid + ' L ' + n.railX + ' ' + n.railMid + '"' +
				(n.railY2 - n.railY1 > 2
					? ' /><path class="topo-bus" stroke="' + (n.color || LINK_COLOR.unknown) +
					  '" d="M ' + n.railX + ' ' + n.railY1 + ' L ' + n.railX + ' ' + n.railY2
					: '') + '"/>' +
				'<circle class="topo-hub" cx="' + n.railX + '" cy="' + n.railMid + '" r="2.6" fill="' +
				(n.color || LINK_COLOR.unknown) + '"/>';
			/* one branch per medium into its own port spine; every chip taps
			 * the spine with a short tick, so each device is visibly attached */
			n.lanes.forEach(function (ln) {
				var top = sy + TOPO.SHELF_PAD + ln.top, bot = top + ln.h;
				var ctr = (top + bot) / 2, r, ty;
				body += '<path class="topo-branch" d="M ' + n.railX + ' ' + ctr + ' L ' +
					n.spineX + ' ' + ctr + '" stroke="' + ln.color + '"/>' +
					'<path class="topo-spine" d="M ' + n.spineX + ' ' + (top + 5) + ' L ' +
					n.spineX + ' ' + (bot - 5) + '" stroke="' + ln.color + '"/>';
				for (r = 0; r < ln.rows; r++) {
					ty = top + r * (TOPO.CHIP_H + TOPO.CHIP_GAP) + TOPO.CHIP_H / 2;
					/* The tick has to reach the LAST chip of this row: a second
					 * column with a line ending before it looks like a detached
					 * box floating in the shelf. Chip backgrounds are opaque, so
					 * the line only shows in the gaps - which reads as a string
					 * of devices tapped onto one port. */
					var cols = 0, i;
					for (i = 0; i < ln.shown; i++) if (Math.floor(i / n.perRow) === r) cols++;
					if (ln.total > ln.shown && Math.floor(ln.shown / n.perRow) === r) cols++;
					if (cols < 1) cols = 1;
					var endX = n.chipX + (cols - 1) * (TOPO.CHIP_W + TOPO.CHIP_GAP);
					body += '<path class="topo-tick" d="M ' + n.spineX + ' ' + ty + ' L ' +
						endX + ' ' + ty + '" stroke="' + ln.color + '"/>';
				}
			});
			var ly = sy + TOPO.SHELF_PAD;
			n.lanes.forEach(function (ln) {
				body += '<text class="topo-lane" x="' + (sx + TOPO.SHELF_PAD + 6) + '" y="' +
					(ly + 15) + '" fill="' + ln.color + '">' + esc(ln.label) + '</text>' +
					'<text class="topo-lane-n" x="' + (sx + TOPO.SHELF_PAD + 6) + '" y="' + (ly + 29) +
					'" fill="' + ln.color + '">' + ln.total + ' 台</text>';
				var items = ln.chips.slice(0, ln.shown);
				items.forEach(function (c, idx) {
					var r = Math.floor(idx / n.perRow), colI = idx % n.perRow;
					var bx = sx + TOPO.SHELF_PAD + TOPO.LANE_LABEL + TOPO.BRACKET +
						colI * (TOPO.CHIP_W + TOPO.CHIP_GAP);
					var by = ly + r * (TOPO.CHIP_H + TOPO.CHIP_GAP);
					var off = c.online !== 1;
					var label = c._display || c.hostname || c.ip || c.mac || '?';
					var tip = [label, c.ip, c.mac,
						c.type === 'wired' ? ('有线 ' + (c.port || '') + (c.port_speed ? ' · ' + c.port_speed + 'M' : ''))
							: ((bandLabel(c.band) || '无线') + (c.ssid ? ' · ' + c.ssid : '') +
								(has(c.signal) ? ' · ' + c.signal + ' dBm' : '')),
						off ? '离线' : '在线 · 点击定位到列表'].filter(Boolean).join(' · ');
					var dattr = validMac(c.mac) ? ' data-mac="' +
						esc(String(c.mac).toLowerCase()) + '"' : '';
					body += '<g class="topo-chip' + (off ? ' off' : '') + '"' + dattr + '>' +
						'<title>' + esc(tip) + '</title>' +
						'<rect class="chipbg" x="' + bx + '" y="' + by + '" width="' + TOPO.CHIP_W + '" height="' +
						TOPO.CHIP_H + '" rx="7"/>' +
						'<rect x="' + bx + '" y="' + by + '" width="3" height="' + TOPO.CHIP_H +
						'" rx="1.5" fill="' + ln.color + '"/>' +
						'<text class="cn" x="' + (bx + 11) + '" y="' + (by + 14) + '">' +
						svgText(label, 19) + '</text>' +
						'<text class="cd" x="' + (bx + 11) + '" y="' + (by + 26) + '">' +
						esc(clipText(chipDetail(c), TOPO.CHIP_W - 18, 9.5)) + '</text></g>';
				});
				if (ln.total > ln.shown) {
					var idx2 = ln.shown, r2 = Math.floor(idx2 / n.perRow), c2 = idx2 % n.perRow;
					var mx = sx + TOPO.SHELF_PAD + TOPO.LANE_LABEL + TOPO.BRACKET + c2 * (TOPO.CHIP_W + TOPO.CHIP_GAP);
					var my = ly + r2 * (TOPO.CHIP_H + TOPO.CHIP_GAP);
					body += '<g class="topo-chip more"><rect class="chipbg" x="' + mx + '" y="' + my + '" width="' +
						TOPO.CHIP_W + '" height="' + TOPO.CHIP_H + '" rx="7"/><text class="cd" x="' +
						(mx + 11) + '" y="' + (my + 21) + '">还有 ' + (ln.total - ln.shown) +
						' 台未显示</text></g>';
				}
				ly += ln.h + TOPO.LANE_GAP;
			});
		});

		/* external (not collectable) devices: declared in UCI on purpose */
		if (ext.length) {
			var ey = y;
			ext.forEach(function (e, k) {
				var ex = TOPO.PAD + k * (TOPO.CARD_W + 16);
				body += '<g class="topo-unmanaged"><rect x="' + ex + '" y="' + ey + '" width="' +
					TOPO.CARD_W + '" height="' + TOPO.CARD_H + '" rx="10"/>' +
					'<text class="ct" x="' + (ex + 14) + '" y="' + (ey + 21) + '">' +
					svgText(e.name || '外部设备', 16) + '</text>' +
					'<text class="cm" x="' + (ex + 14) + '" y="' + (ey + 41) + '">无法采集 · 非 OpenWrt 设备</text>' +
					'<text class="cm" x="' + (ex + 14) + '" y="' + (ey + 58) + '">' +
					esc(clipText((e.note || '手工声明') + (e.uplink ? ' · 上行 ' + e.uplink : ''),
						TOPO.CARD_W - 28, 10)) + '</text>' +
					'<text class="cm" x="' + (ex + 14) + '" y="' + (ey + 76) + '">' +
					(Number(e.clients) || 0) + ' 台下挂设备（手填）</text></g>';
			});
			H = ey + TOPO.CARD_H + 8;
		}

		$('topology').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H +
			'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="网络拓扑图">' +
			'<defs><filter id="topoSh" x="-15%" y="-15%" width="130%" height="140%">' +
			'<feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#0f172a" flood-opacity=".18"/>' +
			'</filter></defs>' + lines + body + '</svg>';

		var wired = 0, wifi = 0;
		nodes.forEach(function (n) {
			n.lanes.forEach(function (ln) {
				if (ln.key === 'wired') wired += ln.total; else wifi += ln.total;
			});
		});
		$('topology-hint').textContent = nodes.length + ' 个节点 · ' + order.length + ' 层视图 · ' +
			wired + ' 有线 / ' + wifi + ' 无线终端' +
			(ext.length ? ' · ' + ext.length + ' 个不可采集设备' : '');
	}

	var KIND_LABEL = { wan: 'WAN', lan: 'LAN', wifi: '无线', port: '物理口',
		session: '拨号', vpn: 'VPN', cpu: 'CPU 汇聚' };
	// lan (br-lan) and cpu (DSA master) already include their member ports, so
	// they are labelled and pushed to the end. Adding them to the physical-port
	// rows would count the same packets twice.
	var KIND_ORDER = { wan: 0, session: 1, vpn: 2, lan: 3, wifi: 4, port: 5, cpu: 9 };
	var STATE_LABEL = {
		baseline: '首次采样：本帧作为基线，下一周期开始计增量',
		reboot: '设备已重启：计数器从新基线开始，本次增量跳过',
		reset: '计数器重置：本次增量跳过，当前值作为新基线',
		wrap32: '32 位计数器回绕：增量已按回绕补偿',
		clock: '时钟跳变 / 间隔异常：本次增量跳过'
	};

	// One row per NODE. Each interface is a small card with two aligned lines:
	// upload (tx) on top, download (rx) below, each showing the interface's own
	// cumulative counter plus the delta to the previous timestamped snapshot.
	// No rates, no SVG, no history series.
	function renderTraffic(data) {
		var html = '', nodes = data.nodes || [];
		nodes.forEach(function (nd, i) {
			var arr = (nd.traffic || []).slice();
			arr.sort(function (a, b) {
				var ka = KIND_ORDER[a.kind] === undefined ? 9 : KIND_ORDER[a.kind];
				var kb = KIND_ORDER[b.kind] === undefined ? 9 : KIND_ORDER[b.kind];
				if (ka !== kb) return ka - kb;
				return String(a.ifname) < String(b.ifname) ? -1 : 1;
			});
			var chips = '', win = '', flags = [], m = nd._meta || {};
			arr.forEach(function (t) {
				var st = t.state || 'ok', note = STATE_LABEL[st] || '';
				// Idle interfaces do not take up space, but a reset/baseline
				// flag is always shown even when the counters are now zero.
				if (!note && st === 'ok' && Number(t.rx_total) === 0 &&
					Number(t.tx_total) === 0 && Number(t.rx_delta) === 0 &&
					Number(t.tx_delta) === 0) return;
				if (note && flags.indexOf(note) < 0) flags.push(note);
			var skip = (st === 'reset' || st === 'clock' || st === 'baseline' || st === 'reboot');
			var agg = (t.kind === 'cpu' || t.kind === 'lan')
				? ' · 汇聚口：已包含物理口计数，勿相加' : '';
			var line = function (cls, arrow, name, total, delta) {
					var d = skip ? '<span class="d muted">—</span>'
						: '<span class="d">' + esc(delta) + '</span>';
					return '<span class="ib ' + cls + '"><span class="k"><i>' + arrow + '</i>' +
						name + '</span><span class="v">' + esc(total) + '</span>' + d + '</span>';
				};
				chips += '<span class="iface' + (skip ? ' flagged' : '') + '" title="' +
					esc(t.ifname + ' · 累计 上传 ' + fmtBytes(t.tx_total) + ' / 下载 ' + fmtBytes(t.rx_total) +
						(note ? ' · ' + note : '') + agg) + '">' +
					'<span class="ih"><b>' + esc(t.ifname) + '</b><span class="tagk">' +
					esc(KIND_LABEL[t.kind] || t.kind || '口') + '</span></span>' +
					line('up', '↑', '上传', fmtBytes(t.tx_total), fmtDelta(t.tx_delta)) +
					line('dn', '↓', '下载', fmtBytes(t.rx_total), fmtDelta(t.rx_delta)) +
					'</span>';
				if (!win && t.prev_ts) win = timeStr(t.prev_ts) + ' → ' + timeStr(t.ts) +
					'（' + (t.dt || 0) + 's）';
			});
			html += '<div class="trow' + (m.online === 0 ? ' offline' : '') +
				'" style="border-left-color:' + colorFor(nd, i) + '">' +
				'<div class="tnode"><b>' + esc(nameFor(nd, i)) + '</b>' +
				(m.online === 0 ? '<span class="tag off">离线</span>' : '') + '</div>' +
				'<div class="tifaces">' + (chips || '<span class="muted">暂无接口数据</span>') + '</div>' +
				'<div class="twin">' + esc(win || '—') +
				(flags.length ? '<span class="flag" title="' + esc(flags.join('；')) + '">' +
					esc(flags[0]) + '</span>' : '') + '</div></div>';
		});
		$('traffic').innerHTML = html || '<div class="empty">暂无接口流量数据</div>';
		var dui = data.ui || {};
		if (live.cad) updateCadence();
		else if (dui.live) $('traffic-hint').innerHTML = '计数 <b>' +
			(dui.fast_traffic || 2) + 's</b> · 全量 <b>' + (dui.fast_interval || 12) +
			's</b> · 无人查看时自动降速';
		else $('traffic-hint').textContent = '采样间隔 ' + (dui.traffic_interval || 10) +
			's · 相邻快照增量 · 仅内存保存上一帧';
	}

	function buildFilters(clients) {
		var nodeSel = $('f-node'), bandSel = $('f-band');
		var curN = nodeSel.value, curB = bandSel.value;
		var ns = {}, bs = {};
		clients.forEach(function (c) {
			if (c._node) ns[c._node] = 1;
			if (c.band) bs[c.band] = 1;
		});
		function fill(sel, map, label, fmt) {
			var h = '<option value="">' + label + '</option>', k;
			for (k in map) if (Object.prototype.hasOwnProperty.call(map, k))
				h += '<option value="' + esc(k) + '">' + esc(fmt ? fmt(k) : k) + '</option>';
			sel.innerHTML = h;
		}
		fill(nodeSel, ns, '全部节点'); fill(bandSel, bs, '全部频段', bandLabel);
		if (ns[curN]) nodeSel.value = curN;
		if (bs[curB]) bandSel.value = curB;
	}

	function renderRows() {
		var clients = state.clients || [];
		var q = ($('f-search').value || '').toLowerCase();
		var fn = $('f-node').value, fb = $('f-band').value, ft = $('f-type').value;
		var rows = clients.filter(function (c) {
			if (state.showOfflineList !== 1) {
				if (c.online !== 1 || c._moved) return false;
			}
			if (fn && c._node !== fn) return false;
			if (fb && c.band !== fb) return false;
			if (ft && (c.type || 'wifi') !== ft) return false;
			if (q) {
				var hay = [c._display, c.hostname, c.mac, c.ip, c.ipv6, c.ssid, c._node, c.ifname]
					.join(' ').toLowerCase();
				if (hay.indexOf(q) < 0) return false;
			}
			return true;
		});
		// Offline rows ALWAYS form one block at the very bottom, no matter
		// which node/band/signal they have. Everything else keeps its usual
		// node -> signal ordering.
		rows.sort(function (a, b) {
			var ao = (a.online === 1 && !a._moved) ? 1 : 0;
			var bo = (b.online === 1 && !b._moved) ? 1 : 0;
			if (ao !== bo) return bo - ao;
			if (a._node !== b._node) return a._node < b._node ? -1 : 1;
			var as = has(a.signal) ? a.signal : -999, bs = has(b.signal) ? b.signal : -999;
			return bs - as;
		});
		var html = '', offlineStarted = false;
		for (var i = 0; i < rows.length; i++) {
			var c = rows[i], name = c._display;
			if (!offlineStarted && (c.online !== 1 || c._moved)) {
				offlineStarted = true;
				html += '<tr class="group-off"><td colspan="10">以下为离线设备（仅 DHCP 租约 / 关联残留 / 节点离线）</td></tr>';
			}
			var sig = signalInfo(c.signal);
			var sigHtml = sig
				? '<div class="sig"><span class="bar"><i style="width:' + sig.pct + '%;background:' + sig.color + '"></i></span>' +
					'<span class="num" style="color:' + sig.color + '">' + sig.value + ' dBm</span>' +
					'<span class="tag">' + sig.label + '</span></div>'
				: '<span class="muted">—</span>';
			var extra = [];
			var mhz = fmtMhz(c.tx_mhz) || fmtMhz(c.rx_mhz);
			if (mhz) extra.push(mhz);
			if (has(c.tx_mcs)) extra.push('MCS ' + c.tx_mcs);
			if (has(c.tx_nss)) extra.push('NSS ' + c.tx_nss);
			if (c.he) extra.push('WiFi 6');
			var rateHtml = '<span class="rate">' + rate(c.rx_rate) + ' / ' + rate(c.tx_rate) +
				(extra.length ? '<span class="extra">' + esc(extra.join(' · ')) + '</span>' : '') + '</span>';
			var conn = c.type === 'wired'
				? '<span class="tag">有线</span>'
				: '<span class="tag">' + esc(bandLabel(c.band)) + '</span>';
			if (c.online !== 1) conn += '<span class="tag off">离线</span>';
			if (c._duplicates) conn += '<span class="tag">合并 ' + c._duplicates + '</span>';
			var portHtml = c.type === 'wired'
				? (c.port ? esc(c.port) : '—') +
					(c.port_speed ? '<span class="mac"><br>' + esc(c.port_speed) + ' M · ' +
						esc(c.port_duplex === 'full' ? '全双工' : c.port_duplex === 'half' ? '半双工' : c.port_duplex || '') + '</span>'
						: '<span class="mac"><br>速率未知</span>')
				: (c.ifname || '—') + '<span class="mac"><br>无线接口</span>';
			var v6 = shortV6(c.ipv6);
			var gapTag = c.session_gap > 5 && c.online === 1
				? '<span class="mac"><br><span class="tag grace" title="' +
					(c.session_gap) + 's 内的断联按误差忽略，计时未重置">忽略 ' +
					(c.session_gap) + 's 抖动</span></span>' : '';
			var base = n(c.connected_time);
			if (base === null) base = n(c.driver_connected_time);
			html += '<tr' + (validMac(c.mac) ? ' data-mac="' +
					esc(String(c.mac).toLowerCase()) + '"' : '') +
				(c.online === 1 && !c._moved ? '' : ' class="off"') + '>' +
				'<td class="nodebar" style="background:' + c._color + '"></td>' +
				'<td><span class="dev">' + esc(name) + '</span>' +
					'<button class="edit-btn" data-edit-mac="' + esc(c.mac) + '" title="自定义设备名称">✎</button>' +
					(c.source ? '<span class="mac"><br>' + esc(c.source) + '</span>' : '') +
					(c.reason ? (c.online === 1
						? '<span class="mac"><br><span class="tag idle" title="只是省电/久未发包的提示，设备仍保持关联并在线">' +
							esc(c.reason) + '</span></span>'
						: '<span class="mac"><br>' + esc(c.reason) + '</span>') : '') + '</td>' +
				'<td>' + esc(dash(c.ip)) + '<span class="mac"><br>' + esc(dash(c.mac)) + '</span>' +
					(v6 ? '<span class="ipv6" title="' + esc(c.ipv6) + '"><br>IPv6 ' + esc(v6) + '</span>' : '') + '</td>' +
				'<td><span class="node-badge" style="border-color:' + c._color + '">' + esc(c._node) + '</span>' +
					'<span class="mac"><br>' + esc(roleLabel(c._node_role)) + '</span></td>' +
				'<td>' + conn + '</td>' +
				'<td>' + portHtml + '</td>' +
				'<td>' + esc(bandLabel(c.band)) + '<span class="mac"><br>' + esc(dash(c.ssid)) + '</span></td>' +
				'<td>' + sigHtml + '</td>' +
				'<td>' + rateHtml + '</td>' +
				'<td><span class="dur" data-base="' + (base === null ? 0 : base) + '"' +
					' data-start="' + (n(c.session_start) || 0) + '"' +
					' data-fetched="' + (n(c._node_fetched) || 0) + '"' +
					' data-online="' + (c.online === 1 ? 1 : 0) + '"' +
					' data-nodeonline="' + (c._node_online === 1 ? 1 : 0) + '">' +
					esc(sessionDuration(c)) + '</span>' + gapTag + '</td>' +
				'</tr>';
		}
		$('rows').innerHTML = html;
		$('empty').hidden = rows.length > 0;
		notifyHeight();
	}

	function tickDurations() {
		if (document.hidden) return;
		var els = document.querySelectorAll('#rows span.dur');
		for (var i = 0; i < els.length; i++) {
			var e = els[i];
			var base = Number(e.getAttribute('data-base')) || 0;
			var start = Number(e.getAttribute('data-start')) || 0;
			var fetched = Number(e.getAttribute('data-fetched')) || 0;
			var online = Number(e.getAttribute('data-online'));
			var nodeOnline = Number(e.getAttribute('data-nodeonline'));
			var text = duration(sessionSeconds(base, start, fetched, online, nodeOnline));
			if (e.textContent !== text) e.textContent = text;
		}
	}

	function applyUI(data) {
		var ui = data.ui || {};
		if (state.refreshMs === null) state.refreshMs = ui.refresh_ms || 10000;
		if (state.realtime === null) state.realtime = ui.realtime || 0;
		live.ms = n(ui.live_ms) || 2000;
		// Topology and list used to share one toggle. Migrate that old value
		// once so upgrading does not flip anything; from then on each view
		// remembers its own setting in localStorage, independently.
		var legacy = lsGet(LSK.offline, null);
		var dflt = (ui.show_offline === undefined ? 1 : ui.show_offline);
		if (state.showOfflineTopo === null)
			state.showOfflineTopo = (legacy === null ? dflt : legacy);
		if (state.showOfflineList === null)
			state.showOfflineList = (legacy === null ? dflt : legacy);
		state.grace = n(ui.session_grace) || 60;
		$('sel-interval').value = String(state.refreshMs);
		$('chk-realtime').checked = !!state.realtime;
		$('chk-offline-topo').checked = !!state.showOfflineTopo;
		$('chk-offline-list').checked = !!state.showOfflineList;
	}

	function applyAliases(data) {
		(data.aliases || []).forEach(function (a) {
			if (a.mac && a.name && !state.aliases[String(a.mac).toLowerCase()])
				state.aliases[String(a.mac).toLowerCase()] = a.name;
		});
	}

	function updateSourceLabel() {
		var ui = (state.data && state.data.ui) || {};
		$('source').textContent = '数据源：' + (state.source || '内嵌') +
			' · 整页刷新 ' + (state.refreshMs / 1000) + 's' +
			(ui.live ? ' · 计数器通道 ' + (live.ms / 1000) + 's' : '') +
			(state.realtime ? ' · 每次刷新即时合并' : '') +
			' · 全量采集 ' + (ui.interval || 30) + 's';
	}

	function render(data) {
		state.data = data;
		applyUI(data); applyAliases(data);
		state.clients = dedup(flatten(data));
		renderStats(data, state.clients);
		renderTopology(data);
		renderNodes(data);
		renderTraffic(data);
		buildFilters(state.clients);
		renderRows();
		var online = state.clients.filter(function (c) { return c.online === 1 && !c._moved; }).length;
		/* pairing state is part of the headline: "did the two boxes find each
		 * other" is the first thing you want to know after installing it */
		var dui = data.ui || {}, bits = [
			(data.nodes || []).length + ' 个节点',
			online + ' 台在线设备',
			'数据时间 ' + timeStr(data.updated)
		];
		if (dui.auto_peers > 0) bits.push('自动配对 ' + dui.auto_peers + ' 台');
		else if (Number(dui.auto_pair) === 0) bits.push('自动配对已关闭');
		else bits.push('等待配对');
		if (dui.eff_mode === 'hub') bits.push('本机聚合');
		else if (dui.eff_mode === 'off' || dui.eff_mode === 'pull') bits.push('被动接收');
		if (Number(dui.power) === 1) bits.push('节能档');
		$('subtitle').textContent = bits.join(' · ');
		updateSourceLabel();
		state.rendered = true;
		var err = $('err-box'); if (err) err.parentNode.removeChild(err);
		notifyHeight();
	}

	function showError(msg) {
		var e = $('err-box');
		if (!e) {
			e = document.createElement('div'); e.id = 'err-box'; e.className = 'err';
			var wrap = document.querySelector('.wrap'); wrap.insertBefore(e, wrap.children[1]);
		}
		e.textContent = msg;
		notifyHeight();
	}

	function getJSON(url, cb) {
		var x = new XMLHttpRequest();
		x.open('GET', url, true);
		x.onreadystatechange = function () {
			if (x.readyState !== 4) return;
			if (x.status === 200 && x.responseText && x.responseText.charAt(0) === '{') {
				try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
			} else cb(new Error('HTTP ' + x.status));
		};
		x.onerror = function () { cb(new Error('network')); };
		x.send();
	}

	function endpoints(force) {
		var stamp = '_=' + Date.now();
		return [
			'/cgi-bin/luci/admin/status/opshare/data?' + (force ? 'sync=1&' : '') + stamp,
			'/opshare/all.json?' + stamp,
			'/cgi-bin/opshare?a=all&' + stamp
		];
	}

	// Cheap signature: never stringify the whole payload on every poll.
	function signature(d) {
		var p = [d.updated, (d.nodes || []).length, (d.aliases || []).length,
			(d.traffic || []).length], i;
		for (i = 0; i < (d.nodes || []).length; i++) {
			var nd = d.nodes[i], tr = nd.traffic || [];
			p.push((nd._meta || {}).fetched_at, (nd.clients || []).length,
				tr.length, tr.length ? tr[0].ts : 0);
		}
		return p.join('|');
	}

	function setBusy(b) {
		state.busy = b;
		var btn = $('btn-refresh');
		btn.disabled = b; btn.textContent = b ? '刷新中…' : '刷新';
	}

	function load(force) {
		if (state.busy || state.inflight) return;
		if (window.__OPSHARE_DATA__ && window.__OPSHARE_DATA__.nodes) {
			state.source = 'LuCI 内嵌';
			state.lastCheck = Date.now();
			render(window.__OPSHARE_DATA__);
			window.__OPSHARE_DATA__ = null;
			updateLastCheck();
			return;
		}
		if (force) setBusy(true);
		state.inflight = true;
		var urls = endpoints(!!force), i = 0;
		function next() {
			if (i >= urls.length) {
				setBusy(false); state.inflight = false;
				showError('无法读取共享数据。请从 LuCI 后台打开本页，或开启 public_data，并确认 opshare 同步服务正在运行。');
				return;
			}
			var url = urls[i++];
			getJSON(url, function (err, data) {
				if (!err && data && data.nodes) {
					state.source = url.split('?')[0];
					var s = signature(data);
					state.lastCheck = Date.now();
					if (s !== state.sig || !state.rendered) { state.sig = s; render(data); }
					else { state.data = data; tickDurations(); }
					updateLastCheck();
					setBusy(false); state.inflight = false;
				} else next();
			});
		}
		next();
	}

	function updateLastCheck() {
		if (!state.lastCheck) return;
		var d = new Date(state.lastCheck);
		function p(x) { return x < 10 ? '0' + x : '' + x; }
		$('last-check').textContent = '最后检查 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
	}

	// Tell the enclosing LuCI iframe to grow to the real content height.
	// Measure the .wrap block, never document.scrollHeight: the frame's own
	// height leaks into that number (body fills the viewport), so every message
	// made the frame taller, which made the next measurement taller - the page
	// ended in an ever-growing blank strip instead of hugging the last row.
	function contentHeight() {
		var w = document.querySelector('.wrap');
		if (!w) return Math.ceil(document.body.scrollHeight || 0);
		return Math.ceil(w.offsetTop + w.offsetHeight);
	}

	function notifyHeight() {
		if (window.parent === window) return;
		var h = contentHeight();
		if (!h || Math.abs(h - state.lastHeight) < 2) return;
		state.lastHeight = h;
		try { window.parent.postMessage({ opshareHeight: h }, location.origin); } catch (e) {}
	}

	function startEdit(el, key, kind) {
		if (!el || el.querySelector('input')) return;
		var old = el.textContent, inp = document.createElement('input');
		inp.className = 'inline-edit'; inp.value = old;
		el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
		var done = false;
		function finish(save) {
			if (done) return; done = true;
			var val = save ? inp.value.trim() : old;
			if (save && val) {
				if (kind === 'node') state.nodeNames[key] = val;
				else state.aliases[String(key).toLowerCase()] = val;
				lsSet(kind === 'node' ? LSK.names : LSK.aliases,
					kind === 'node' ? state.nodeNames : state.aliases);
			}
			if (state.data) { state.sig = ''; render(state.data); }
		}
		inp.onkeydown = function (e) {
			if (e.keyCode === 13) finish(true);
			else if (e.keyCode === 27) finish(false);
		};
		inp.onblur = function () { finish(true); };
	}

	// ---- events ----
	$('btn-refresh').addEventListener('click', function () { load(true); });
	$('sel-interval').addEventListener('change', function () {
		state.refreshMs = Number(this.value); lsSet(LSK.refresh, state.refreshMs);
		startTimer(); updateSourceLabel();
	});
	$('chk-realtime').addEventListener('change', function () {
		state.realtime = this.checked ? 1 : 0; lsSet(LSK.realtime, state.realtime);
		updateSourceLabel();
	});
	$('chk-offline-topo').addEventListener('change', function () {
		state.showOfflineTopo = this.checked ? 1 : 0;
		lsSet(LSK.offlineTopo, state.showOfflineTopo);
		if (state.data) { renderTopology(state.data); notifyHeight(); }
	});
	$('chk-offline-list').addEventListener('change', function () {
		state.showOfflineList = this.checked ? 1 : 0;
		lsSet(LSK.offlineList, state.showOfflineList);
		renderRows();
		notifyHeight();
	});
	$('btn-theme').addEventListener('click', function () {
		var cur = document.body.getAttribute('data-theme');
		var nxt = cur === 'dark' ? 'light' : (cur === 'light' ? 'dark' :
			(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
		document.body.setAttribute('data-theme', nxt);
	});
	$('f-search').addEventListener('input', function () {
		clearTimeout(state.searchTimer);
		state.searchTimer = setTimeout(renderRows, 120);
	});
	['f-node', 'f-band', 'f-type'].forEach(function (id) {
		$(id).addEventListener('change', renderRows);
	});
	$('nodes').addEventListener('click', function (e) {
		var t = e.target;
		if (t.getAttribute && t.getAttribute('data-edit-node')) {
			var k = t.getAttribute('data-edit-node');
			startEdit(this.querySelector('.nname[data-name="' + k + '"]'), k, 'node');
		}
	});
	$('nodes').addEventListener('change', function (e) {
		var t = e.target, a;
		if ((a = t.getAttribute && t.getAttribute('data-role-sec'))) {
			var val = t.value;
			if (val === '__custom__') {
				val = window.prompt('自定义角色名称（留空恢复中性「节点」）', '');
				if (val === null) { t.value = state.roleOverrides[a] || ''; return; }
			}
			val = String(val).trim().slice(0, 32);
			if (val) state.roleOverrides[a] = val;
			else delete state.roleOverrides[a];
			lsSet(LSK.roles, state.roleOverrides);
			if (state.data) { state.sig = ''; render(state.data); }
			// Persist to UCI so every node / browser sees the same label.
			// Local override above gives instant feedback even if this fails.
			getJSON('/cgi-bin/luci/admin/status/opshare/setrole?section=' +
				encodeURIComponent(a) + '&role=' + encodeURIComponent(val || 'auto') +
				'&_=' + Date.now(), function () {});
		} else if ((a = t.getAttribute && t.getAttribute('data-color'))) {
			state.nodeColors[a] = t.value;
			lsSet(LSK.colors, state.nodeColors);
			if (state.data) { state.sig = ''; render(state.data); }
		}
	});
	$('rows').addEventListener('click', function (e) {
		var t = e.target;
		if (t.getAttribute && t.getAttribute('data-edit-mac')) {
			var mac = t.getAttribute('data-edit-mac');
			var cell = t.parentNode.querySelector('.dev');
			startEdit(cell, mac, 'mac');
		}
	});
	// Locate without filtering: the table keeps whatever the user set, we only
	// scroll to the matching row and flash it. Clean, and nothing to undo.
	function flash(el) {
		if (!el) return;
		el.classList.remove('flash');
		void el.offsetWidth;
		el.classList.add('flash');
		setTimeout(function () { el.classList.remove('flash'); }, 2600);
	}
	function toast(msg) {
		var t = $('toast');
		if (!t) {
			t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
			document.body.appendChild(t);
		}
		t.textContent = msg;
		t.classList.add('on');
		clearTimeout(state.toastTimer);
		state.toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3200);
	}
	function locateRow(mac) {
		if (!mac) return;
		var tr = document.querySelector('#rows tr[data-mac="' + mac.replace(/"/g, '') + '"]');
		if (!tr) {
			toast('该设备在当前列表条件下未显示（已离线或与其它设备合并）');
			return;
		}
		tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
		flash(tr);
	}
	$('topology').addEventListener('click', function (e) {
		var t = e.target;
		if (!t || !t.closest) return;
		var g = t.closest('[data-mac]');
		if (g) { locateRow(g.getAttribute('data-mac')); return; }
		var c = t.closest('[data-nodekey]');
		if (c) {
			var key = c.getAttribute('data-nodekey');
			var card = null, all = document.querySelectorAll('#nodes .node');
			for (var i = 0; i < all.length; i++)
				if (all[i].getAttribute('data-nodekey') === key) card = all[i];
			if (card) {
				card.scrollIntoView({ behavior: 'smooth', block: 'center' });
				flash(card);
			}
		}
	});

	/* ---- fine-granularity channel ----------------------------------------
	 * The full payload (clients, radios, leases, ports) is heavy and changes
	 * slowly. Counters change every second, so they travel on their own ~1 KB
	 * channel and are spliced straight into the traffic panel. No full
	 * re-render, so scroll position, hover and filters are untouched.
	 * -------------------------------------------------------------------- */
	var live = { timer: null, ms: 2000, inflight: false, fails: 0, cad: null, t: 0 };

	function liveEndpoints() {
		var stamp = '_=' + Date.now();
		return [
			'/cgi-bin/luci/admin/status/opshare/live?' + stamp,
			'/cgi-bin/opshare?a=live&' + stamp
		];
	}

	// "ifname|kind|rx|tx|dr|dx|ts|pts|dt|state" -> traffic objects
	function liveRows(payload) {
		var map = {};
		(payload.nodes || []).forEach(function (nd) {
			var rows = [];
			(nd.t || []).forEach(function (line) {
				var a = String(line).split('|');
				if (a.length < 10) return;
				rows.push({
					ifname: a[0], kind: a[1],
					rx_total: +a[2], tx_total: +a[3],
					rx_delta: +a[4], tx_delta: +a[5],
					ts: +a[6], prev_ts: +a[7], dt: +a[8], state: a[9]
				});
			});
			if (rows.length) map[nd.s] = { rows: rows, age: n(nd.age) || 0 };
		});
		return map;
	}

	function applyLive(payload) {
		var map = liveRows(payload), nodes = (state.data && state.data.nodes) || [];
		var changed = false;
		nodes.forEach(function (nd) {
			var key = (nd._meta && nd._meta.section) || 'main';
			var m = map[key];
			if (!m) return;
			var sig = '';
			m.rows.forEach(function (r) {
				sig += r.ifname + '|' + r.rx_total + '|' + r.tx_total + '|' +
					r.rx_delta + '|' + r.tx_delta + '|' + r.state + ';';
			});
			nd._live_age = m.age;
			if (sig !== nd._live_sig) { nd._live_sig = sig; nd.traffic = m.rows; changed = true; }
		});
		live.cad = payload.cad || null;
		live.t = Date.now();
		if (changed) renderTraffic(state.data);
		updateCadence();
	}

	function updateCadence() {
		var c = live.cad;
		var el = $('traffic-hint');
		if (el) {
			if (!c) el.textContent = '接口累计总量 · 相邻快照增量';
			else el.innerHTML = '计数 <b>' + (c.t || '?') + 's</b> · 全量 <b>' + (c.f || '?') +
				's</b> · ' + (c.w ? '<span class="live-on">有人在看，已自动提速</span>'
					: '静默模式（打开页面即提速）');
		}
		updateSourceLabel();
	}

	function pollLive() {
		if (document.hidden || !state.data || live.inflight || !live.ms) return;
		live.inflight = true;
		var urls = liveEndpoints(), i = 0;
		(function next() {
			if (i >= urls.length) {
				live.inflight = false;
				// three misses in a row = this build has no live channel
				if (++live.fails >= 3) { live.ms = 0; stopLive(); updateCadence(); }
				return;
			}
			getJSON(urls[i++], function (err, data) {
				if (err || !data || !data.nodes) return next();
				live.inflight = false;
				live.fails = 0;
				applyLive(data);
			});
		})();
	}

	function stopLive() { if (live.timer) { clearInterval(live.timer); live.timer = null; } }
	function startLive() {
		stopLive();
		if (!live.ms) return;
		live.timer = setInterval(function () { pollLive(); }, live.ms);
	}

	function stopTimer() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
	function startTimer() {
		stopTimer();
		var ms = state.refreshMs || 10000;
		function tick() {
			if (!document.hidden) load(!!state.realtime);
			state.timer = setTimeout(tick, ms);
		}
		state.timer = setTimeout(tick, ms);
	}

	document.addEventListener('visibilitychange', function () {
		if (!document.hidden) {
			state.lastHeight = 0;
			load(false);
			startLive();          // resume the fine cadence, then catch up at once
			pollLive();
			notifyHeight();
		} else {
			stopLive();           // nobody is looking: stop asking for precision
		}
	});
	window.addEventListener('resize', function () { notifyHeight(); });
	// The measurement is absolute now, so a frame resize no longer needs to
	// reset it; but height can also change without a re-render (展开说明、
	// 字体回流), so watch the wrapper itself when the browser supports it.
	if (window.ResizeObserver) {
		try {
			new ResizeObserver(function () { notifyHeight(); })
				.observe(document.querySelector('.wrap'));
		} catch (e) {}
	}
	// <details> toggle does not bubble: capture it.
	document.addEventListener('toggle', function () { notifyHeight(); }, true);
	state.tickTimer = setInterval(tickDurations, 1000);

	load(false);
	if (!window.__OPSHARE_NO_AUTO__) { startTimer(); startLive(); }
})();
