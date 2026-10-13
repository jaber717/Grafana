# LAB compatibility, onboarding design, acceptance and rollback

Read-only discovery of the real LAB Zabbix (7.0.30, 2026-10-12) with `tools/lab-compat-check.mjs` and the dedicated identity `grafana-compat-ro` (API allowlist `hostgroup.get`, `host.get`, `item.get`; token outside Git). TLS is **verified** against the LAB's own self-signed certificate (SAN `zabbix-01.lab`, `192.168.1.91`), never disabled. **Nothing was changed** in Zabbix, in the running Grafana, in production or on any VM (VM 9221 stays powered off).

**Scope of the evidence.** *Inventory / query compatibility* against the real Zabbix. It is **not** a live Grafana rendering test (the LAB Grafana is untouched, the test VM is off): do not read it as a full integration PASS.

## 1. Result

| Area | Result | Detail |
|---|---|---|
| Read-only account / API auth | PASS | 7 host groups, 14 hosts, 947 enabled items visible |
| Devices discovered / selectable | 14 / 14 | every enabled host is reachable through **Site = All / Device type = All** (§3) |
| Cisco CPU / Memory | **PASS** | the 7 PNET routers: `#1: CPU utilization`, `Processor: Memory utilization`, `I/O: Memory utilization` |
| Other vendors | PASS | `DR-FW01` and the Linux hosts: `CPU utilization`, `Memory utilization` |
| **Huawei CPU / Memory** | PASS (fixtures) / production NOT TESTED / LAB NOT APPLICABLE | Huawei devices exist only in production (§2); support is configuration-driven and tested with deterministic fixtures |
| Interface items | PASS | PNET routers carry the template items `Interface Gi0/0(<description>): Bits received / sent / Speed / Operational status / errors / discards` (SITE-A 6 interfaces, SITE-B 5, STC 3, MOBILY 3, INT-CORE 4, SAIX-A 3, SAIX-B 3). The extra custom items `Interface Gi0/0: Bits received [netops.if.in[N]]` (no description) are deliberately ignored — matching both would draw every interface twice |
| Availability items | PASS (12) / see §4 | ICMP + SNMP availability on the 7 routers and the 3 DR devices with them; `ZABBIX-01`, `grafana-01` have only the Zabbix agent (§4); the Huawei simulator has none → NOT MONITORED |
| Host groups `Site/…`, `Type/…` | GAP, handled | none exist (§3) |
| Visible vs technical names | note | 12 hosts differ (`PNET-SITE-A` → **`SITE-A`**, `DR-LEAF01 (QDC-DR-00003)` / `DR-LEAF01`); dashboards, scopes and exporter matching use the **visible name** |
| NetFlow exporter ↔ Zabbix | **NOT VERIFIED** | no authorised exporter inventory available to me (§5) |

## 2. Vendor-specific CPU / Memory (Huawei, Cisco, Fortinet, Linux …) without hard-coding a vendor

**Context (confirmed by you):** the Huawei devices and their custom items exist in **production**, not in the LAB inventory. Their absence from the LAB is expected. I did not access or request production access.

**Verdict.** Huawei compatibility: **PASS — synthetic / fixture testing.** Huawei real production validation: **NOT TESTED.** Huawei LAB live validation: **NOT APPLICABLE — no production Huawei devices in this LAB.**

**Design.** Item names are configuration, not code: **`config/monitoring-items.json`**, read by the dashboards, the daily reports and the compatibility checker (`reports/lib/item-patterns.mjs`).

```json
"cpu":    { "match": "contains", "names": ["Huawei: Custom CPU", "Huawei CPU utilization", "hwCpuDevDuty", "CPU utilization"] },
"memory": { "match": "contains", "names": ["Huawei - Custom Memory", "Huawei Memory utilization", "Processor: Memory utilization", "Memory utilization"] }
```

* **Precedence = list order.** For each device the **first name that matches one of its items wins**; later names are ignored for that device. Vendor-specific names come first, the generic one last, so a device with a Huawei item *and* a generic item shows only the Huawei one. Cisco IOS has two memory pools (`Processor:` ~8 % and `I/O:` ~84 % on the LAB routers): the Processor pool is listed before the generic name, so table and report agree; the explorer can draw both. (Found during LAB acceptance: with only the generic name the table picked an arbitrary pool.)
* **Mechanism.** *Device Health:* one query target per configured name (`CPU0 … CPUn`, `MEM0 … MEMn`), then a Grafana "first not null" over the columns in precedence order — the status table, KPI and attention list therefore see one value per device. *Daily report:* one query per name, the first name with data is used per device (`pickTier`), and the report dashboard's CPU / memory charts receive per-name host lists (`cpu_hosts_<n>`, `memory_hosts_<n>` dashboard variables), so a device is drawn from **one** item only. The Metric selector of Device Health still lists every configured name so you can look at a specific item.
* **Items are read by NAME, never by key.** Grafana's Zabbix item selector filters by name; the historical keys (`huawei.cpu.usage`, `huawei.cpu.util`, `huawei.memory.usage`) are documentation only. If a name differs in production, add it to the file (and, if you prefer, rename the item's visible *name* in Zabbix — never its key, OID or preprocessing).
* **No SNMP detail in Grafana.** No OID, walk, instance index or regex lives in the dashboards or reports (a test greps the generated dashboard for `2011` / `16777217`). Zabbix polls and preprocesses; Grafana consumes the processed **percentage** item.
* **Raw values are refused.** The loader rejects any configured name containing "raw" (e.g. `Huawei - Memory Raw`); tests prove a raw counter, free / used / total memory never match.
* **Missing = N/A.** A device without a matching item shows "—" / N/A in the table and "not monitored" in the report; nothing is estimated. Unsupported metrics are simply not displayed for a device.
* **Same dashboard for every vendor** (Cisco, Huawei, Fortinet, Palo Alto, Linux): Site → Device → CPU / Memory / Availability. Supporting Palo Alto or another vendor = adding the *name* of its processed CPU / memory item to the file and regenerating — no new dashboard.

**Fixtures (deterministic, synthetic).** `tests/fixtures/huawei.mjs` reproduces the historical results: CPU walk `…6.3.4.1.2.1.0.0 = 6`; memory walk with instance `…16777216 = 0` (wrong, never selected) and `…16777217 = 28` (selected by the production preprocessing regex; CLI ≈ 29 %), plus Cisco, Fortinet, a device with both vendor and generic items, and a device with only a raw counter. `tests/unit/huawei-compat.test.mjs` checks: the preprocessing yields 28 (not 0, not the index); the item precedence; the Device Health dashboard structure (targets per name in order, first-not-null, no OID); and the **Daily Network Health report** end to end through the report client: Huawei CPU 6 % / memory 28 %, vendor item wins over a generic one reading 0, one series per device (288 buckets, not merged), Cisco unchanged, raw-only device N/A, state UP without invented values.

**Not tested here (be explicit):** the Grafana "first not null" transformation and the multi-target Device Health query were verified structurally and with the report path, **not in a running Grafana** (the test VM is off): this is part of the LAB acceptance (§6, "Huawei fixture device" cannot be shown live in the LAB; the Cisco / Fortinet / Linux devices exercise the same code path).

## 3. Site and device-type classification (additive migration — requires your approval)

With no `Site/…` / `Type/…` groups the selectors are empty and stay on **All**; the selector chain treats All as every host regardless of groups, so **no device is excluded** for lacking a group (to be confirmed live). To get real filtering, add groups — an *additive* Zabbix change.

**Design.** `Site/<CODE>` = a **location** (branch, data centre, lab); a device is **not** a site because its name looks like one, and a device that belongs to no single location simply gets no `Site/` group (it stays under All). `Type/<Name>` = device type / role (`Router`, `Switch`, `Firewall`, `LoadBalancer`, `Server`, `Simulator`; CamelCase, singular). One `Site/` and one `Type/` per host normally. Future onboarding = create the host, add one `Site/` and one `Type/` group; `lab-compat-check.mjs` flags hosts missing either. Prefixes can be changed in `tools/monitoring/scope.mjs` (`SITE_PREFIX`, `TYPE_PREFIX`).

**Tooling (read-only).** `config/zabbix-group-mapping.example.yaml` holds a *proposal* in which **every entry is `confirm: true`** (my guess from names / items: e.g. the DR devices → `Site/DR`, provider routers STC / MOBILY / SAIX get **no** Site group because they are not a location of yours). `node tools/zabbix-group-plan.mjs --mapping <file> [--include-unconfirmed] [--out plan.json]` compares it with the real Zabbix and prints the exact plan; unconfirmed entries are refused unless previewed. Preview on the real LAB: 9 groups to create (`Site/DR`, `Site/SITE-A`, `Site/SITE-B`, `Type/Router`, `Type/Switch`, `Type/Firewall`, `Type/LoadBalancer`, `Type/Server`, `Type/Simulator`), 20 memberships to add, 0 problems.

**What the plan does and does not do.** Only `hostgroup.create` (new groups) and `hostgroup.massadd` (adds memberships; existing memberships are preserved by definition). It does not touch templates, items, SNMP settings, other groups or host data. It needs an identity allowed to write host groups — **not** the read-only compatibility account.

**Procedure after your approval**
1. You confirm / edit the mapping (remove `confirm`, change site codes, decide the provider routers).
2. Re-run the planner; review `plan.json` (apply / verify / rollback calls with real ids).
3. Snapshot: `host.get {selectHostGroups}` and `hostgroup.get {selectHosts: 'count'}` saved before the change.
4. Apply with a write-capable admin session: the `apply` calls of the plan, in order.
5. **Verify:** every planned host lists its new groups *and all previous groups* (diff against the snapshot: only additions); previous groups keep their host counts; `item.get` count per host unchanged; `lab-compat-check.mjs` shows no host-group gap; Grafana selectors list the new sites / types (after the plugin's metadata cache, ≤ 1 h).
6. **Rollback:** the plan's `hostgroup.massremove` (removes only the added memberships) then `hostgroup.delete` of the groups it created (they are empty by then). Nothing else needs undoing.

## 4. Device Health semantics — three different availability sources

| Source | Item | Means | Does not mean |
|---|---|---|---|
| **ICMP** | `ICMP ping` | the device answers ping | that SNMP, interfaces or services work |
| **SNMP** | `SNMP agent availability` | Zabbix can poll the SNMP agent | that ICMP / every interface is reachable |
| **Zabbix agent** | `Zabbix agent ping` | the Zabbix **agent on the host** answers | nothing about network interfaces or services |

* Decision order: **ICMP**, then **SNMP**, then **agent**. ICMP failing is **not** hidden by a healthy agent (DOWN, basis ICMP); SNMP *unknown* does not override a working agent.
* The device table shows the three sources as separate columns (**ICMP**, **SNMP**, **Zabbix agent**); the Health report adds a **Basis** column (ICMP / SNMP / Agent) to every state.
* An **agent-only** device (`ZABBIX-01`, `grafana-01`) can be UP or DOWN but has **no availability percentage or down time** (the agent item holds 1 or nothing, so downtime cannot be computed), and the report notes that the agent does not prove interface or service reachability.
* The availability timeline and the availability bar remain **ICMP-only**.
* The encoding (`SEEN 1000 + ICMP 200/100 + agent 20/10 + SNMP 1/2/3`) is generated for the dashboard from the same function the report uses; a unit test checks every combination.

## 5. NetFlow exporter mapping

I have no authorised read-only exporter inventory (no ClickHouse / Akvorado / LAB-Grafana access in this session) and I cannot message Codex from here: **please pass this request to Codex** (read-only, no traffic generated, nothing changed in Akvorado):

```sql
SELECT ExporterName, any(ExporterAddress) AS addr, max(TimeReceived) AS last_seen FROM default.flows_1h0m0s
WHERE TimeReceived > now() - INTERVAL 30 DAY AND ExporterAddress != toIPv6('::ffff:247.16.14.11') GROUP BY ExporterName ORDER BY 1
```
and, if available, the configured exporter names from Akvorado's inlet / outlet configuration. Save the names one per line and run `node tools/lab-compat-check.mjs --exporters exporters.txt`. The report lists exporters matching a **visible** name, matching only a **technical** name, or nothing (with a probable device).

**How to handle mismatches** (ExporterName must equal the Zabbix *visible* name):
1. *Preferred:* set the Akvorado exporter name to the Zabbix visible name — the dashboards need no change.
2. Where the visible name carries a suffix that the exporter does not (`DR-LEAF01 (QDC-DR-00003)` vs `DR-LEAF01`): rename the Zabbix **visible** name to the technical name (visible name only; no item or template touched).
3. An alias map in the NetFlow generator is possible but not implemented: it only makes sense if neither side can be renamed.

Until then an unmatched exporter shows as **NOT IN INVENTORY** and its Zabbix device as **NO DATA** (selectable, never excluded, never a failure).

## 6. Acceptance procedure for the LAB Grafana (nothing here has been executed)

**Pre-conditions (all required before approval):** §7 items satisfied; this branch checked out on a workstation that can reach the LAB Grafana and Zabbix.

1. **Read-only baseline:** `node tools/lab-compat-check.mjs` (+ `--exporters`) → record the output; `node scripts/verify.mjs` (drift of the current dashboards).
2. **Backup:** `node scripts/backup.mjs` (dashboards, folders, datasource definitions) into a dated directory; note the live versions of the seven dashboards (`docs/live-inventory.md`).
3. **Dry run:** `scripts/release-gate.sh`, `scripts/apply.sh --dry-run` — shows exactly which UIDs would be overwritten and which datasource would be added.
4. **Datasource:** `noc-inventory` (built-in TestData, inert, no credential) is added by `apply`; the Zabbix and ClickHouse datasources are not modified. Report dashboards and e-mail / Telegram stay **off**.
5. **Apply** in a quiet window (`scripts/apply.sh`): same UIDs overwritten in place, previous versions kept in Grafana's history, no restart.
6. **Real-device verification (read-only, in the browser, per device):**
   * Device Health with the real datasource: 14 devices in scope; the 7 routers UP with CPU and Memory; `DR-FW01` with CPU / Memory; DR leaf / LB UP with "—"; `ZABBIX-01` / `grafana-01` UP with basis agent; the simulator NOT MONITORED; no device missing.
   * Metric explorer with several routers → one line each; Huawei devices (once testable) show CPU and, if configured, Memory.
   * WAN: every router's interfaces listed **once**; bandwidth and status draw.
   * NetFlow: Exporters lists all configured devices; NO DATA / NOT IN INVENTORY as in §5; Platform Health shows grey NO FLOW DATA, not an outage; ClickHouse tiles unaffected by the selection.
   * Navigation dropdown keeps selection and time range; `node tools/panel-smoke.mjs` against the LAB Grafana.
7. **Acceptance criteria:** every enabled device selectable; no panel errors; no invented CPU / Memory; availability basis visible; no outage claimed for an idle NetFlow collector; original UIDs and links unchanged.

**Rollback.** Per dashboard: Grafana → Settings → Versions → restore the version noted in step 2. Everything: `node scripts/restore.mjs <backup dir>` then `scripts/verify.sh`. The `noc-inventory` datasource is deleted last, only when nothing references it. Zabbix / ClickHouse are not changed by the rollout, so nothing to undo there (the optional host-group migration has its own rollback, §3).

## 7. What is still required before the LAB deployment can be approved

1. **Your approval** to deploy to the LAB Grafana (and a quiet window).
2. **Authorised access for the live check:** the LAB Grafana (read access for verification, an editor/admin for `apply`), or approval to power on VM 9221 for a rehearsal.
3. **Exporter names** from Akvorado / ClickHouse (§5) to close the exporter mapping.
4. **Huawei:** nothing blocks LAB acceptance. For production later: confirm the final saved item **names** (`Huawei: Custom CPU` / `Huawei - Custom Memory` are the candidates configured) — edit `config/monitoring-items.json` if they differ.
5. **Host-group decision** (§3): confirm / correct the mapping and approve the additive change, or approve deployment with Site / Type left on All.
