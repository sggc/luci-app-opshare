-- opshare - LuCI integration for classic (Lua) LuCI (OpenWrt 19.07 / 21.02).
-- On ucode-based releases the menu.d entry + ucode controller take over.

module("luci.controller.opshare", package.seeall)

function index()
	local f = io.open("/usr/share/luci/menu.d/luci-app-opshare.json", "r")
	if f then f:close(); return end

	entry({"admin", "status", "opshare"}, template("opshare/index"), _("设备总览"), 65)
	entry({"admin", "status", "opshare", "data"}, call("action_data"), nil).leaf = true
	entry({"admin", "status", "opshare", "live"}, call("action_live"), nil).leaf = true
	entry({"admin", "status", "opshare", "setrole"}, call("action_setrole"), nil).leaf = true
end

function action_data()
	if luci.http.formvalue("sync") == "1" then
		luci.sys.call("/usr/bin/opshare-force-sync >/dev/null 2>&1")
	end

	local f = io.open("/tmp/opshare/all.json", "r")
	luci.http.prepare_content("application/json")
	if f then
		luci.http.write(f:read("*a"))
		f:close()
	else
		luci.http.write('{"schema":2,"updated":0,"nodes":[],"traffic":[],"aliases":[]}')
	end
end

-- Fine-granularity channel: ~1 KB of counter rows, rebuilt by the daemon every
-- couple of seconds. The page polls this instead of the whole snapshot.
function action_live()
	local f = io.open("/tmp/opshare/live.json", "r")
	luci.http.prepare_content("application/json")
	if f then
		luci.http.write(f:read("*a"))
		f:close()
	else
		luci.http.write('{"schema":1,"ts":0,"nodes":[]}')
	end
end

-- Roles are free labels; auto-detection only produces a suggestion.
function action_setrole()
	local sec = luci.http.formvalue("section") or "main"
	local role = luci.http.formvalue("role") or ""
	luci.http.prepare_content("application/json")

	if not sec:match("^[%w_]+$") then
		luci.http.write('{"ok":false,"error":"unknown section"}'); return
	end
	local f = io.open("/etc/config/opshare", "r")
	local cfg = f and f:read("*a") or ""
	if f then f:close() end
	if sec ~= "main" and not cfg:find("'" .. sec .. "'", 1, true) then
		luci.http.write('{"ok":false,"error":"unknown section"}'); return
	end
	if #role < 1 or #role > 32 or role:find("['\"\\`$;|&<>(){}%*?\r\n]") then
		luci.http.write('{"ok":false,"error":"invalid role"}'); return
	end

	luci.sys.call("uci set opshare." .. sec .. ".role='" .. role .. "' && uci commit opshare")
	luci.http.write('{"ok":true}')
end
