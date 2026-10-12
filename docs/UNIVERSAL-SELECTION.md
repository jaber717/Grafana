# Universal selection, device health and monitoring scope

One set of selectors on every NOC dashboard, one definition of "device state", and a device that is added to Zabbix shows up everywhere without
touching a dashboard. This document is the architecture, the variable reference, the device-discovery and onboarding guide, the monitoring scope
and the honest list of limits. Reports and saved scopes: [DAILY-REPORTS.md](DAILY-REPORTS.md). How to click through it: [USER-GUIDE.md](USER-GUIDE.md).

## 1. Architecture

```
Zabbix (inventory + availability + CPU/memory + interface items)          Akvorado -> ClickHouse (flows)
      host groups  Site/<NAME>  Type/<NAME>                                 ExporterName = Zabbix host name
            │  read-only, through the Zabbix datasource plugin                      │
            ▼                                                                       ▼
   Grafana variables  site → device_group → site_hosts(hidden) → device → …    NetFlow SQL filters on the hidden `exporter` set
            │                                                                       │
            ├── NOC / Device Health   (state table, KPIs, timeline, metric explorer)│
            ├── NOC / WAN Overview    (interfaces, bandwidth, status, errors)       │
            └── NetFlow (5 dashboards)  ◄───────────────────────────────────────────┘
                  every dashboard carries the same variable NAMES; the "NOC dashboards" link keeps the selection and the time range
```

* **Zabbix is the inventory.** There is no sync job, no extra database and no new service. Grafana reads host groups and hosts through the Zabbix
  datasource plugin when a dashboard opens (the plugin caches that metadata, `cacheTTL`, default 1 h).
* **Dashboards are generated, not hand-edited.** `tools/monitoring/*` (Device Health, WAN) and `tools/netflow/generate.mjs` (NetFlow) produce the JSON;
  drift tests fail when the committed JSON and the generator disagree. The original v1.0.1 dashboards are the generators' *input*
  (`tools/monitoring/base/`), so their UIDs, queries, item ids and panels are preserved.
* **Nothing is duplicated per device.** One dashboard serves any number of devices; the selectors decide what it shows.
* **The built-in TestData datasource (`noc-inventory`)** is used only as a local row builder for the Device Health table (no network, no data).

## 2. Variable reference (same names everywhere)

| Variable | Label | Source | Meaning |
|---|---|---|---|
| `site` | Site | Zabbix host groups `Site/<NAME>` | Multi-select; **All** = every host, including hosts without a site group |
| `device_group` | Device type | Zabbix host groups `Type/<NAME>` | Router, Switch, … |
| `site_hosts` | *(hidden)* | hosts of the selected site(s) | lets the next variable intersect site **and** type correctly |
| `device` | Device | Zabbix hosts of the selected site / type | Multi-select, **All** = all of them. Names are Zabbix visible names |
| `interface` | Interface | Zabbix items `Interface <name>(<description>): Bits received` (WAN) / flows (NetFlow) | Value is the interface name; series are always labelled `device · interface` |
| `interface_type` | Interface type | name prefix list (Gi, Te, Po, Vl, …) | WAN: look at port-channels or VLANs separately so overlapping interfaces are never mixed |
| `direction` | Direction | Inbound / Outbound (WAN) · derived boundary direction (NetFlow) | |
| `metric` | Metric | custom list | Device Health: CPU, Memory, Availability. WAN: bandwidth, status, errors, discards |
| `exporter` | *(hidden)* | selected devices ∪ exporters seen in flows | the effective `ExporterName` set used by every NetFlow query |
| `scope`, `proto`, `src_ip`, `dst_ip` | | | NetFlow data scope (real / demo) and dashboard filters |

Preserving the selection: every NOC dashboard has the dropdown link **NOC dashboards** (all dashboards tagged `netops`) with `includeVars` and
`keepTime`, so site, device, interface, direction and the time range follow you from dashboard to dashboard. The selection lives in the URL; a
bookmark without variables opens with the defaults (All).

### What each dashboard offers

| Dashboard | Selectors | Panels driven by them |
|---|---|---|
| NOC — Device Health | site, device type, device, **metric** | 6 KPI cards, device status table, availability timeline, devices requiring attention, metric explorer. The original fixed router wall is kept (collapsed row, unchanged) |
| NOC — WAN Overview | site, device type, device, interface type, interface, direction, **metric** | KPI cards, bandwidth, interface summary, metric explorer. Original six link panels kept (collapsed row) |
| NetFlow overview / top talkers / ASN / exporters / platform health | scope, site, device type, device, interface, direction, protocol (+ source / destination IP) | every panel except the platform tiles of *Platform Health* |

Metric switching uses the simplest native mechanism: a variable inside the panel's item filter. Panels are **not** hidden or shown dynamically (Grafana
cannot do that without a plugin); the explorer panel simply redraws for the selected metrics.

## 3. Device state (Device Health, the daily Health report, one definition)

States come from monitoring data only — **never from NetFlow**:

| State | Meaning |
|---|---|
| **UP** | ICMP ping answered in the last 10 minutes (or, without a fresh ping, SNMP availability = available) |
| **DOWN** | ICMP ping failing in the last 10 minutes (or SNMP availability = unavailable when there is no fresh ping) |
| **UNKNOWN** | no fresh ping and Zabbix reports SNMP availability *unknown* |
| **NO DATA** | monitored (samples in the last 8 days) but nothing in the last 10 minutes — a stale collection, **not** "down" |
| **NOT MONITORED** | no availability sample at all in 8 days (no / disabled ICMP and SNMP-availability items) |

Implementation: `code = SEEN(1000) + PING(200 up / 100 down) + SNMP(1 unknown / 2 ok / 3 unavailable)`, then value mappings turn the code into the five
states. A device that is reachable but has **no CPU or memory item stays UP**; those cells show "—" (N/A). The same encoding is implemented in
`reports/lib/health-report.mjs` and a unit test proves both agree for every code. Lookback beyond 7 days is answered from Zabbix trends (cheap).

### NetFlow exporter states (they are not device states)

`Inventory`: **Configured** (a Zabbix host in the selection) or **NOT IN INVENTORY** (sends flows but is not a host; only shown when everything is
selected). `Status`: **ACTIVE** (flows in the last 5 min), **IDLE / NO RECENT FLOWS** (seen in 7 days, quiet now), **NO DATA** (configured, no flow in
7 days). A configured device that never sent a flow stays selectable and shows NO DATA — which says nothing about whether it is up (see Device Health).

### NetFlow Platform Health: three separate questions

* **Platform** — ClickHouse online, memory, disk, query health: independent of selection and of traffic.
* **Flow collection** — RECEIVING FLOWS / IDLE / NO FLOW DATA (grey, never red): nothing received is "nothing to report", not an outage. *Last real flow age* is
  empty ("No flows in 24 h") instead of the former 57-year artefact.
* **Exporters** — configured, observed (7 d), active, idle, no data, not in inventory.

## 4. Device discovery and onboarding

**Conventions the dashboards rely on (Zabbix side):**

1. Host groups `Site/<NAME>` (site) and `Type/<NAME>` (device type) on every host you want to see by site / type. Hosts without them still appear under **All**.
2. Availability: item **`ICMP ping`** and/or **`SNMP agent availability`** (the standard Zabbix names).
3. Load: processed **percentage** items whose names are listed in `config/monitoring-items.json` (default: Cisco / Fortinet / Linux `CPU utilization`, `Memory utilization`, and the Huawei custom items); the first configured name that matches a device wins, so a device never shows two CPU or memory values. See docs/LAB-COMPATIBILITY-AND-ROLLOUT.md §2.
4. Interfaces (WAN, interface report): `Interface <name>(<description>): Bits received` / `Bits sent` / `Speed` / `Operational status` / error and discard items.
5. NetFlow: Akvorado's `ExporterName` for a router equals the router's Zabbix host name.

**Onboarding a new device (no dashboard edit, no Grafana restart):**

| Where | Step |
|---|---|
| Zabbix | create the host, link the SNMP / ICMP templates, add it to `Site/<NAME>` and `Type/<NAME>` |
| Grafana | nothing. It appears in the selectors of every dashboard (within the Zabbix metadata cache, ≤ 1 h; open the dashboard again or restart nothing) |
| Akvorado | only if the device exports flows: configure its exporter / classification in Akvorado (not part of this repository's dashboards) |
| Reports | site / type scopes pick it up automatically; the **interface** report lists interfaces explicitly (`interfaces.yaml`, `grafana-report discover` proposes candidates with `include: false`) |

A new site or device type is just a new host group: it appears in the **Site** / **Device type** selector by itself.

## 5. Monitoring scope — what is and is not measured

Measured: reachability (ICMP, SNMP availability), CPU and memory utilisation, interface bandwidth, operational status, errors, discards (where the
Zabbix items exist), and NetFlow traffic. **Not** measured and never invented: interface utilisation % on the WAN dashboard (see limits), anything from a device
without the corresponding Zabbix item, anything for a day without data (reports say NO DATA, they never show zeros).

## 6. Limitations (honest list)

* **Last data** in the Device Health table is coarse: *within 10 min / older than 10 min / none in 8 days*; Grafana cannot reduce the sample time per device without a plugin.
* **WAN utilisation %** is not computed (it needs a per-interface division of two series, which Grafana can only do for a fixed, hand-built list). The summary table shows the
  interface **speed next to mean / peak traffic**; the *Interface* report calculates utilisation from the speeds in `interfaces.yaml`.
* **Interface type** filters by name prefix (Gi, Te, Po, Vl, …), not by Zabbix item tags.
* **Selection** travels in the URL through the dashboard link; it is not stored on the server. A bookmark opens with the defaults.
* **Inventory freshness**: the Zabbix plugin caches host groups / hosts / items for `cacheTTL` (1 h by default). Lower it in the datasource if you need new hosts sooner.
* The dropdown / table cells use Grafana value mappings; "reachable but no CPU/memory" is shown as "—" because Grafana cannot show a different empty text per column.
* Charts in the Health report are readable up to about 20 devices; the tables list all devices on as many pages as needed.
* Validated against Grafana 13.2.3 with the real Zabbix plugin 6.8.0 and ClickHouse plugin 4.22.0 on a **mock Zabbix** and a real ClickHouse. The production Zabbix 7 and the LAB were not touched; see [reports/VALIDATION.md](reports/VALIDATION.md).
