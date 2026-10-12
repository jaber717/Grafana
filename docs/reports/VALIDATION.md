# Daily reports — validation, sizing, limits and GO / NO-GO

Branch `feature/daily-reports` (from release v1.0.1, which is untouched). All validation ran **without touching LAB or production**: one isolated RHEL 9.6 test VM (SELinux enforcing, egress to private ranges blocked), a disposable Grafana 13.2.3 OSS container, an isolated ClickHouse and mock Zabbix / SMTP / Telegram services with dummy credentials. **No real recipient was contacted and no real credential was used.** The LAB has no traffic, as expected; every traffic figure below comes from synthetic datasets whose expected values were computed independently.

## 1. What was validated, and how

| Area | Method | Result |
|---|---|---|
| Unit and integration tests | `node --test tests/unit/*.test.mjs` (106 tests incl. 6 end-to-end runs with real Chromium) | **106 / 106 pass on Windows/Node 22 and on RHEL 9.6 / Node 20.20.2** (the latter with Chromium from the pinned image under rootless Podman, `tests/rhel/run-unit-suite.sh`, 35 s) |
| Release gate | `scripts/release-gate.sh` | **PASS, 0 skipped** (syntax, config, secrets scan, inventory, version, units) |
| Reporting window | unit tests at midnight boundaries; live: `from`/`to` sent to Grafana equal the previous Riyadh day | PASS |
| **NetFlow SQL accuracy** | all 16 report queries run against a **real ClickHouse 26.8** with the **real Akvorado schema** and 4,616 synthetic rows; each result compared with an *independent* JS aggregation of the same rows (window filter, demo-exporter exclusion, boundary-based direction, × SamplingRate) | **174 / 174 checks** (totals by direction, previous day, 288-point trend, hourly, protocol/IP/conversation/port rankings with exact bytes, exporters, site, ISP; the half-open window excludes the end boundary row) |
| **Interface accuracy** | live run through the **real Zabbix datasource plugin** (`groupBy 5m/avg`, `scale`, `setAlias`) vs the raw 60-second samples | **20 / 20** (volume, average, peak, utilisation, coverage to < 1e-6 relative) |
| Live end-to-end | real ClickHouse + Zabbix datasource plugins in Grafana, Grafana renderer, Chromium PDF | 3-page PDFs, both COMPLETE; inbound total through the plugin = 55,008,000 B = expected |
| Reports are independent | day without NetFlow rows (live): NetFlow **NO DATA** (2 pages), Interface **COMPLETE** (3 pages) | PASS |
| PARTIAL behaviour | live: 90-minute gap on one interface | coverage 93.75 %, status PARTIAL, gap listed, previous-day comparison suppressed, other interface and NetFlow unaffected |
| NO DATA behaviour | unit + e2e + PDF review | designed page, no figures, no zeros, no charts rendered; the example uses the real (non-demo) code path with the shipped SITE-A/SITE-B list |
| Layout / pagination | fixed A4-landscape pages; a guard measures every block in headless Chromium and **refuses to print a cropped or overflowing PDF**; PDF page count must equal the design; visual review of every page | PASS (the guard caught one real overflow during development) |
| E-mail | mock SMTP: 2 recipients, both PDFs byte-identical to the stored files, HTML + text parts; retries, bounded failures, partial recipients, auth, header injection | PASS |
| SMTP TLS | STARTTLS and implicit TLS with certificate verification; untrusted certificate refused **before any password is sent**; no STARTTLS offered ⇒ fails closed | PASS |
| Telegram | mock Bot API: message + documents, token check, `429 retry_after` honoured and resume without resending finished parts, wrong token = permanent and never logged | PASS |
| Duplicate prevention | second run skips before querying Grafana (`already-delivered`); `--force` resends; concurrent runs locked; ledger per recipient/part | PASS (also under systemd) |
| systemd on RHEL 9.6 | dedicated `grafana-report` user, SELinux enforcing, rootless Podman for the PDF step, report service + Podman renderer unit, mock delivery | **0 SELinux denials**, `Result=success` |
| Timer | `OnCalendar=*-*-* 07:00:00 Asia/Riyadh` ⇒ next elapse 04:00 UTC; `schedule set 07:30`, enable/disable, invalid input rejected | PASS |
| Offline | renderer image bundle (digest verified, sha256), loaded into an **empty** Podman store, `--pull=never` run | PASS; the registry digest correctly does **not** resolve offline (see §3.6) |
| Revision guard | stale or DEMO dashboards on Grafana stop the live job with an instruction | PASS (fired for real twice) |

## 2. Defects found by validation (all fixed, none left open)
1. **ClickHouse rejected the `exporters` query** (alias `SamplingRate` collided with the column inside an aggregate). Found only by running against a real ClickHouse; the mock-based tests could not see it.
2. **Zabbix series names ignored `alias`** — the plugin takes `setAlias`. Without it every chart showed raw item names in one colour. Found only against the real plugin.
3. **Renderer minimum viewport (1000×500)** silently letterboxed small panels. Fix: renderer settings + a hard size check (the job fails rather than print a misaligned chart).
4. **Axis tick labels repeated** (“5 kb/s, 5 kb/s…”) with forced zero decimals on small values → automatic decimals.
5. **Duplicate runs regenerated everything (45 s)** before skipping delivery → a delivered day is now skipped before any query.
6. **Misleading previous-day percentages on incomplete days** → suppressed with an explanation.
7. **Sparse pages for few interfaces** → adaptive panel layout (full-width / 2×2 / 2×3).
8. **Rootless Podman under systemd**: image runs as `nonroot` (needs `--user {uid}`), RHEL refuses short image names, the runtime directory path must be stable (tmpfiles.d + `RuntimeDirectoryPreserve`), and **seccomp-based hardening directives break `newuidmap`** — bisected; the unit keeps only directives proven compatible.
9. **Offline image reference**: a saved archive cannot reproduce a registry manifest-list digest (my first offline test only “worked” because the VM had Internet and Podman silently pulled) → pinned by image **ID**, verified by `load-image`.
10. Credential-scan false positives in my own code → refactored (the gate was not loosened).

## 3. Measured resource consumption and sizing

Run on a 4 vCPU / 8 GiB VM, three repeated live runs generating **both reports** (9 Grafana panel renders: 6 NetFlow + 3 Interface; 16 SQL queries; two 3-page PDFs):

| Item | Measured |
|---|---|
| Wall time, both reports | **43 – 48 s**; the systemd service accounted ≈ 11.6 s of CPU |
| `grafana-report` (Node) | peak RSS **≈ 92 MB**, ≈ 1 s CPU |
| Grafana Image Renderer container | peak **≈ 350 MiB**, up to **≈ 250 % CPU** (2.5 cores) during a render; 7 MiB idle |
| Chromium during PDF printing (rootless Podman) | peak **≈ 1.1 GB** summed RSS (shared pages double-counted: an upper bound) |
| Grafana server during the run | +20–30 % of one core; no meaningful extra memory (it only serves the page to the renderer) |
| ClickHouse | all 16 queries on a few thousand rows: instant (see limitation L2 for production volumes) |
| PDF size | NetFlow ≈ 320 KB, Interface ≈ 250–260 KB (≈ 0.6 MB per day by e-mail) |
| Image / disk | renderer image 1.42 GB installed, 549 MB offline bundle; reports ≈ 0.6 MB/day (45 days kept ≈ 27 MB) |

**Recommendation.**
* **Renderer + report job: a separate host, 2 vCPU / 4 GiB RAM / 20 GB disk** (the renderer service is limited to 2 GiB / 2 CPUs by its unit; the PDF step needs ≈ 1.1 GB on top, sequentially).
* **Do not install the renderer or Chromium on the existing 2 vCPU / 3 GiB Grafana server.** A render + PDF print would need ≈ 1.5 GB more at peak and 2.5 cores for tens of seconds each morning; the existing Grafana server only needs the `[rendering]` setting (optional block in the platform template, default off) and one restart.
* A single combined host is acceptable only with ≥ 6 GiB and 4 vCPU.
* Scaling: each additional interface adds one panel render (≈ 5 s) and one summary row; the page count for 14 interfaces is covered by a unit test (layout of > 6 interfaces per page has not been reviewed visually) and render time grows linearly.

## 4. Known limitations (honest list)
* **L1 — no real Zabbix, no real LAB traffic.** The interface path was validated through the *real* Zabbix datasource plugin but against a **mock Zabbix server** with synthetic series. Behaviours of a real server are therefore unproven: item-name matching on real hosts (visible name vs technical name — `discover --compare` detects it), history vs trend selection for long ranges, and real counter-reset artefacts. Run `discover --compare` and one manual `generate` against production Zabbix before enabling the timer.
* **L2 — production NetFlow volumes untested.** The per-IP Top-10 queries read a full day of the raw table (kept 14 days). On a busy network they may exceed the datasource `queryTimeout` (30 s in the template). Mitigations in place: they are optional and degrade explicitly; recommended: raise `queryTimeout` for the ClickHouse datasource (e.g. 120 s). Their duration on real volumes has not been measured.
* **L3 — Telegram and SMTP were tested only against mocks.** The Telegram client follows the Bot API (sendMessage/sendDocument, 429 `retry_after`), the SMTP client was exercised with STARTTLS/TLS against a mock; neither has talked to a real service. `test-delivery` exists to prove this once credentials are provided. E-mail rendering was checked in Chrome only (table layout with inline styles, no web fonts) — not in Outlook or other clients.
* **L4 — estimates and double counting.** NetFlow volumes from sampled exporters are estimates; a flow observed by two exporters appears in each exporter row. Direction relies on correct interface boundary metadata in Akvorado.
* **L5 — interface speed is configuration, not measurement.** Utilisation is only as good as `speed:`; wrong speeds show up as “samples above speed” in the data-quality section. Counter-wrap/reset handling relies on Zabbix's preprocessing (the report treats the result as rates).
* **L6 — one timezone.** Asia/Riyadh is fixed (no DST); the window logic supports no other zone.
* **L7 — hardening trade-off.** The report unit cannot use seccomp-based systemd hardening because rootless Podman needs `newuidmap` (§2.8). The container sandbox and the dedicated user compensate; `systemd-analyze security` reports ≈ 8 (exposed) for that reason.
* **L8 — Docker not validated.** The recommended runtime is Podman (tested); the earlier Docker-based tests only covered the Grafana/renderer containers on the test VM.
* **L9 — PDFs are not tagged for accessibility** (colour pair blue/orange is colour-blind safe and all information is also in text).
* **L10 — applying the `[rendering]` change restarts Grafana** and requires your approval; nothing in this branch does it automatically.

## 5. GO / NO-GO

| Decision | Verdict |
|---|---|
| Merge the branch and use the report generator, dashboards and examples for **LAB acceptance** | **GO** |
| Install the renderer host and apply the Grafana `[rendering]` setting in the LAB (needs your approval for the restart) | **GO** |
| Enable the daily timer **with real recipients / real Telegram chat** | **NO-GO until**: (1) `grafana-report test-delivery` succeeds with your real SMTP and Telegram credentials; (2) `discover --compare` is clean against the real Zabbix and one manual `generate` against production data is reviewed; (3) the Top-10 query duration is checked on production NetFlow volume (L2); (4) you approve recurring delivery |
| Place Chromium / the renderer on the existing 3 GiB Grafana server | **NO-GO** (use a separate renderer host) |

Rationale: the data path, windowing, accuracy, failure handling, duplicate protection, scheduling, security handling and offline installation are validated end to end on RHEL 9.6 with independently computed expectations. The remaining NO-GO items are exactly the things that cannot be validated without your credentials, the real Zabbix and real traffic — and that you asked not to be touched.

## 6. Reproducing the validation
```
node --test tests/unit/*.test.mjs                      # everything that needs no infrastructure (Chromium needed for e2e)
bash scripts/release-gate.sh
# on a RHEL 9 test host (Node, Podman, Docker for the Grafana/ClickHouse containers):
tests/rhel/clickhouse-up.sh && node tests/rhel/validate-netflow-sql.mjs --seed     # 174 checks vs real ClickHouse
node tests/mocks/zabbix-mock.mjs & tests/rhel/grafana-live-up.sh                  # real plugins + datasources + tokens
grafana-report build-dashboards --apply … && grafana-report generate --date 2026-10-11
node tests/rhel/validate-interface-accuracy.mjs <out>/2026-10-11                  # 20 checks vs raw samples
tests/rhel/measure-run.sh run1 -- grafana-report generate --date 2026-10-11       # timing, CPU, memory
tests/rhel/bisect-hardening.sh                                                     # which systemd directives work with rootless Podman
```
