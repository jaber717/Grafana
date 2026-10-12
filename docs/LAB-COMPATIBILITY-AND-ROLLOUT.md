# LAB compatibility report, rollout, verification and rollback plan

Read-only discovery of the real LAB Zabbix (7.0.30, 2026-10-12) with `tools/lab-compat-check.mjs` and the dedicated identity `grafana-compat-ro` (API allowlist `hostgroup.get`, `host.get`, `item.get`; token kept outside Git). TLS was **verified** against the LAB's own self-signed certificate (SAN `zabbix-01.lab`, `192.168.1.91`), never disabled. **Nothing was changed** in Zabbix, in the running Grafana, in production or on any VM (VM 9221 stays powered off).

**Scope of this proof.** This is *inventory / query-compatibility* evidence from the real Zabbix. It is **not** a live Grafana rendering test: that needs the LAB Grafana (not touched) or the test VM (kept off). Do not read it as a full integration PASS.

## 1. Result

| Area | Result | Detail |
|---|---|---|
| Read-only account / API auth | **PASS** | 7 host groups, 14 hosts, 947 enabled items visible; token never printed or committed |
| Devices discovered / usable | 14 / 14 selectable | every enabled host is reachable through **Site = All**, **Device type = All** (see §2) |
| Availability items | PASS for 12 of 14 | 12 hosts have `ICMP ping` and/or `SNMP agent availability`; `ZABBIX-01` and `grafana-01` (agent-monitored) had **neither** → fixed: `Zabbix agent ping` now counts as availability; `LAB-SNMPSIM-HW-01` has only synthetic sensor items → NOT MONITORED (correct) |
| CPU / Memory (Cisco) | **PASS** | the 7 PNET routers: `#1: CPU utilization`, `Processor: Memory utilization`, `I/O: Memory utilization` — matched by `/CPU utilization/`, `/Memory utilization/` (a device with several memory items shows its busiest) |
| CPU / Memory (other vendors) | PASS | `DR-FW01`: `CPU utilization`, `Memory utilization`; Linux hosts: same names |
| **CPU / Memory (Huawei)** | **FAIL — items not present** | see §3 |
| Interface items | **PASS** | PNET routers carry the template items `Interface Gi0/0(<description>): Bits received / Bits sent / Speed / Operational status / errors / discards` that the dashboards and reports expect (SITE-A 6 interfaces, SITE-B 5, STC 3, MOBILY 3, INT-CORE 4, SAIX-A 3, SAIX-B 3). The same routers also have *custom* items `Interface Gi0/0: Bits received [netops.if.in[N]]` without a description: they are ignored on purpose (matching both would draw every interface twice) |
| Host groups `Site/…`, `Type/…` | **GAP (handled, §2)** | none exist: all PNET and DR hosts are in `Discovered hosts`, the others in `Linux servers`, `Zabbix servers`, `Virtual machines` |
| Visible vs technical host name | note | 12 hosts differ (`PNET-SITE-A` → **`SITE-A`**; `DR-FW01 (QDC-DR-00009)`). Dashboards, scopes and exporter matching use the **visible name** (`SITE-A`), which is what the earlier dashboards called the device |
| NetFlow exporter ↔ Zabbix | **NOT VERIFIED** | no exporter inventory is available to me (ClickHouse / LAB Grafana not accessed). Run the query in §4 and feed the result to `--exporters` |
| Grafana selector compatibility | **inventory-level PASS, live not tested** | see §2 |

## 2. Host groups and selectors — what happens with the real inventory

* The **Site** and **Device type** selectors list host groups named `Site/<NAME>` / `Type/<NAME>`. The LAB has none, so both selectors are empty and stay on **All**. The variable chain is built so that **All = every host regardless of groups** (`allValue .*`, no filter on group membership): **no device is excluded for lacking a group**. All 14 devices are selectable in **Device**.
* To get real Site / Type filtering **without touching templates or items**, add host groups in Zabbix (a one-time, additive, reversible change). Proposed mapping, for your approval:

| Hosts | Site/… | Type/… |
|---|---|---|
| SITE-A | Site/SITE-A | Type/Router |
| SITE-B | Site/SITE-B | Type/Router |
| STC, MOBILY, SAIX-A, SAIX-B | Site/PROVIDERS | Type/Router |
| INT-CORE | Site/CORE | Type/Router |
| DR-FW01 | Site/DR | Type/Firewall |
| DR-LB01 | Site/DR | Type/LoadBalancer |
| DR-LEAF01, DR-LEAF02 | Site/DR | Type/Switch |
| ZABBIX-01, grafana-01 | Site/LAB | Type/Server |
| LAB-SNMPSIM-HW-01 | Site/LAB | Type/Simulator |

  The prefixes are constants in `tools/monitoring/scope.mjs` (`SITE_PREFIX`, `TYPE_PREFIX`) if you prefer different names.
* **Changes made on the branch from this discovery:** agent-monitored hosts count as monitored (`Zabbix agent ping` is accepted next to `ICMP ping` in Device Health, the Health report and the metric selector); `tools/lab-compat-check.mjs` reads the credentials from an env file, verifies TLS against a CA file, supports `--dump` / `--include-disabled`, host tags / inventory and Huawei detection.

## 3. Huawei CPU / Memory

I looked at **every** item (enabled and disabled) of all 14 visible hosts, by name, key and type. **No Huawei CPU or Memory item is visible to this identity.**

* The 7 PNET routers are Cisco IOS items (`system.cpu.util[cpmCPUTotal5minRev.1]`, `vm.memory.util[vm.memory.util.N]`).
* `DR-LEAF01/02` and `DR-LB01` have availability and system items but **no CPU or Memory item at all**.
* `LAB-SNMPSIM-HW-01` is a synthetic hardware-sensor simulator (`FAN`, `PSU`, `Temperature`), not CPU / Memory.
* So either the custom Huawei items live on hosts or groups that were not visible when the token was provisioned (the access was limited to the seven host groups that existed then), or they are on a different Zabbix.

**Consequence today:** a Huawei device without items matching `CPU utilization` / `Memory utilization` shows **"—" / NOT MONITORED for those metrics, never an invented value**. I did **not** guess item names. Once the real names are known the fix is a one-line regex per metric (`CPU` / `MEM` in `tools/monitoring/device-health.mjs`, `ITEM` in `reports/lib/live.mjs`, the two targets in `reports/lib/dashboards.mjs`). **Needed from you:** the item names (or keys) of the working Huawei CPU / Memory items and the host they sit on, or extend `grafana-compat-ro` to the group that contains them and re-run `lab-compat-check.mjs` (it lists them under "possible CPU/memory items").

## 4. NetFlow exporter mapping

Akvorado's `ExporterName` must equal the Zabbix **visible** host name for a device to be matched. Run on ClickHouse (read-only) and save one name per line:

```sql
SELECT DISTINCT ExporterName FROM default.flows_1h0m0s WHERE TimeReceived > now() - INTERVAL 30 DAY AND ExporterAddress != toIPv6('::ffff:247.16.14.11') ORDER BY 1
```

Then `node tools/lab-compat-check.mjs --exporters exporters.txt` lists exporters matching a visible name, matching only a technical name (e.g. `PNET-SITE-A`), or matching nothing. Whatever does not match is shown as **NOT IN INVENTORY**, and the Zabbix device as **NO DATA** — selectable either way, never excluded.

## 5. LAB rollout plan (needs your approval; nothing below has been executed)

Pre-conditions: the branch head is merged / checked out on the workstation; read-only checks of §1 reviewed; Huawei items resolved or accepted as N/A.

1. **Backup (read-only, existing tooling):** `node scripts/backup.mjs` (dashboards, folders, datasource definitions) to a dated directory; note the current version of the seven dashboards (`docs/live-inventory.md`).
2. **Dry run:** `scripts/release-gate.sh`, `scripts/apply.sh --dry-run` — confirms UIDs, folder, datasource references and shows exactly what would change.
3. **Datasource:** the new built-in TestData datasource `noc-inventory` is created by `scripts/apply.mjs` from `config/datasources.json` (no network, no credential). The Zabbix and ClickHouse datasources are **not** modified.
4. **Apply** to the LAB Grafana in a quiet window: `scripts/apply.sh`. It overwrites the existing UIDs in place (`noc-device-health`, `noc-wan-overview`, the five `netflow-*`) and keeps previous versions in Grafana's version history. No Grafana restart is needed. The report dashboards (`NOC / Daily Reports`) are **not** applied (reports stay off).
5. **Verify (read-only, in the browser):**
   * Device Health: 14 devices in scope; SITE-A … SAIX-B show UP/CPU/Memory; `ZABBIX-01`/`grafana-01` UP (agent); `LAB-SNMPSIM-HW-01` NOT MONITORED; leaf switches UP with "—" for CPU/Memory.
   * Metric explorer: pick several routers, CPU → one line per router.
   * WAN Overview: Interface list shows the template interfaces once each; bandwidth and status draw.
   * NetFlow: Exporters dashboard lists the 14 devices (NO DATA while the LAB has no traffic — expected, *not* an outage); Platform Health shows NO FLOW DATA in grey.
   * "NOC dashboards" link keeps the selection and time range.
   * `node tools/panel-smoke.mjs` against the LAB Grafana (read-only queries).
6. **Success criteria:** every enabled device selectable; no panel error; no invented CPU / Memory; no outage shown for an idle NetFlow collector; original UIDs unchanged.

## 6. Rollback

* **Per dashboard (fastest, no tooling):** Grafana → dashboard → Settings → Versions → restore the version recorded in step 1 (UIDs and links stay the same).
* **Everything:** `node scripts/restore.mjs <backup dir>` re-applies the step-1 backup; `scripts/verify.sh` confirms no drift.
* **Datasource:** delete `noc-inventory` only if nothing references it (after the dashboards are rolled back); it is inert.
* Nothing in Zabbix or ClickHouse is changed by the rollout, so nothing needs rolling back there. If you adopt the host-group proposal of §2 the rollback is removing those groups.
