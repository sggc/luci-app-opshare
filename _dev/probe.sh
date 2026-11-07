#!/bin/sh
echo '=== IWINFO TEXT ==='
for d in $(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1); do
  echo "-- $d"
  iwinfo "$d" assoclist 2>/dev/null | head -24
done
echo '=== IWINFO UBUS ==='
for d in $(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1); do
  echo "-- $d"
  ubus call iwinfo assoclist "{\"device\":\"$d\"}" 2>/dev/null | head -c 2600
  echo
done
echo '=== HOSTAPD CLIENTS ==='
for o in $(ubus list 2>/dev/null | grep hostapd); do
  echo "-- $o"
  ubus call "$o" get_clients 2>/dev/null | head -c 1600
  echo
done
echo '=== NETDEV RAW ==='
cat /proc/net/dev
echo '=== SYSFS COUNTERS ==='
for i in $(ls /sys/class/net/); do
  r=$(cat "/sys/class/net/$i/statistics/rx_bytes" 2>/dev/null)
  t=$(cat "/sys/class/net/$i/statistics/tx_bytes" 2>/dev/null)
  printf '%s rx=%s tx=%s\n' "$i" "$r" "$t"
done
