#!/bin/sh
# opshare uninstaller. Configuration and the SSH key are kept so a later
# reinstall does not lose peers/credentials.
PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH
export PATH

/etc/init.d/opshare disable >/dev/null 2>&1
/etc/init.d/opshare stop >/dev/null 2>&1

for f in /usr/bin/opshare-collect /usr/bin/opshare-sync /usr/bin/opshare-recv \
	/usr/bin/opshare-gw /usr/bin/opshare-traffic /usr/bin/opshare-live \
	/usr/bin/opshare-peer /etc/init.d/opshare /www/cgi-bin/opshare \
	/usr/share/luci/menu.d/luci-app-opshare.json \
	/usr/share/ucode/luci/controller/opshare.uc \
	/usr/lib/lua/luci/controller/opshare.lua \
	/usr/libexec/rpcd/opshare \
	/usr/share/rpcd/acl.d/luci-app-opshare.json \
	/www/luci-static/resources/view/opshare/index.js; do
	rm -f "$f"
done
rm -rf /www/luci-static/resources/view/opshare \
	/usr/lib/lua/luci/view/opshare /www/opshare /tmp/opshare \
	/usr/share/opshare
/etc/init.d/rpcd reload >/dev/null 2>&1

if [ -f /etc/crontabs/root ]; then
	sed -i '/opshare-sync/d' /etc/crontabs/root 2>/dev/null
	/etc/init.d/cron restart >/dev/null 2>&1
fi
rm -f /tmp/luci-indexcache.* /tmp/luci-modulecache.* 2>/dev/null
echo "opshare removed. /etc/config/opshare and /etc/opshare/ were kept."
