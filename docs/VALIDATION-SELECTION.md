# Universal selection, device health and report C — validation, limits and GO / NO-GO

Branch `feature/daily-reports` (from release v1.0.1, untouched; no production release is made by this branch). Everything was validated on **one existing isolated RHEL 9.6 test VM** (SELinux enforcing; no new VM was created) with a **disposable Grafana 13.2.3** container, the real **Zabbix datasource plugin 6.8.0** and **ClickHouse plugin 4.22.0**, a real ClickHouse 26.8 with the Akvorado schema, a **mock Zabbix** (dummy credentials) and mock SMTP / Telegram. The LAB, the production services, routers, firewalls and exporter configurations were **not touched**; no real credential or recipient was used; the LAB has no traffic, as expected — traffic-bearing checks use clearly synthetic rows in the *disposable* ClickHouse (`tests/rhel/seed-live-flows.mjs`, removable with `--clean`).

Companion documents: [UNIVERSAL-SELECTION.md](UNIVERSAL-SELECTION.md) (architecture, variables, discovery, limits), [USER-GUIDE.md](USER-GUIDE.md), [DAILY-REPORTS.md](DAILY-REPORTS.md), [reports/VALIDATION.md](reports/VALIDATION.md) (the earlier two-report validation), real-dashboard screenshots in [screenshots/](screenshots/).

## 1. Acceptance workflows

The mock Zabbix holds 14 hosts chosen to be awkward on purpose: normal routers, a router that is DOWN, a host that stopped reporting 3 h ago (stale), a ping-only switch (no CPU / memory), a host with only SNMP availability *unknown*, a host whose availability items are disabled, and routers with and without the full interface item set.

| Workflow | What was done in the real Grafana UI | Result |
|---|---|---|
| **Device Health: site → router → CPU + Memory → compare routers → availability → missing metrics** | URL / selector `Site = SITE-A`: 4 devices (3 UP, 1 UNKNOWN). Device: pick routers; Metric: CPU, Memory; the explorer draws one line per router. Availability timeline per device. `SITE-A-SW1` has no CPU / memory items | KPI cards, status table and timeline follow the selectors; **`SITE-A-SW1` is UP with "—" for CPU / Memory, never DOWN**; all five states visible at once for All (UP 10, DOWN 1, UNKNOWN 1, NO DATA 1, NOT MONITORED 1 of 14) |
| **Interface: site + device → WAN interface → in/out → compare → change metrics** | WAN Overview: Site, Device, Interface type, Interface, Direction; Metric changed from Operational status to bandwidth / errors / discards without any editing | KPI cards (interfaces, oper UP / DOWN, peaks, error counters), bandwidth, summary with capacity, explorer; **series are never summed** (device · interface labels) |
| **NetFlow: SITE-A → exporter → its traffic only → its interfaces → Top Talkers; a never-sent device shows NO DATA** | Synthetic current flows for `SITE-A` (active) and `SITE-B` (idle) in the disposable ClickHouse. Selecting `SITE-A` on Top Talkers | Only SITE-A's addresses / flows (40 records) are shown; Exporters dashboard: SITE-A **ACTIVE**, SITE-B **IDLE**, the other 12 configured devices **NO DATA** (their availability is on Device Health), two exporters not in Zabbix flagged **NOT IN INVENTORY**; a device added to Zabbix at run time appeared in the selectors and as NO DATA with no dashboard edit |
| **Cross-dashboard navigation** | `NOC dashboards` dropdown | Every link carries `var-site`, `var-device_group`, `var-device`, `var-interface`, … and the time range (checked on the rendered links) |
| **Misleading NetFlow Health indicators** | LAB-like empty state and the traffic state above | *Last real flow age*: "No flows in 24 h" (was ≈ 57 years); exporters: "0 active · N configured" (was `0/0`); collector: NO FLOW DATA grey, RECEIVING FLOWS green, never "FLOWING" without flows, never red for silence; ClickHouse memory / disk / query tiles unchanged by the selection |
| **Reports** | `grafana-report generate` on the VM (real Grafana, real plugin, real renderer, PDF by Chromium under Podman) for the three reports; scoped runs; DEMO and NO DATA examples; mock SMTP / Telegram end-to-end | see §3 |

## 2. Automated checks

| Check | Result |
|---|---|
| Unit + integration tests (`node --test tests/unit/*.test.mjs`) | **130 / 130 pass on Windows / Node 22** (incl. 8 end-to-end runs with real Chromium) and **130 / 130 on RHEL 9.6 / Node 20.20.2** (Chromium from the pinned image under rootless Podman, `tests/rhel/run-unit-suite.sh`, 49 s) |
| New tests | dashboard generators vs committed JSON (drift), original uid / panels / queries preserved, standard variable names, five distinct device states, state-code equivalence between the dashboard mappings and the report model for every code, scopes (parsing, refusal of unsafe names, AND semantics, interface filtering, onboarding), health model (every state, ping-only device, SNMP unknown, scope metrics, no-data day, empty scope), report pages (3 / 2 / continuation), NetFlow scope placeholder, unsafe host names skipped, 3 new end-to-end tests with real Chromium (health, scope, three-report delivery) |
| Release gate (`scripts/release-gate.sh`) | **PASS, 0 skipped** (datasource references, drift of the NetFlow generator, inventory document, required documents) |
| NetFlow query harness (`tools/netflow/test-queries.mjs`) against real ClickHouse via Grafana | **67 / 67 queries OK** for all five dashboards with inventory / traffic / idle exporters |
| Panel smoke (`tools/panel-smoke.mjs`) on the deployed dashboards | **67 PASS, 0 FAIL** |
| Browser check of the dashboards (selectors, states, links, empty states) | done on the disposable Grafana, screenshots in `docs/screenshots/` |

## 3. Reports

* **Network Health (live path)**: real Grafana + Zabbix plugin + renderer + Chromium PDF: 14 devices, **COMPLETE**, 4 pages (3 + one continuation page for > 9 devices), ≈ 370 KB, ≈ 35 s. Panels are rendered with the `hosts` dashboard variable so the same dashboard serves any scope.
* **DEMO examples** (normal and partial, three PDFs each) and **NO DATA examples** (real code path, three PDFs) are in [reports/examples/](reports/examples/README.md); synthetic data is always labelled DEMO and is never mixed with operational data (the operational code path never reads the fixtures).
* **Saved scopes** (e2e with real Chromium): a scope `site = DEMO-HQ, device type = Router, metrics = availability, cpu` narrows the health report to 2 devices, the interface report to the configured interfaces of those devices, and every NetFlow query to `ExporterName IN (…)`; the health panels are rendered for those devices only; the scope is printed in the report, e-mail and Telegram summary.
* **Delivery (mock SMTP + Telegram)**: three PDFs attached byte-identical, subject `… NetFlow COMPLETE / Interfaces COMPLETE / Health PARTIAL`, three Telegram documents + summary, duplicate prevention unchanged (second run skips before querying Grafana). **Nothing is sent to any real recipient; `EMAIL_ENABLED` / `TELEGRAM_ENABLED` stay off.**
* **Performance** (4 vCPU / 8 GiB VM): all three reports generated live in **79 s** wall (NetFlow 314 KB, Interface 254 KB, Health 373 KB ≈ 0.9 MB per day), the `grafana-report` process peaks at **96 MB** RSS and 1.7 s CPU (the renderer and the Podman Chromium dominate, as measured in reports/VALIDATION.md §3: ≈ 350 MiB / 2.5 cores while rendering, ≈ 1.1 GB for the PDF print). The Health report alone takes ≈ 35 s; a scoped run of all three (3 devices, 1 interface) 40 s. The 67 NetFlow dashboard queries answer in 2.3 s in total (max 74 ms) on the small test data set; dashboards open in under 10 s in the browser pane. Production NetFlow volume was not available (L2).

## 4. Defects found by this validation (fixed)

1. `filterByValue` with `range` is not a Grafana matcher id (it is `between`): the KPI cards counted every device. Found in the browser.
2. A `${site:singlequote}` list is *not* quoted when it is the "All" value (`.*` is substituted raw): the exporter set became invalid SQL. Fixed by testing the `csv` form; found in the browser (the query harness had modelled the quoting differently and is corrected).
3. `status` of availability in the timeline was drawn in the "no data" colour: value mappings did not colour state-timeline bars on Grafana 13; range mappings + thresholds do.
4. State-timeline extends the last state to the right edge, so a device that stopped reporting looked UP: replaced by a **status-history** panel with 10 / 30-minute cells (empty where nothing was collected).
5. SNMP availability *unknown* was counted as down time and 0 % coverage in the report model.
6. A site / device-type scope needs the Zabbix inventory: the report reads it through Grafana's Zabbix API pass-through (read-only), and device names that are unsafe for SQL / regular expressions are skipped and logged instead of interpolated.
7. **NetFlow Overview: the Top IP / conversation tables were silently empty** because they filter on `src_ip` / `dst_ip`, which that dashboard never defined (Grafana leaves an undefined `${var}` as literal text, so the filter matched nothing). The query harness could not see it (it supplied the variables itself). Overview now defines both variables, and a unit test fails when any dashboard uses a variable it does not define.
8. `ACTIVE EXPORTERS` showed its fallback text (`0 / 0` in the original) because a *text* result needs `fields: '/.*/'` on the stat panel: the original "0/0" artefact is explained and fixed.
9. The report job started the Zabbix mock as a background process that died with the SSH session — the test rig now uses a transient systemd user unit (test infrastructure only).

## 5. Known limitations (honest list)

L1–L10 of [reports/VALIDATION.md](reports/VALIDATION.md) still apply. Additionally:

* **S1 — not validated against a real Zabbix / the LAB.** The Zabbix behaviour comes from the real plugin 6.8.0 talking to a mock server; host-group conventions (`Site/…`, `Type/…`), item names and the 1-hour metadata cache must be confirmed on the LAB before production.
* **S2 — last data** is a coarse bucket; **WAN utilisation %** is not computed on the dashboard (capacity is shown next to traffic; the interface *report* computes it); **interface type** is a name-prefix filter; the **selection** lives in the URL only. Details in [UNIVERSAL-SELECTION.md §6](UNIVERSAL-SELECTION.md).
* **S3 — NetFlow ↔ Zabbix mapping** is by name (`ExporterName` = Zabbix host name). An exporter named differently shows as NOT IN INVENTORY and its device as NO DATA.
* **S4 — health report timeline** uses 30-minute cells (DOWN if any ping in the cell failed): a 5-minute blip paints a whole cell; exact down time is in the table (5-minute resolution).
* **S5 — health charts** are readable to about 20 devices (tables list all).
* **S6 — one disposable VM**: no Windows-hosted Grafana, no multi-user load test; dashboards were checked with one browser.

## 6. GO / NO-GO

| Decision | Verdict |
|---|---|
| Merge the branch and use the enhanced dashboards, the generators and the three reports for **LAB acceptance** (apply the dashboards to the LAB Grafana with `scripts/apply.mjs` after approval) | **GO** |
| Enable the daily timer with **real recipients / Telegram** | **NO-GO until** the items of reports/VALIDATION.md §5 are done, plus: `grafana-report scopes --resolve` and one manual `generate` of all three reports against the real Zabbix are reviewed (S1) |
| Production release (tag) of this work | **NO-GO — not requested**; no release is published and v1.0.1 is not overwritten |
| Replace the original dashboards | **Not done, by design**: UIDs, queries and original panels are preserved (collapsed rows) |

Rationale: the selection model, state semantics, honest NetFlow health, scope resolution, report C and the delivery path are validated end to end on RHEL 9.6 with the real Grafana plugins; the open items are exactly what needs the real Zabbix, real traffic and your approval.

## 7. Reproducing

```
node --test tests/unit/*.test.mjs && bash scripts/release-gate.sh && bash tests/check-generator.sh
node tools/monitoring/build.mjs && node tools/netflow/generate.mjs       # regenerate the dashboards (then tools/inventory.mjs)
node tests/mocks/zabbix-mock.mjs &                                        # mock Zabbix (14 hosts; POST /admin/add-host to onboard one at run time)
node tests/rhel/seed-live-flows.mjs                                       # current synthetic flows for SITE-A (active) and SITE-B (idle); --clean removes them
node tools/netflow/test-queries.mjs --scope real --devices SITE-A,SITE-B  # every NetFlow query through Grafana
node tools/panel-smoke.mjs --devices SITE-A,SITE-B
grafana-report scopes --resolve --scope site-a-routers && grafana-report generate --kind health --scope site-a-routers
```
