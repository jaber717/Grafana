# LAB acceptance report — 2026-10-13

Target: Grafana LAB `192.168.1.194:3000` (OSS 13.2.3), real Zabbix LAB datasource `zabbix-lab` (7.0.30), real ClickHouse `netflow-clickhouse`. Branch `feature/daily-reports`, deployed from SHA `b10a3e3` plus the two acceptance fixes listed in §6 (committed with this report). No production, Zabbix, Akvorado/ClickHouse, router or Grafana-server change; no Grafana restart; report delivery untouched; VM 9221 off.

## Verdicts

| Item | Result |
|---|---|
| Deployment | **PASS** — 1 datasource created (`noc-inventory`, TestData), 7 dashboards updated in place, 0 refused |
| Backup | **VERIFIED** — `C:\Users\jaber\Documents\Home-Server\claude-noc-work\lab-backups\grafana-20261013T004146Z` (18 files, SHA-256 manifest checked, restore dry-run = 0 differences; outside Git, contains no secrets) |
| Dry run | **PASS** — 1 create, 7 update, 0 delete, Zabbix / ClickHouse datasources and folders unchanged, playlist unchanged, no restart needed |
| Device Health | **PASS with a data/permission caveat** (11 of 14 hosts visible, §2) |
| WAN Overview | **PASS (selectors, structure); data NOT VERIFIABLE live** — the LAB router interface items have never collected a value (§3) |
| Five NetFlow dashboards | **PASS** |
| Device selection | **PASS** |
| Metric selection | **PASS** (CPU/Memory/Availability; first-not-null verified live) |
| Cross-dashboard navigation | **PASS** — links carry `var-device` and the time range to all six other dashboards |
| Existing monitoring preserved | **YES** — all 7 UIDs, folders and the playlist unchanged; `verify.mjs` PASS; the original Device Health (10/10) and WAN (6/6) panels are identical to the backup |
| Rollback | **NOT REQUIRED** |
| Final LAB acceptance | **GO** (conditions in §7) |

## 1. Pre-deployment
Grafana identified (13.2.3, commit 90ffed05…), seven operational dashboards found with the expected UIDs / folders (`noc`: device-health, wan-overview; `netflow`: overview, top-talkers, asn, exporters, health), datasources `zabbix-lab` and `netflow-clickhouse` only. Authorisation: the Grafana admin login documented for this purpose in the secure handoff file (used in-process, never printed); the browser review used the read-only `grafana-noc` Viewer through a loopback proxy.

## 2. Device Health (real Zabbix data)
* **Selector: 11 devices, not 14.** The datasource account `grafana-ro` only sees host group `Discovered hosts` (11 hosts: 7 PNET routers, 4 DR devices). `ZABBIX-01`, `grafana-01` and `LAB-SNMPSIM-HW-01` (other groups) are **invisible to the datasource**, so no dashboard can list them. This is a Zabbix permission of `grafana-ro` (not changed: out of scope). All 11 visible devices are selectable with Site = All / Device type = All although no `Site/`, `Type/` groups exist.
* **States verified against the Zabbix API:** every visible ICMP item currently returns 0 → 10 devices **DOWN** (ICMP failing, SNMP availability UNKNOWN); `DR-LB01` has only SNMP availability (unknown) → **UNKNOWN**. Dashboard = Zabbix. NO DATA / NOT MONITORED: 0 in this LAB.
* **CPU:** no CPU item has ever collected a value on the visible devices → "—" (the Zabbix default `0` is **not** shown). **Memory:** the PNET routers show **8 %** = `Processor: Memory utilization` (Zabbix 8.0–8.5 %); devices whose memory item never collected show "—".
* **First-not-null verified live:** one Memory value per device with four CPU / four memory name tiers queried; no duplicate series in the table. *Found and fixed here:* Cisco routers have two memory pools (Processor ≈ 8 %, I/O ≈ 84 %); with only the generic name the table could pick either. The Processor pool now precedes the generic name (`config/monitoring-items.json`); the explorer still draws both.
* ICMP / SNMP / Zabbix agent are separate columns and a failing ICMP is not hidden by agent state — the logic is covered by tests; **live demonstration is not possible** because the only agent-monitored hosts are the 2 invisible ones and no visible host has both ICMP and agent. Multi-selection and comparison (2–4 routers) work (screenshot 03).
* **Huawei:** fixture-tested only (PASS synthetic); production NOT TESTED; LAB NOT APPLICABLE.

## 3. WAN Overview
Device and interface selectors work: for `SITE-A` the Interface list shows the 6 template interfaces once each (`Gi0/0(TO-SAIX-A-Gi0/1)` …; the 4 custom un-described duplicates are not listed), associated with the right host. **No bandwidth / status / error data can be shown:** every `Bits received/sent`, status and error item of the 7 routers has `lastclock = never` in Zabbix (the devices are unreachable), so panels correctly say NO DATA and KPIs show "—" (never zeros); no aggregate totals exist. Bandwidth rendering, multi-interface comparison and the no-double-counting design were verified only on the disposable test Grafana (docs/screenshots).

## 4. NetFlow (no current traffic — expected, not an incident)
Exporters: 11 configured, **SITE-A and SITE-B IDLE (last flow 5 days ago, historical)**, 9 **NO DATA**, 0 NOT IN INVENTORY (their names match the Zabbix visible names). Platform Health: collector **IDLE / NO FLOW DATA (grey)**, ClickHouse **ONLINE**, memory 1.0 GiB, disk 1.4 %, query p95 44 ms, *Last real flow age* "No flows in 24 h" — the 57-year value and any FLOWING / ACTIVE claim are gone. Device selection narrows the exporter table (screenshot 08: SITE-A only). Top Talkers / ASN show designed empty states (raw flow tables are limited to 24 h and hold nothing recent).

## 5. Performance
Server-side (real datasource, 11 devices): Device Health queries 261–537 ms, explorer 408 ms; WAN queries 99–187 ms; **0 query failures**. Headless page render 3–6 s per dashboard. The in-app browser pane was slow and its screenshots timed out several times (pane limitation); there it also showed a **transient NO DATA state for a few seconds on first load** before the data arrived — not reproduced in headless renders, final states always correct (see §7). No infrastructure change was made.

## 6. Changes made during acceptance (committed)
1. Cisco memory precedence (above).
2. NetFlow: *Last real flow age* no-data text is grey (was green); exporter column widened for long visible names.
3. Evidence tooling kept out of Git (credentials only in process memory).

## 7. Remaining issues / conditions
1. **3 of 14 hosts invisible to Grafana** — needs a Zabbix permission decision for `grafana-ro` (read access to the other host groups). Not done (out of scope).
2. **LAB has no data on routers' interfaces / CPU and ICMP is down** — LAB state, not a dashboard defect; WAN and CPU live validation needs the devices reachable.
3. **Transient first-load NO DATA** (a few seconds) observed in the in-app pane: the status table reads three helper tables in a collapsed row. Noncritical; follow-up: show a "loading" cue or move the helpers out of the collapsed row.
4. Host-group migration, Huawei production check and exporter alias questions remain as documented in LAB-COMPATIBILITY-AND-ROLLOUT.md.

Evidence: screenshots in this folder (real LAB, dark theme).
