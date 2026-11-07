// opshare - JSON data endpoint + role editor for modern (ucode) LuCI.
// The optional "sync=1" query parameter triggers one on-demand merge
// (throttled by /usr/bin/opshare-force-sync, see force_throttle in UCI).
//
// `http` is a global injected by the LuCI ucode runtime; do not import it.
'use strict';

import { readfile, writefile } from 'fs';
import { urldecode_params } from 'luci.http';

const DATA = '/tmp/opshare/all.json';
const LIVE = '/tmp/opshare/live.json';
const WANT = '/tmp/opshare/want';
const EMPTY = '{"schema":2,"updated":0,"nodes":[],"traffic":[],"aliases":[]}';
const EMPTY_LIVE = '{"schema":1,"ts":0,"nodes":[]}';
const CFG = '/etc/config/opshare';

// Any read is a consumer: while somebody has the page open the daemon keeps
// the fine-grained profile. The file body is the epoch of the last request, so
// nothing has to stat() anything.
function heartbeat() {
	try { writefile(WANT, '' + time()); } catch (_) {}
}

function reply(ok, extra) {
	http.prepare_content('application/json; charset=UTF-8');
	let body = '{"ok":' + (ok ? 'true' : 'false');
	if (!ok && extra) body += ',"error":"' + extra + '"';
	if (ok && extra) body += ',' + extra;
	http.write(body + '}');
}

function safe_section(sec) {
	if (!sec || !match(sec, /^[A-Za-z0-9_]+$/))
		return false;
	let cfg = readfile(CFG) ?? '';
	return index(cfg, "'" + sec + "'") >= 0 || sec == 'main';
}

function safe_role(role) {
	if (!role || length(role) < 1 || length(role) > 32)
		return false;
	let bad = [ "'", '"', '\\', '`', '$', ';', '|', '&', '\n', '\r',
		'<', '>', '(', ')', '{', '}', '*', '?' ];
	for (let ch in bad)
		if (index(role, ch) >= 0)
			return false;
	return true;
}

return {
	action_data: function() {
		heartbeat();
		if (index(getenv('QUERY_STRING') ?? '', 'sync=1') >= 0)
			system('/usr/bin/opshare-force-sync >/dev/null 2>&1');

		http.prepare_content('application/json; charset=UTF-8');
		http.write(readfile(DATA) || EMPTY);
	},

	// The fine-granularity channel: ~1 KB of counter rows, rebuilt by the
	// daemon every couple of seconds. The page polls this instead of the whole
	// snapshot, so a 2 s refresh costs a file read rather than a merge.
	action_live: function() {
		heartbeat();

		http.prepare_content('application/json; charset=UTF-8');
		http.write(readfile(LIVE) || EMPTY_LIVE);
	},

	// Roles are free labels. This writes `option role` for either this node
	// (section=main) or any configured peer section, via LuCI's authenticated
	// session. Auto-detection never decides the label on its own.
	action_setrole: function() {
		let p = urldecode_params(getenv('QUERY_STRING') ?? '');
		let sec = p.section ?? 'main';
		let role = p.role ?? '';

		if (!safe_section(sec))
			return reply(false, 'unknown section');
		if (!safe_role(role))
			return reply(false, 'invalid role');

		system("uci set opshare." + sec + ".role='" + role + "'; uci commit opshare");
		return reply(true, '"section":"' + sec + '","saved":true');
	}
};
