# luci-app-opshare

一台路由器看到的设备，另一台也能看到。把局域网里几台 OpenWrt / ImmortalWrt /
QWRT 的客户端、无线信息、DHCP 租约和接口流量合并成一份视图，在任意一台上打开
就能看到全网。零配置配对，不需要额外的服务器。

纯 shell + 静态网页，无编译产物，`Architecture: all`——同一个 `.ipk` 通吃
aarch64、mipsel、arm、x86。

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

### 直接安装（24.10 及更新）

```sh
V=1.0.0   # 换成 Release 页上的版本号
opkg install --force-reinstall \
  https://github.com/sggc/luci-app-opshare/releases/download/v${V}/luci-app-opshare_${V}_all.ipk
```

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

无需 OpenWrt SDK，Python 标准库足够：

```sh
python packaging/build-ipk.py --legacy-ar   # 出包，含两种容器格式
python packaging/make-index.py              # 生成 feed 索引
python packaging/make-index.py dist/legacy
```

| 产物 | 适用 |
|---|---|
| `dist/luci-app-opshare_<ver>_all.ipk` | OpenWrt ≥ 24.10 |
| `dist/legacy/luci-app-opshare_<ver>_all_legacy.ipk` | 19.07 / 21.02 / 22.03 |

版本号取自 `src/usr/share/opshare/version`，其他参数见脚本头部。

## 测试

```sh
node _dev/uitest.js              # 前端渲染（无浏览器）
sh _dev/pairtest.sh              # 配对与合并逻辑（桩掉 uci/wget/ip）
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

## 已知限制

- 纯 AP 模式的硬路由可能采不到无线详情，页面会标注
- 合并结果由 DHCP 服务器那台生成；它掉线后视图停在最后一次快照（`stale: 1`）
- 接口目前只读

## 许可证

Apache-2.0 · Copyright 2026 sggc · 见 [LICENSE](LICENSE)
