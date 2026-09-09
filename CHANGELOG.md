# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-08

First public release.

### Added
- Day / Month / Year / Lifetime tabs reproducing the Huawei FusionSolar app's
  Statistics screen from Home Assistant long-term statistics.
- Twin split donuts: Production (consumed vs fed to grid) and Consumption
  (from PV vs from grid), with the app's two-gap ring geometry.
- Per-period charts: 5-minute power lines for Day, daily bars for Month,
  monthly bars for Year, yearly bars for Lifetime.
- Native date picker on the date label (`date` / `month` / year `select`).
- Responsive layout via CSS container queries, including a two-column mode
  (Production beside Consumption) at >= 620 px.
- Standalone demo harness (`tools/demo.html`) and screenshot generator.

[0.1.0]: https://github.com/mayerwin/ha-fusionsolar-statistics/releases/tag/v0.1.0
