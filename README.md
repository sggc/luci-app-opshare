# luci-app-opshare

一台路由器看到的设备，另一台也能看到。把同一个局域网里几台 OpenWrt /
ImmortalWrt / QWRT 的客户端列表、无线信息、DHCP 租约和接口流量合并成一份视图，
在任意一台上打开就能看到全网。零配置配对，不需要额外的服务器、容器或云。

纯 shell + 静态网页，没有编译产物，`Architecture: all`——同一个 `.ipk`
在 aarch64、mipsel、arm、x86 上都装得上。

## 能做什么

- **零配置配对**：探测网关和 DHCP 租约找到彼此，走 HTTP 交换身份，AC / AP
  之间不需要手工填 IP
- **拓扑图**：谁串在谁后面、谁在发 DHCP，一眼看出来
- **客户端合并**：同一个客户端在多台上出现时合并成一行，信号、速率取最好的那份
- **接口流量**：WAN / LAN 计数器，1–2 秒粒度，独立通道，不拖慢主刷新
- **IPv6**：客户端的 v6 地址一起带过来
- **ubus 接口**：`opshare all / live / info`，给手机 App 用，见
  [docs/ubus-api.md](docs/ubus-api.md)

## 安装

### 直接装（24.10 及更新）

```sh
opkg install --force-reinstall \
  https://github.com/<owner>/luci-app-opshare/releases/latest/download/luci-app-opshare_1.0.0_all.ipk
```

装完打开 LuCI → 网络 → 多设备信息共享。第一次进页面会自己做一次配对。

### 21.02 / 22.03 等老版本

那些 opkg 读不了新容器格式，改用文件名以 `_legacy.ipk` 结尾的那个资产。
`opkg: Malformed package file` 就是这个原因。

### 当 feed 用（有 `opkg upgrade`）

```sh
echo "src/gz opshare https://github.com/<owner>/luci-app-opshare/releases/latest/download" \
  >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-opshare
```

feed 没有签名，需要在 `/etc/opkg.conf` 里加 `option check_signature 0`，
或者别用 feed、直接装文件。

### 从源码装（开发用）

```sh
sh install.sh root@192.168.1.1     # scp 到设备并重启服务
sh uninstall.sh root@192.168.1.1   # 反向
```

`install.sh` 只覆盖 `src/` 下的文件，不动 `/etc/config/opshare`，改完代码推一次
就能看到效果。

## ubus 接口

装了包就有，只读，三个方法：

```sh
ubus call opshare info     # 版本、节点数、角色、刷新间隔  <300 B
ubus call opshare live     # 接口计数器，~1 KB，1–2 秒轮询
ubus call opshare all      # 完整合并视图，5–20 KB，慢刷
```

字段含义、HTTP JSON-RPC 登录流程、兼容性承诺都在
**[docs/ubus-api.md](docs/ubus-api.md)**。

## 构建

不需要 OpenWrt SDK，标准库就够：

```sh
python packaging/build-ipk.py               # dist/luci-app-opshare_<ver>_all.ipk
python packaging/build-ipk.py --legacy-ar    # 额外产出 dist/legacy/ 下的老格式
python packaging/build-ipk.py --check        # 只校验输入，不打包
python packaging/verify-ipk.py               # 断言包真的能装
python packaging/make-index.py               # 生成 opkg feed 索引 Packages(.gz)
```

版本号从 `src/usr/share/opshare/version` 读；CI 上由 git tag 覆盖
（`v1.0.1` → `1.0.1`），并同时改写包内的版本文件，保证 UI 和 control 一致。

构建是可复现的：固定 `SOURCE_DATE_EPOCH`、`root:root`、条目排序，
同一份源码两次构建字节相同（CI 里有这项断言）。

### 两种容器格式

| 格式 | 谁用 | 产出 |
|---|---|---|
| `gzip(tar)` | OpenWrt ≥ 24.10（默认） | `dist/*.ipk` |
| `ar` | 19.07 / 21.02 / 22.03 | `dist/legacy/*_legacy.ipk` |

2024 年底 OpenWrt 把 `.ipk` 从 `ar` 归档换成了 `gzip(tar)`，22.03 的 opkg
读新格式会直接 `Malformed package file`。两种都出，一个包管所有版本。

## 测试

```sh
node _dev/uitest.js        # 把 app.js 跑在快照上，断言渲染与 iframe 高度
sh _dev/pairtest.sh        # 桩掉 uci/wget/ip，离线验证配对与合并决策
python packaging/verify-ipk.py
```

`_dev/snapshot.json` 是脱敏后的真实抓包（MAC / IP / 主机名 / SSID 全部替换），
所以 UI 测试跑的是真实数据形态。`_dev/sanitize.py` 生成它。

`_dev/deploy.py` 需要 `_dev/devconf.json`（两台真机的地址与密码，不入库），
用于推包到设备并跑回归。

## 发版

```sh
echo 1.0.1 > src/usr/share/opshare/version
git commit -am "1.0.1"
git tag v1.0.1
git push origin main --tags
```

CI 在 tag 上会：跑测试 → 出包 → 校验 → 生成 feed 索引 → 建 Release 挂资产。
分支上的 push 和 PR 只跑测试和出包，不发 Release。

## 目录

```
src/                       进包的东西（原样映射到设备根目录）
  usr/bin/opshare-*        采集、合并、配对、流量采样
  usr/libexec/rpcd/opshare ubus 接口（rpcd 插件）
  www/opshare/             页面本体（app.js / style.css / index.html）
  www/luci-static/...      挂进 LuCI 菜单的 view
  etc/config/opshare       默认配置（conffile，升级不覆盖）
packaging/                 构建、校验、feed 索引、维护脚本
docs/ubus-api.md           给 App 的接口契约
_dev/                      测试与开发脚本
.github/workflows/build.yml  CI：测试 → 出包 → Release
```

## 已知限制

- 无线详情（信号、速率）只能在真正带无线的节点上采；纯 AP 模式的硬路由
  可能采不到，页面上会标出来
- 合并结果由被判定为 DHCP 服务器的那台生成，其它节点把快照推过去。那台掉了，
  视图会停在最后一次成功合并的状态（`stale: 1`）
- 目前接口只读

## 许可证

未指定。发布前请自行选定并加上 `LICENSE`。
