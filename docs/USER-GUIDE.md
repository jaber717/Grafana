# NOC user guide — selecting what you see, and the daily reports

For operators. No SQL, JSON or YAML is needed for any of this. Background and limits: [UNIVERSAL-SELECTION.md](UNIVERSAL-SELECTION.md).

## 1. The selector bar (every NOC dashboard)

| Selector | What to do |
|---|---|
| **Site** | `All`, or one / several sites (SITE-A, SITE-B, …). New sites appear by themselves |
| **Device type** | `All`, or Router / Switch / … |
| **Device** | `All` = every device of the chosen site and type. Pick one to look at it, several to compare |
| **Interface** (WAN, NetFlow) | the interfaces of the selected devices; equal names on different devices stay distinguishable (`device · interface`) |
| **Metric** (Device Health, WAN) | tick the metrics the explorer chart should show; metrics that are not monitored simply draw nothing |
| **Direction**, **Protocol**, **Source / Dest IP** (NetFlow) | narrow the traffic |
| **Time range** (top right) | applies to the charts; the status cards always describe *now* |

The **NOC dashboards** dropdown (next to the selectors) jumps to any other NOC dashboard **keeping your selection and the time range**. Opening a dashboard from a bookmark starts with the defaults (All).

## 2. Typical questions

**Is a device down?** Device Health → pick the site → look at the **State** column and the six cards.
* **UP** answered ping in the last 10 minutes · **DOWN** ping failing · **UNKNOWN** Zabbix reports availability as unknown ·
  **NO DATA** monitored but silent for 10 minutes — a collection problem, *not* the same as down · **NOT MONITORED** no ping / SNMP availability item at all.
* A device that is reachable but shows "—" for CPU / Memory has no such item in Zabbix; it is still **UP**.

**Compare the CPU of several routers?** Device Health → *Device*: tick the routers → *Metric*: CPU → *Metric explorer* draws one line per router.

**How busy is a WAN link?** WAN Overview → site and device → *Interface type* if you want only physical ports → *Bandwidth* chart (Direction chooses inbound / outbound) and the *Interface summary* (speed next to mean and peak). Lines are never added together.

**What does a router export?** NetFlow → *Exporters & Interfaces*: the **Exporter status** table has one row per device in scope — **ACTIVE** (flows in the last 5 minutes), **IDLE** (seen recently, quiet now), **NO DATA** (configured, no flow in 7 days). *NO DATA does not mean the router is down*: check Device Health. **NOT IN INVENTORY** = it exports flows but is not a Zabbix host.

**Is the NetFlow platform healthy?** NetFlow → *Platform Health*. Top row: ClickHouse (online, memory, disk, query time) — independent of traffic. *Flow collection* says RECEIVING FLOWS / IDLE / NO FLOW DATA. In a lab with no traffic you will see NO FLOW DATA in grey: nothing to report, not an outage.

## 3. Adding a device

1. In Zabbix create the host, link the SNMP / ICMP templates, add it to host groups `Site/<NAME>` and `Type/<NAME>`.
2. Nothing in Grafana. It appears in the selectors (the Zabbix plugin refreshes its inventory at most every hour).
3. If it exports NetFlow, configure the exporter in Akvorado with the same name as the Zabbix host. NetFlow shows it as NO DATA until the first flow arrives.

## 4. The daily reports

Three PDFs at 07:00 (Asia/Riyadh) for the previous day: **NetFlow**, **Interface traffic**, **Network Health**. Each page states the date, the period and the data coverage.

* **COMPLETE / PARTIAL / NO DATA** badge: PARTIAL = some intervals are missing (figures understate reality, the report says by how much); NO DATA = nothing was received — the report shows *no figures*, never zeros and never "all healthy".
* **DEMO** pages (yellow banner, diagonal watermark) are layout examples with synthetic data and are never produced by the daily job.

Operations (run on the report host, as the report user):

```bash
grafana-report generate --date 2026-10-11 --kind health --scope site-a-routers   # manual "Generate Report", nothing is sent
grafana-report test-delivery --email --to you@example.com                         # manual "Test Delivery" (marked [TEST], DEMO PDFs)
grafana-report deliver --date 2026-10-11                                          # send what was generated (duplicate-protected)
grafana-report status --date 2026-10-11                                           # what ran, what was delivered, attempts
grafana-report schedule show | set 07:30 | enable | disable                       # the daily timer (disabled until you enable it)
grafana-report scopes --resolve --scope site-a-routers                            # which devices a saved scope matches
```

Delivery is **off** until `EMAIL_ENABLED` / `TELEGRAM_ENABLED` are set and recipients are listed; every send is logged and a second run for the same day sends nothing.
