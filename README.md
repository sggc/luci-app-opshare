# luci-app-opshare

一台路由器看到的设备，另一台也能看到。把局域网里几台 OpenWrt / ImmortalWrt /
QWRT 的客户端、无线信息、DHCP 租约和接口流量合并成一份视图，在任意一台上打开
就能看到全网。零配置配对，不需要额外的服务器。

纯 shell + 静态网页，无编译产物，`Architecture: all`——同一个 `.ipk` 通吃
aarch64、mipsel、arm、x86。

## 零配置互联

两台设备装好插件即可互相发现并共享数据，**不需要改任何路由器设置**：不用开端口、不用加防火墙规则、不用配 SSH 密钥、不用手工填对端 IP。

原理是只走**出站**连接。下挂路由能访问上级网关，但上级通常连不回下级（WAN 默认 `input=REJECT`，双 NAT 更不可能）。所以下级每隔一个采集周期就把自己的快照 POST 给上级的 `a=exchange`，上级存下这份快照并把当前合并视图**在同一个响应里**带回来。一次单向请求完成双向交换，N 台设备同理。

配对本身也无需配置：`a=hello` 只在私网应答，自动交换 id / token / CPU 档位 / 角色，CPU 强的一台当聚合者。约半分钟内所有节点收敛到同一份视图。旧版本没有 `a=exchange` 时会回退到原来的 GET 拉取，不影响升级。

## 功能

- 零配置配对：自动发现同网段的其他路由器
- 拓扑图：级联关系、DHCP 角色、上级物理口
- 客户端合并：同一设备在多台出现时合并成一行
- 无线详情：信号、速率、频段、连接时长
- 接口流量：WAN / LAN 计数器，1–2 秒粒度
- IPv6 地址一并展示
- ubus 只读接口，可对接手机 App

## 安装

装完打开 LuCI → 网络 → 多设备信息共享，首次进入会自动配对。

### opkg（OpenWrt ≤ 24.10）

```sh
V=1.0.0   # 换成 Release 页上的版本号
opkg install --force-reinstall \
  https://github.com/sggc/luci-app-opshare/releases/download/v${V}/luci-app-opshare_${V}_all.ipk
```

### apk（OpenWrt 25.12 及更新）

```sh
V=1.0.0   # 换成 Release 页上的版本号
wget -O /tmp/opshare.apk \
  https://github.com/sggc/luci-app-opshare/releases/download/v${V}/luci-app-opshare-${V}-r1.apk
apk add --allow-untrusted /tmp/opshare.apk
```

25.12 起改用 apk-tools 3，包是 APK v3（ADB 二进制容器），**不认 `.ipk`，
也不认旧版 apk v2**。资产未签名，故需 `--allow-untrusted`。

### 老版本固件（19.07 / 21.02 / 22.03）

```sh
V=1.0.0   # 换成 Release 页上的版本号
opkg install --force-reinstall \
  https://github.com/sggc/luci-app-opshare/releases/download/v${V}/luci-app-opshare_${V}_all_legacy.ipk
```

### 作为 opkg feed（支持 `opkg upgrade`）

```sh
echo "src/gz opshare https://github.com/sggc/luci-app-opshare/releases/latest/download" \
  >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-opshare
```

feed 未签名，需在 `/etc/opkg.conf` 中设置 `option check_signature 0`。

### 从源码安装

`install.sh` 在设备上执行，先拷整个工程目录过去：

```sh
scp -r . root@192.168.1.1:/tmp/opshare-src
ssh root@192.168.1.1 'sh /tmp/opshare-src/install.sh'
# 卸载（保留配置与 SSH key）
ssh root@192.168.1.1 'sh /tmp/opshare-src/uninstall.sh'
```

## ubus 接口

```sh
ubus call opshare info     # 版本、节点数、角色、刷新间隔
ubus call opshare live     # 接口计数器（1–2 秒轮询）
ubus call opshare all      # 完整合并视图（慢刷）
```

字段定义、HTTP JSON-RPC 调用方式与兼容性承诺见
**[docs/ubus-api.md](docs/ubus-api.md)**。

## 构建

`.ipk` 只需 Python 标准库；`.apk` 需要 apk-tools 3.x（CI 里跑在 Alpine 容器中）：

```sh
python packaging/build-ipk.py --legacy-ar   # 两种 ipk 容器格式
python packaging/make-index.py              # opkg feed 索引
python packaging/make-index.py dist/legacy
sh packaging/build-apk.sh                  # APK v3，需 apk mkpkg
```

| 产物 | 适用 |
|---|---|
| `dist/luci-app-opshare-<ver>-r1.apk` | OpenWrt 25.12+（apk） |
| `dist/luci-app-opshare_<ver>_all.ipk` | 24.10（opkg，新容器） |
| `dist/legacy/luci-app-opshare_<ver>_all_legacy.ipk` | 19.07 / 21.02 / 22.03 |

三种都是 `all` / `noarch`，同一个文件通吃所有 CPU 架构。版本号取自
`src/usr/share/opshare/version`；`APK_BIN` 可指向静态 `apk` 二进制。

## 测试

```sh
node _dev/uitest.js              # 前端渲染（无浏览器）
sh _dev/pairtest.sh              # 配对与合并逻辑（桩掉 uci/wget/ip）
sh _dev/ifacetest.sh             # 接口枚举（桩掉 sysfs/procfs）
sh _dev/exchangetest.sh          # 零配置配对协议（桩掉 CGI 环境）
python _dev/check-contract.py    # 数据字段与接口文档对账
python packaging/verify-ipk.py
```

`_dev/snapshot.json` 是脱敏后的真实抓包；`_dev/deploy.py` 用于推包到实验机并跑
真机回归，凭据放在 git-ignored 的 `_dev/devconf.json`。

## 发版

```sh
echo 1.0.1 > src/usr/share/opshare/version
git commit -am "1.0.1"
git tag v1.0.1
git push origin main --tags
```

tag 会触发 CI 构建并创建 Release；分支 push 与 PR 只跑测试和出包。

## 目录

```
src/                        进包的文件，原样映射到设备根目录
  usr/bin/                  采集、合并、配对、流量采样
  usr/libexec/rpcd/opshare  ubus 接口
  www/opshare/              页面
  etc/config/opshare        默认配置（升级不覆盖）
packaging/                  构建、校验、feed 索引、维护脚本
docs/                       接口契约
_dev/                       测试与开发脚本
```

## 资源占用

实测环境：FiberHome HG5585F，四核 ARMv8，双机级联（一台聚合、一台被动），
没人打开页面时的稳态：

| 角色 | 60 秒内 CPU | 占单核 | 占整机（4 核） |
|---|---|---|---|
| 聚合端 | 2.9 秒 | 4.9% | 1.2% |
| 被动端 | 1.8 秒 | 3.1% | 0.8% |

一次全量采集约 0.7 秒 CPU，默认每 30 秒一次；打开页面后升到 12 秒一次，
关掉页面 45 秒后自动降回。

**不磨损闪存**：运行时所有状态都在 `/tmp/opshare`（tmpfs，内存，约 110 KB），
只有安装、升级、改 `role` 才写 flash。实测 130 秒内 `/etc` 零写入，
UBI 最大擦除计数全程保持 6。日志走 `logger`，落在内存。

想再省可以设 `option power_profile 'low'`：静默期拉长到 45 秒、无人看时
完全不采样计数器，代价是页面数据刷新变慢。

## 已知限制

- 纯 AP 模式的硬路由可能采不到无线详情，页面会标注
- 合并结果由 DHCP 服务器那台生成；它掉线后视图停在最后一次快照（`stale: 1`）
- 接口目前只读

## 许可证

Apache-2.0 · Copyright 2026 sggc · 见 [LICENSE](LICENSE)
