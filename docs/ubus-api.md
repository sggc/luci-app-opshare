# opshare ubus 接口

给手机 App（OPAssistant 或其它说 ubus JSON-RPC 的客户端）用的只读接口。
契约随包发布：装了 `luci-app-opshare` 就有，不需要额外开关。

实现只有一个文件：`/usr/libexec/rpcd/opshare`（rpcd 的可执行插件协议），
ACL 在 `/usr/share/rpcd/acl.d/luci-app-opshare.json`。

---

## 1. 怎么调

### 在设备本地

```sh
ubus call opshare info
ubus call opshare all  | head -c 200
ubus call opshare live
```

ACL 只授了 `read.ubus`，所以 root shell 与已登录的 LuCI 会话都能读，写操作不存在。

### 走 HTTP（App 用的方式）

和 OPAssistant 现在的做法一致：`POST /ubus`，`params` 是
`[session, object, method, args]`。

```sh
# 1) 登录拿 session（uhttpd 登录接口，不是 ubus）
curl -s -c jar -d 'username=root&password=***' http://192.168.1.1/cgi-bin/luci

# 2) 调用
curl -s -b jar -H 'Content-Type: application/json' \
  -d '["00000000000000000000000000000000","opshare","info",{}]' \
  http://192.168.1.1/ubus
```

返回是标准的 ubus 信封，业务数据在 `result[1]`：

```json
{"jsonrpc":"2.0","id":1,"result":[0,{"schema":1,"api":1,"version":"1.0.0", ...}]}
```

注意 `result[0]` 是 ubus 状态码，`0` 才代表成功。插件本身从不报错——
文件缺失时返回空骨架，不是 `result[0] != 0`。

---

## 2. 三个方法

| 方法 | 内容 | 体积 | 单次耗时 | 建议轮询 |
|---|---|---|---|---|
| `info` | 十来个标量：版本、节点数、角色、间隔 | < 300 B | ~30 ms | 10–30 s，或界面打开时一次 |
| `live` | 每个节点的接口计数器行 | ~1 KB | ~5 ms | 1–2 s |
| `all` | 完整合并视图：节点、客户端、无线、租约、流量 | 5–20 KB | ~5 ms | 10–60 s |

`info` 贵一点是因为它现算：`all.json` 里没有「节点数」这种派生量，
要一次 awk 扫全文。`all` / `live` 就是 `cat` 一个已写好的文件，所以便宜。

**不要在 1 秒级轮询里拉 `all`。** 手机端只需要计数器动起来时用 `live`，
列表类数据用 `all` 慢刷；页面本身就是这么分的（`ui.live_ms` 给的是
守护进程实际的重建周期）。

---

## 3. `info`

```json
{"schema":1,"api":1,"version":"1.0.0","updated":1794017792,
 "nodes":2,"topology":"双 DHCP / 串联","master":"QWRT",
 "mode":"hub","power":2,"auto_peers":1,
 "intervals":{"refresh":30,"idle":60,"traffic":2,"live_ms":2000}}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | int | `info` 自身的结构版本，当前 `1` |
| `api` | int | 接口契约版本，当前 `1`。破坏性变更才 +1 |
| `version` | str | 包的版本，与 `opkg status` 一致；读不到时是 `"dev"` |
| `updated` | int | 合并快照的时间戳（epoch 秒）。`0` = 还没有数据 |
| `nodes` | int | 参与合并的节点数，含本机。`0` = 没配对 |
| `topology` | str | 中文短语，如 `"双 DHCP / 串联"`。可直接显示 |
| `master` | str | 提供合并结果的那台的名字 |
| `mode` | str | **聚合那台**的实际工作模式（`hub` / `pull` / `off` 等） |
| `power` | int | 节能档位 |
| `auto_peers` | int | 自动发现的邻居数 |
| `intervals.refresh` | int | 全量刷新周期（秒） |
| `intervals.idle` | int | 空闲时的刷新周期（秒） |
| `intervals.traffic` | int | 流量采样周期（秒） |
| `intervals.live_ms` | int | `live` 载荷的重建周期（毫秒） |

> **被动节点的语义**：`info` 描述的是**合并视图**，不是「你正在问的这台」。
> 在 AP 上问 `mode`，拿到的是 AC 的模式。这是有意的——App 想知道的通常是
> 「整个拓扑现在什么状态」，不是单机状态。单机信息在 `all.nodes[].node`。

---

## 4. `all`（`schema: 2`）

完整合并视图，网页 UI 消费的就是它（`/tmp/opshare/all.json` 原样返回）。

```json
{"schema":2,"updated":1794017792,"ui":{...},"aliases":[],
 "meta":{"topology":"...","master":"...","server_count":1,"role_rule":"...","externals":[]},
 "nodes":[{"_meta":{...},"schema":2,"node":{...},"radios":[],"clients":[],"leases":[],"traffic":[]}]}
```

### 顶层

| 字段 | 说明 |
|---|---|
| `schema` | `2`。老版本是 `1`，字段不同，按它分支 |
| `updated` | 合并时间（epoch 秒） |
| `ui` | 服务端的界面参数：`refresh_ms` `interval` `traffic_interval` `live_ms` `fast_interval` `fast_traffic` `show_offline` `realtime` `session_grace` `yield_sec` `power` `auto_pair` `auto_peers` `eff_mode` `live` |
| `aliases` | 用户自定义的显示名覆盖，`[{...}]` |
| `meta` | 拓扑摘要：`topology` `master` `server_count` `role_rule` `externals[]` |
| `nodes` | 节点数组，见下 |

`ui` 里的值是**建议**：App 可以用它决定自己的刷新节奏，也可以无视。
`realtime=1` 表示「每次刷新都强制合并一次」（服务端默认 10 秒内至多一次）。

### `nodes[]`

每个节点固定是 `{_meta, schema, node, radios, clients, leases, traffic}`。

`_meta`——合并器加的包装，不是设备自报：

| 字段 | 说明 |
|---|---|
| `name` | 节点名（用户可改） |
| `host` | 访问地址 |
| `online` | `1` / `0` |
| `fetched_at` | 这份数据取到的时刻（epoch 秒） |
| `stale` | `1` = 数据已过期（`fetched_at` 太老） |
| `self` | `1` = 就是你正在问的这台 |
| `role` | 角色，中文短语 |
| `color` | 拓扑图配色键 |
| `role_basis` | 角色判定的依据 |
| `section` | UCI 段名，稳定标识符。**用它做 key，不要用 `name`** |

`node`——设备自报：`id` `hostname` `model` `distribution` `version` `target`
`kernel` `role` `role_basis` `suggested_role` `role_source` `dhcp` `lan_ip`
`wan_ip` `lan_ipv6` `load` `uptime`（秒）`mem_total` `mem_free`（KB）
`session_grace` `time`（设备本地时间）。

`radios[]`：`ifname` `ssid` `band`（`2g`/`5g`/…）`htmode` `channel` `freq`（MHz）。

`clients[]`（无线与有线客户端）常用字段：

| 字段 | 说明 |
|---|---|
| `mac` | 小写，冒号分隔 |
| `ip` / `ipv6` | 可能为空串 |
| `hostname` | 可能为空串；来源见 `identity_source` |
| `ifname` / `ssid` / `band` | 无线客户端才有意义 |
| `type` | `wifi` / `wired` |
| `online` | `1` / `0` |
| `signal` / `signal_avg` / `noise` | dBm（负值） |
| `rx_rate` / `tx_rate` | **kbps**（`2401000` = 2.4 Gbps） |
| `rx_mhz` / `tx_mhz` | 频道带宽 MHz |
| `connected_time` | 连接时长（秒） |
| `session_start` / `session_gap` / `session_grace_used` | 会话连续性判定用的内部量 |
| `presence` | `wifi` 等，表示最后一次在哪儿见到它 |
| `source` | 数据来自哪个采集源，排障用 |

`leases[]`：`mac` `ip` `hostname`——DHCP 租约，可能比 `clients` 多。

`traffic[]`：`ifname` `kind`（`wan`/`lan`/…）`state` `rx_total` `tx_total`
（字节，累计）`rx_delta` `tx_delta`（字节/`dt`）`ts` `prev_ts` `dt`（秒）。

---

## 5. `live`（`schema: 1`）

只装会每秒变的东西：接口计数器。

```json
{"schema":1,"ts":1794017792,"cad":{"t":10,"f":30,"w":1,"l":2000},
 "nodes":[{"s":"main","age":0,"t":["lan1|wan|21250781883|4982358609|177905|74002|1794017792|1794017790|2|ok"]}]}
```

| 字段 | 说明 |
|---|---|
| `ts` | 载荷生成时刻 |
| `cad` | 采样节奏：`t` 全量、`f` 流量、`w` 看门狗、`l` live（毫秒） |
| `nodes[].s` | 节点 UCI 段名，与 `all.nodes[]._meta.section` 对得上——**用它把两边的行合并** |
| `nodes[].age` | 这份数据多久没更新了（秒）。`age > cad.t` 基本可以认为该节点掉了 |
| `nodes[].t` | 每个接口一行，`|` 分隔 |

每行 10 段，竖线分隔：

```
ifname | kind | rx_total | tx_total | rx_delta | tx_delta | ts | prev_ts | dt | state
```

`state` 取值：`ok`（正常）、`baseline`（刚起，还没有前值）、`reboot`
（计数器倒退 = 设备重启过）、`reset`（接口重建）、`wrap32`（32 位计数回绕）、
`clock`（时钟异常导致 dt 不可信）。**只有 `ok` 的 delta 能当速率用。**

---

## 6. 兼容性承诺

- `info.api` 与 `all.schema` 是给客户端分支用的。新增字段**不**动它俩，
  只有删字段、改字段含义、改类型才 +1。
- 客户端必须容忍未知字段（以后会加），也必须容忍空串和 `0`。
- 文件还没生成时返回空骨架，不会让 `ubus call` 失败：

  ```json
  {"schema":2,"updated":0,"ui":{},"aliases":[],"meta":{},"nodes":[]}
  {"schema":1,"ts":0,"nodes":[]}
  ```

  所以「`nodes` 为空数组」= 没配对或还没合并过，不是错误。
- 三个方法都**不接参数**，`list` 里声明的是 `{}`。多传参数会被 ubus 拒掉。
- 目前全部只读。写操作（改名字、踢客户端、强制合并）还没开；真开了会走
  独立的 `opshare` 对象并单独授 `write.ubus`，不会混在现在这三个里。

---

## 7. 排障

```sh
# 接口在不在
ubus list | grep opshare

# 换了插件之后要重新扫描（procd 异步生效，实测约 8 秒）
/etc/init.d/rpcd reload

# 数据有没有生成
ls -l /tmp/opshare/all.json /tmp/opshare/live.json

# ACL 是否包含
grep -A5 '"opshare"' /usr/share/rpcd/acl.d/luci-app-opshare.json
```

`ubus list | grep opshare` 空 = 插件没被 rpcd 认出来（多半是少了可执行位，
包里的 `verify-ipk.py` 会检查这个）。
