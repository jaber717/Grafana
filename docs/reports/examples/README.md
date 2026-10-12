# Example reports

All files cover the reporting day **2026-10-11** (Asia/Riyadh 00:00–24:00). PNG previews are screenshots of the same HTML that is printed to PDF.

| Path | What it is | Data |
|---|---|---|
| `DEMO-Daily-NetFlow-2026-10-11.pdf` | A realistic, complete NetFlow day (3 pages) | **Synthetic — DEMO** (watermarked and bannered) |
| `DEMO-Daily-Interface-Traffic-2026-10-11.pdf` | A realistic, complete Interface day: six links incl. one near saturation, one without a configured speed, a two-link boundary (3 pages) | **Synthetic — DEMO** |
| `partial/DEMO-…pdf` (2 files) | The same days with **incomplete data**: a 3 h 10 min NetFlow gap (87 % coverage) and a 90-minute gap on one interface (94 %) — shows PARTIAL badges, charts with real breaks (not zeros), missing-data indicators and suppressed previous-day comparisons | **Synthetic — DEMO** |
| `no-data/Daily-…pdf` (2 files) | A day **without any data**, exactly what the LAB produces today (2 pages each). Built by the real (non-demo) code path from empty query results and the shipped SITE-A / SITE-B interface list | **No data, nothing synthetic** — hence no DEMO label |
| `previews/…`, `no-data/previews/…` | Page screenshots (PNG) of the above | — |

The panels in the DEMO PDFs are **real Grafana panels** (rendered by Grafana 13.2.3 and its image renderer through the TestData datasource); only their data is synthetic. Everything else — KPI cards, tables, pagination, status logic — is the production code path (`grafana-report demo` reproduces the DEMO set against a *disposable* Grafana; `tests/tools/make-nodata-example.mjs` reproduces the NO DATA set).

Design rules visible in the examples: A4 landscape with 12 mm margins; one restrained palette (inbound blue `#2F6EBA`, outbound amber `#E0861B`, navy header, grey neutrals) that stays distinguishable for colour-blind readers; one decimal-SI unit convention (`Mb/s`, `GB`) shared by the charts and the text; Inter typeface (SIL OFL, bundled) for text and charts; the reporting day, period and data coverage on every page; no figure is ever shown without data behind it.
