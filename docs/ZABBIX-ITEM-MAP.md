# Zabbix item map (NOC dashboards)

The two NOC dashboards (`noc-device-health`, `noc-wan-overview`) query the Zabbix datasource by **numeric item id** (query type 3). Item ids belong to one Zabbix database, so the ids captured on the LAB Zabbix mean
nothing on another server. This release therefore keeps, next to the dashboards, a **descriptor** for every item id used (`config/zabbix-item-descriptors.json`: host name + item key) and a tool that finds the same
host + key on your Zabbix and writes `{ "<lab id>": "<your id>" }`. `grafana-platform` applies the map when it deploys the dashboards (ids are rewritten in memory; the files in Git never change).

## Build the map (read-only against Zabbix)
1. In Zabbix create a **read-only** user and an API token for it (never an admin token).
2. On the Grafana server (or any host with Node.js ≥ 18 and the release):
   ```bash
   export ZABBIX_URL=https://zabbix.example.com/api_jsonrpc.php
   export ZABBIX_TOKEN_FILE=/root/zbx-readonly.token            # file mode 600; the token never goes on a command line
   export NODE_EXTRA_CA_CERTS=/root/zabbix-ca.pem               # only for a private CA
   node tools/zabbix-item-map.mjs --out /etc/grafana-platform/zabbix-item-map.json
   ```
   The tool calls only `apiinfo.version`, `host.get` and `item.get`. It never guesses: a host or key that is missing or ambiguous is listed and the exit code is 3 (the file is still written with everything that resolved).
3. Set `ZABBIX_ITEM_MAP_FILE=/etc/grafana-platform/zabbix-item-map.json` in the environment file and run `grafana-platform install`.

## Hosts and keys the LAB dashboards expect
The descriptors name the WAN-edge hosts (`SITE-A`, `SITE-B`, `STC`, `MOBILY`, …) and keys such as `icmpping` and `zabbix[host,snmp,available]`. Your Zabbix must have hosts with the **same technical host names**
and the same item keys, or you edit `config/zabbix-item-descriptors.json` (host names) before building the map. Seven descriptors are marked `"unresolved": true` — the LAB items behind the "UP" tiles had no history when
the repository was captured. Add the right production item ids for them by hand to the map file, e.g. `"51140": "98765"`.

## What `preflight` does with the map
* every item id referenced by the NOC dashboards must be mapped → otherwise **FAIL** (nothing is installed);
* `ALLOW_NOC_WITHOUT_ITEM_MAP=yes` deploys only the five NetFlow dashboards and reports the skipped NOC dashboards as **WARN** (the playlist keeps the dashboards that exist).

## Acceptance testing without a real Zabbix
`tests/rhel/mock-zabbix.py` is a TLS stand-in that answers only `apiinfo.version`, `user.login` and trivial lists, and `tests/rhel/setup-grafana-test.sh` generates a synthetic map of fake ids. They exist so the install, datasource
health and dashboard deployment can be tested on isolated machines with dummy credentials. They prove the mechanics; **they do not prove that the NOC panels show correct values** — that needs your production Zabbix.
