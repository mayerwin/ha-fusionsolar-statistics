# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-09-09

### Changed
- **Recommend `sensor.emma_feed_in_power` for `grid_power`, not `sensor.emma_active_power`.**
  The Day chart derives *Consumed from PV* as `load - grid`, and those two values are only
  comparable if they come from the same Modbus read. `huawei-solar-lib` batches registers into
  single FC3 transactions (span within 64, gap under 16); `pv_output_power`, `load_power`,
  `feed_in_power` and `battery_charge_discharge_power` share one batch, while
  `sensor.emma_active_power` resolves to `active_power_built_in_energy` and is fetched
  separately. The two grid registers agreed to a 2 W median over a day of testing, so this is a
  drop-in change with the same *positive = import* convention.

### Documentation
- New section on picking co-batched power sensors, including how to confirm the grouping on
  your own system with one poll of `huawei_solar.device.base` debug logging.
- New section on battery sign conventions, and how they differ between this card, the Home
  Assistant Energy dashboard and `power-flow-card-plus`.

## [0.2.0] - 2026-09-09

### Fixed
- **`production` must be the PV (DC) yield, not the inverter's AC yield.** Validated over a
  full undisturbed day against the app: PV yield matched to 0.05 kWh, while AC yield was
  **9.1 kWh low**, because with a DC-coupled battery the energy that charges it never becomes
  AC. A lifetime comparison misleadingly favours AC yield since charge and discharge roughly
  cancel over years, which is how 0.1.0 got it wrong.
- **Consumption is now taken from a measured house-load counter** via the new optional
  `consumption` entity. The previous derivation (`consumed - battery_charge +
  battery_discharge`) ignores battery round-trip losses and overstated load by 1.18 kWh on a
  day charging 11.15 kWh. It remains the fallback when `consumption` is not configured.
- Day-tab rings now use **5-minute** statistics rather than hourly, so they no longer lag the
  app by whatever was produced since the last o'clock.

### Added
- **Tap a legend pill to hide its series**, as the app allows. The pill dims and its dot
  hollows out; the chart's axis rescales to the remaining series. Tap again to restore.

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

[0.2.0]: https://github.com/mayerwin/ha-fusionsolar-statistics/releases/tag/v0.2.0
[0.1.0]: https://github.com/mayerwin/ha-fusionsolar-statistics/releases/tag/v0.1.0
