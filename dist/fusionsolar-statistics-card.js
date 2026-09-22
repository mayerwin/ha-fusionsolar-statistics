/*!
 * FusionSolar Statistics Card
 * A Home Assistant Lovelace card that reproduces the Huawei FusionSolar app's
 * "Statistics" screen (Day / Month / Year / Lifetime) from Home Assistant's own
 * long-term statistics. No cloud access, no FusionSolar account required.
 *
 * https://github.com/mayerwin/fusionsolar-statistics
 * MIT licence.
 */

const CARD_VERSION = "0.3.1";

/* ------------------------------------------------------------------ palette */
/* Sampled from the FusionSolar Android app. */
const C = {
  darkGreen: "#00A862", // production consumed / self-consumption
  liteGreen: "#8BD24A", // production fed to grid
  orange: "#FF5A1F", // consumption total / from PV
  amber: "#FDB913", // consumption from grid
  mint: "#74D3A5", // chart: production / PV output
  blueLite: "#A5AEF5", // chart: battery charge
  blueDark: "#2C6FE0", // chart: battery discharge
};

/* Neutrals are NOT in the palette: they come from the Home Assistant theme via
   the CSS custom properties in _css(), so the card reads correctly on a dark
   theme too. Only the brand colours above are fixed. */

const PERIODS = [
  { key: "day", label: "Day" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "lifetime", label: "Lifetime" },
];

/* ------------------------------------------------------------------ helpers */

const pad2 = (n) => String(n).padStart(2, "0");

/** Format an energy value the way the app does: kWh below 1 MWh, else MWh. */
function fmtEnergy(kwh) {
  const v = Number(kwh) || 0;
  if (Math.abs(v) >= 1000) return { value: (v / 1000).toFixed(2), unit: "MWh" };
  return { value: v.toFixed(2), unit: "kWh" };
}

function fmtPct(part, total) {
  if (!total) return "(0.00%)";
  return `(${((part / total) * 100).toFixed(2)}%)`;
}

/**
 * SVG arc path. Angles are degrees from 12 o'clock; positive sweep = clockwise.
 */
function arcPath(cx, cy, r, startDeg, sweepDeg) {
  const rad = (d) => ((d - 90) * Math.PI) / 180;
  const a0 = rad(startDeg);
  const a1 = rad(startDeg + sweepDeg);
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const dir = sweepDeg >= 0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${dir} ${x1.toFixed(
    2
  )} ${y1.toFixed(2)}`;
}

/** "Nice" axis maximum, so ticks land on round numbers like the app does. */
function niceMax(v, ticks) {
  if (!isFinite(v) || v <= 0) return ticks;
    const raw = v / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return step * ticks;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------------------------------------------------- card */

class FusionSolarStatisticsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._period = "day";
    this._anchor = new Date();
    this._data = null;
    this._loading = false;
    this._error = null;
    this._built = false;
    this._lastFetchKey = null;
    // Series hidden by tapping their legend pill, as the app allows. Kept on
    // the element (not per-render) so the choice survives tab and date changes.
    this._hidden = new Set();
  }

  static getConfigElement() {
    return document.createElement("fusionsolar-statistics-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:fusionsolar-statistics-card",
      title: "Energy Management",
      entities: {
        production: "",
        fed_to_grid: "",
        from_grid: "",
        battery_charge: "",
        battery_discharge: "",
      },
    };
  }

  setConfig(config) {
    if (!config || !config.entities) {
      throw new Error("fusionsolar-statistics-card: `entities` is required");
    }
    // `production_mode` decides what the Production ring counts.
    //
    //   "pv"               `production` is the PV (DC) yield: what the panels
    //                      generated, losses included.
    //   "ac_plus_storage"  `production` is the inverter's AC yield, and the
    //                      battery's net charge is added back. This is what the
    //                      FusionSolar app shows, and it EXCLUDES DC->AC
    //                      conversion, battery charging losses and the
    //                      inverter's own self-consumption.
    //
    // The two differ by those losses: measured on an EMMA system over a clean
    // half-day, DC yield 20.35 kWh vs 18.63 kWh derived, a gap of 1.72 kWh
    // (8.5%). The app read 18.50 kWh. Pick "ac_plus_storage" to agree with the
    // app, "pv" to report what the array actually produced.
    //
    // Note the AC yield ALONE is not a substitute for either: it omits every
    // kWh that charged a DC-coupled battery, which never becomes AC.
    // `pv_production` is kept as a deprecated alias for `production`.
    //
    // `consumption` is optional but strongly recommended: a MEASURED house-load
    // counter. Without it the card derives load from the production side, which
    // ignores battery round-trip losses and overstates it. See README.
    const e = { ...config.entities };
    if (!e.production && e.pv_production) e.production = e.pv_production;
    for (const k of ["production", "fed_to_grid", "from_grid"]) {
      if (!e[k]) throw new Error(`fusionsolar-statistics-card: entities.${k} is required`);
    }
    const mode = config.production_mode || "pv";
    if (!["pv", "ac_plus_storage"].includes(mode)) {
      throw new Error(
        `fusionsolar-statistics-card: production_mode must be "pv" or "ac_plus_storage"`);
    }
    if (mode === "ac_plus_storage" && !(e.battery_charge && e.battery_discharge)) {
      throw new Error("fusionsolar-statistics-card: production_mode " +
        '"ac_plus_storage" needs entities.battery_charge and entities.battery_discharge');
    }
    this._config = {
      title: "Energy Management",
      default_period: "day",
      production_mode: mode,
      show_full_screen: true,
      ...config,
      entities: e,
    };
    this._period = this._config.default_period || "day";
    this._built = false;
    this._lastFetchKey = null;
    if (this._hass) this._maybeFetch();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._syncTheme();
    if (first) this._maybeFetch();
  }

  /** Mirror Home Assistant's light/dark choice onto the host; the CSS keys off
      the attribute. It is written on every hass update, and set even when the
      theme is light, so the prefers-color-scheme fallback below cannot fight a
      light HA theme on a dark OS. */
  _syncTheme() {
    const t = this._hass && this._hass.themes;
    const dark = t && (t.darkMode !== undefined ? t.darkMode : t.dark_mode);
    if (dark === undefined || dark === null) {
      // A frontend too old to report it: leave the attribute off and let the
      // prefers-color-scheme fallback decide.
      delete this.dataset.theme;
      return;
    }
    const want = dark ? "dark" : "light";
    if (this.dataset.theme !== want) this.dataset.theme = want;
  }

  getCardSize() {
    return 16;
  }

  connectedCallback() {
    if (this._hass) this._syncTheme();
    this._render();
    if (this._hass) this._maybeFetch();
    // Refresh live-ish while visible.
    this._timer = setInterval(() => this._maybeFetch(true), 60000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  /* ------------------------------------------------------------ time window */

  _window() {
    const a = this._anchor;
    switch (this._period) {
      case "day": {
        const s = new Date(a.getFullYear(), a.getMonth(), a.getDate());
        const e = new Date(s);
        e.setDate(e.getDate() + 1);
        // 5-minute buckets, not hourly: hourly statistics only close on the
        // hour, so mid-afternoon the Day ring lagged the app by whatever had
        // been produced since the last o'clock (0.5-2 kWh at midday).
        return { start: s, end: e, bucket: "5minute", chartBucket: "5minute" };
      }
      case "month": {
        const s = new Date(a.getFullYear(), a.getMonth(), 1);
        const e = new Date(a.getFullYear(), a.getMonth() + 1, 1);
        return { start: s, end: e, bucket: "day", chartBucket: "day" };
      }
      case "year": {
        const s = new Date(a.getFullYear(), 0, 1);
        const e = new Date(a.getFullYear() + 1, 0, 1);
        return { start: s, end: e, bucket: "month", chartBucket: "month" };
      }
      default: {
        // Lifetime: everything up to the end of the anchor year.
        const s = new Date(2000, 0, 1);
        const e = new Date(a.getFullYear() + 1, 0, 1);
        return { start: s, end: e, bucket: "month", chartBucket: "month" };
      }
    }
  }

  _label() {
    const a = this._anchor;
    switch (this._period) {
      case "day":
        return `${pad2(a.getDate())}/${pad2(a.getMonth() + 1)}/${a.getFullYear()}`;
      case "month":
        return `${pad2(a.getMonth() + 1)}/${a.getFullYear()}`;
      default:
        return String(a.getFullYear());
    }
  }

  _shift(dir) {
    const a = new Date(this._anchor);
    if (this._period === "day") a.setDate(a.getDate() + dir);
    else if (this._period === "month") a.setMonth(a.getMonth() + dir);
    else a.setFullYear(a.getFullYear() + dir);
    if (a > new Date()) return; // never navigate into the future
    this._anchor = a;
    this._render();
    this._maybeFetch();
  }

  /* ----------------------------------------------------------------- data */

  _ids() {
    const e = this._config.entities;
    return {
      energy: [e.production, e.fed_to_grid, e.from_grid, e.consumption,
               e.battery_charge, e.battery_discharge].filter(Boolean),
      power: [e.pv_power, e.load_power, e.grid_power, e.battery_power].filter(Boolean),
    };
  }

  async _maybeFetch(silent) {
    if (!this._hass || !this._config) return;
    const w = this._window();
    const key = `${this._period}|${w.start.toISOString()}|${w.end.toISOString()}`;
    if (silent && key === this._lastFetchKey && this._data && !this._error) {
      // periodic refresh of the current window only
    } else if (key === this._lastFetchKey && this._loading) {
      return;
    }
    this._lastFetchKey = key;
    this._loading = true;
    this._error = null;
    if (!silent) this._render();
    try {
      this._data = await this._fetch(w);
    } catch (err) {
      this._error = (err && err.message) || String(err);
      this._data = null;
    }
    this._loading = false;
    this._render();
  }

  async _fetch(w) {
    const hass = this._hass;
    const e = this._config.entities;
    const ids = this._ids();
    const now = new Date();
    const end = w.end > now ? now : w.end;

    const energy = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: w.start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: ids.energy,
      period: w.bucket,
      types: ["change"],
    });

    const series = (id) => (id && energy[id]) || [];
    const sumOf = (id) => series(id).reduce((s, r) => s + (r.change || 0), 0);

    const fedToGrid = Math.max(0, sumOf(e.fed_to_grid));
    const fromGrid = Math.max(0, sumOf(e.from_grid));
    const charge = Math.max(0, sumOf(e.battery_charge));
    const discharge = Math.max(0, sumOf(e.battery_discharge));

    // In "ac_plus_storage" the configured counter is the inverter's AC yield,
    // so the energy that charged the battery has to be added back and the
    // energy it gave up has to be taken out again to avoid counting it twice.
    const reported = Math.max(0, sumOf(e.production));
    const production = this._config.production_mode === "ac_plus_storage"
      ? Math.max(0, reported + charge - discharge)
      : reported;

    const consumed = Math.max(0, production - fedToGrid);

    // Prefer a MEASURED house-load counter. Deriving consumption from the
    // production side (consumed - charge + discharge) systematically OVERSTATES
    // it, because it ignores battery round-trip losses: on a real day charging
    // 11.15 kWh and discharging 3.71 kWh, the derivation came out 1.18 kWh high
    // against the app. The measured counter also mirrors the app's own
    // arithmetic, which just splits the load into "From grid" and the rest.
    let consumption;
    if (e.consumption) {
      consumption = Math.max(0, sumOf(e.consumption));
    } else {
      consumption = Math.max(0, consumed - charge + discharge) + fromGrid;
    }
    const fromPv = Math.max(0, consumption - fromGrid);

    const out = {
      production, fedToGrid, consumed,
      consumption, fromPv, fromGrid,
      charge, discharge,
      chart: null,
    };

    if (this._period === "day") {
      out.chart = await this._fetchDayChart(w, end);
    } else {
      out.chart = this._buildBarChart(energy, w);
    }
    return out;
  }

  async _fetchDayChart(w, end) {
    const e = this._config.entities;
    const ids = this._ids().power;
    if (!ids.length) return null;
    let res = {};
    try {
      res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: w.start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: ids,
        period: "5minute",
        types: ["mean"],
      });
    } catch (_) {
      res = {};
    }
    // 5-minute statistics are only retained ~10 days; fall back to hourly.
    const empty = !Object.values(res).some((v) => v && v.length);
    if (empty) {
      try {
        res = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: w.start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: "hour",
          types: ["mean"],
        });
      } catch (_) {
        res = {};
      }
    }

    const at = (id) => {
      const m = new Map();
      for (const r of (id && res[id]) || []) m.set(r.start, r.mean);
      return m;
    };
    const pv = at(e.pv_power);
    const load = at(e.load_power);
    const grid = at(e.grid_power);
    const bat = at(e.battery_power);

    const stamps = new Set();
    [pv, load, grid, bat].forEach((m) => m.forEach((_, k) => stamps.add(k)));
    const xs = [...stamps].sort((a, b) => a - b);
    if (!xs.length) return null;

    const kw = (v) => (v == null ? null : v / 1000);
    const pts = xs.map((t) => {
      const l = load.get(t);
      const g = grid.get(t);
      const b = bat.get(t);
      const fromPv = l == null ? null : Math.max(0, l - Math.max(0, g == null ? 0 : g));
      return {
        t,
        pv: kw(pv.get(t)),
        load: kw(l),
        fromPv: kw(fromPv),
        charge: b == null ? null : Math.max(0, b) / 1000,
        discharge: b == null ? null : Math.max(0, -b) / 1000,
      };
    });

    return {
      kind: "line",
      unit: "kW",
      points: pts,
      dayStart: w.start.getTime(),
      series: [
        { key: "pv", label: "PV output", color: C.mint },
        { key: "load", label: "Total consumption", color: C.orange },
        { key: "fromPv", label: "Consumed from PV", color: C.darkGreen },
        { key: "charge", label: "Battery (charge)", color: C.blueLite },
        { key: "discharge", label: "Battery (discharge)", color: C.blueDark },
      ],
    };
  }

  _buildBarChart(energy, w) {
    const e = this._config.entities;
    const grab = (id) => {
      const m = new Map();
      for (const r of (id && energy[id]) || []) m.set(r.start, r.change || 0);
      return m;
    };
    const pv = grab(e.production);
    const fed = grab(e.fed_to_grid);
    const imp = grab(e.from_grid);
    const cons = grab(e.consumption);
    const chg = grab(e.battery_charge);
    const dis = grab(e.battery_discharge);

    const stamps = new Set();
    [pv, fed, imp, cons, chg, dis].forEach((m) => m.forEach((_, k) => stamps.add(k)));
    let keys = [...stamps].sort((a, b) => a - b);
    if (!keys.length) return null;

    const rows = keys.map((t) => {
      const f = Math.max(0, fed.get(t) || 0);
      const i = Math.max(0, imp.get(t) || 0);
      const c = Math.max(0, chg.get(t) || 0);
      const d = Math.max(0, dis.get(t) || 0);
      // Same production model as the rings, applied per bucket.
      const pReported = Math.max(0, pv.get(t) || 0);
      const p = this._config.production_mode === "ac_plus_storage"
        ? Math.max(0, pReported + c - d)
        : pReported;
      // Same rule as the rings: use the measured load when it is configured,
      // and only fall back to the lossy production-side derivation otherwise.
      const total = e.consumption
        ? Math.max(0, cons.get(t) || 0)
        : Math.max(0, Math.max(0, p - f) - c + d) + i;
      const fromPv = Math.max(0, total - i);
      return { t, production: p, consumption: total, self: fromPv, charge: c, discharge: d };
    });

    // Lifetime rolls the monthly buckets up into calendar years.
    let out = rows;
    if (this._period === "lifetime") {
      const byYear = new Map();
      for (const r of rows) {
        const y = new Date(r.t).getFullYear();
        const acc = byYear.get(y) || { t: new Date(y, 0, 1).getTime(), production: 0, consumption: 0, self: 0, charge: 0, discharge: 0 };
        acc.production += r.production;
        acc.consumption += r.consumption;
        acc.self += r.self;
        acc.charge += r.charge;
        acc.discharge += r.discharge;
        byYear.set(y, acc);
      }
      out = [...byYear.values()].sort((a, b) => a.t - b.t);
    }

    return {
      kind: "bar",
      period: this._period,
      rows: out,
      series: [
        { key: "production", label: "Production", color: C.mint },
        { key: "consumption", label: "Consumption", color: C.orange },
        { key: "self", label: "Self-consumption energy", color: C.darkGreen },
        { key: "charge", label: "Battery (charge)", color: C.blueLite },
        { key: "discharge", label: "Battery (discharge)", color: C.blueDark },
      ],
    };
  }

  /* --------------------------------------------------------------- render */

  _render() {
    if (!this._config) return;
    const root = this.shadowRoot;
    if (!this._built) {
      root.innerHTML = `<style>${this._css()}</style><ha-card><div class="wrap"></div></ha-card>`;
      this._built = true;
    }
    const wrap = root.querySelector(".wrap");
    wrap.innerHTML = this._html();
    this._bind(wrap);
  }

  _bind(wrap) {
    wrap.querySelectorAll(".tab").forEach((el) => {
      el.addEventListener("click", () => {
        const p = el.dataset.period;
        if (p === this._period) return;
        this._period = p;
        this._anchor = new Date();
        this._render();
        this._maybeFetch();
      });
    });
    const prev = wrap.querySelector(".nav-prev");
    const next = wrap.querySelector(".nav-next");
    if (prev) prev.addEventListener("click", () => this._shift(-1));
    if (next) next.addEventListener("click", () => this._shift(1));
    const fs = wrap.querySelector(".fs-btn");
    if (fs) fs.addEventListener("click", () => this._toggleFullScreen());

    // Legend pills toggle their series, like the app. Re-render only -- the
    // data is already in hand, so this never refetches.
    wrap.querySelectorAll(".pill[data-key]").forEach((el) => {
      el.addEventListener("click", () => {
        const k = el.dataset.key;
        if (this._hidden.has(k)) this._hidden.delete(k);
        else this._hidden.add(k);
        this._render();
      });
    });

    const picker = wrap.querySelector(".picker");
    if (picker) {
      picker.addEventListener("change", () => this._onPick(picker.value));
      if (picker.tagName === "INPUT") {
        // A transparent date input only opens its calendar when the (hidden)
        // indicator is hit, so ask for it explicitly wherever that is supported.
        picker.addEventListener("click", () => {
          if (typeof picker.showPicker === "function") {
            try { picker.showPicker(); } catch (_) { /* not allowed / unsupported */ }
          }
        });
      }
    }
  }

  _toggleFullScreen() {
    const card = this.shadowRoot.querySelector("ha-card");
    if (!card) return;
    this.classList.toggle("fs-active");
    card.classList.toggle("fullscreen");
  }

  _html() {
    const d = this._data;
    const tabs = PERIODS.map(
      (p) =>
        `<button class="tab ${p.key === this._period ? "active" : ""}" data-period="${p.key}">${p.label}</button>`
    ).join("");

    const atNow = (() => {
      const n = new Date();
      const a = this._anchor;
      if (this._period === "day") return a.toDateString() === n.toDateString();
      if (this._period === "month")
        return a.getFullYear() === n.getFullYear() && a.getMonth() === n.getMonth();
      return a.getFullYear() === n.getFullYear();
    })();

    const body = this._error
      ? `<div class="msg err">${escapeHtml(this._error)}</div>`
      : !d
      ? `<div class="msg">${this._loading ? "Loading&hellip;" : "No data"}</div>`
      : this._bodyHtml(d);

    return `
      <div class="tabs">${tabs}</div>
      <div class="datenav">
        <button class="navbtn nav-prev" aria-label="Previous">${chevron("left")}</button>
        <div class="datelabel">${this._label()}<span class="caret"></span>${this._pickerHtml()}</div>
        <button class="navbtn nav-next ${atNow ? "disabled" : ""}" aria-label="Next">${chevron("right")}</button>
      </div>
      <div class="section">${escapeHtml(this._config.title || "Energy Management")}</div>
      ${body}
    `;
  }

  /** Native picker overlaid on the date label: date / month / year per period. */
  _pickerHtml() {
    const a = this._anchor;
    const now = new Date();
    const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const isoMonth = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    if (this._period === "day") {
      return `<input class="picker" type="date" value="${isoDay(a)}" max="${isoDay(now)}">`;
    }
    if (this._period === "month") {
      return `<input class="picker" type="month" value="${isoMonth(a)}" max="${isoMonth(now)}">`;
    }
    let opts = "";
    for (let y = now.getFullYear(); y >= now.getFullYear() - 15; y--) {
      opts += `<option value="${y}"${y === a.getFullYear() ? " selected" : ""}>${y}</option>`;
    }
    return `<select class="picker">${opts}</select>`;
  }

  _onPick(value) {
    if (!value) return;
    let d;
    if (this._period === "day") {
      const [y, m, dd] = value.split("-").map(Number);
      d = new Date(y, m - 1, dd);
    } else if (this._period === "month") {
      const [y, m] = value.split("-").map(Number);
      d = new Date(y, m - 1, 1);
    } else {
      d = new Date(Number(value), 0, 1);
    }
    if (isNaN(d) || d > new Date()) return;
    this._anchor = d;
    this._render();
    this._maybeFetch();
  }

  _bodyHtml(d) {
    return `
      <div class="rings">
      ${this._ringBlock({
        caption: "Production",
        total: d.production,
        left: { value: d.consumed, label: "Consumed", color: C.darkGreen, of: d.production },
        right: { value: d.fedToGrid, label: "Fed to grid", color: C.liteGreen, of: d.production },
      })}
      ${this._ringBlock({
        caption: "Consumption",
        total: d.consumption,
        left: { value: d.fromPv, label: "From PV", color: C.orange, of: d.consumption },
        right: { value: d.fromGrid, label: "From grid", color: C.amber, of: d.consumption },
      })}
      </div>
      ${this._config.show_full_screen
        ? `<div class="fsrow"><button class="fs-btn">Full Screen ${expandIcon()}</button></div>`
        : ""}
      <div class="chartbox">${this._chartHtml(d.chart)}</div>
      ${this._legendHtml(d.chart)}
    `;
  }

  _ringBlock({ caption, total, left, right }) {
    const t = fmtEnergy(total);
    const l = fmtEnergy(left.value);
    const r = fmtEnergy(right.value);

    // TWO gaps, at 12 o'clock and at 6 o'clock, like the app. The arcs share
    // (360 - 2*GAP) degrees; each starts GAP/2 either side of 12 o'clock and
    // sweeps away from it, so the remainder falls out as an equal gap at the
    // bottom. Round linecaps then eat ~(strokeWidth/2)/R radians off each end,
    // so GAP is set larger than the gap you actually want to see.
    const GAP = 15;
    const avail = 360 - GAP * 2;
    const frac = total > 0 ? left.value / total : 0;
    const sweepL = avail * (total > 0 ? frac : 0.5);
    const sweepR = avail * (total > 0 ? 1 - frac : 0.5);
    // Geometry calibrated against the app: ring outer diameter is 23.3% of the
    // card width and the stroke is ~9% of that diameter.
    const R = 45, SW = 10;
    const cx = 55, cy = 55;
    // A zero-width arc would still paint a dot because of the round linecap.
    const MIN = 0.6;
    const arcL = sweepL > MIN
      ? `<path d="${arcPath(cx, cy, R, -GAP / 2, -sweepL)}" stroke="${left.color}" stroke-width="${SW}" fill="none" stroke-linecap="round"/>`
      : "";
    const arcR = sweepR > MIN
      ? `<path d="${arcPath(cx, cy, R, GAP / 2, sweepR)}" stroke="${right.color}" stroke-width="${SW}" fill="none" stroke-linecap="round"/>`
      : "";

    return `
      <section class="ringcol"><div class="ringinner">
      <div class="sub">${caption}<span class="info">i</span></div>
      <div class="statrow">
        <div class="statcard">
          <div class="side">
            <div class="val" style="color:${left.color}">${l.value}<span class="unit">${l.unit}</span></div>
            <div class="lbl">${left.label}</div>
            <div class="pct">${fmtPct(left.value, total)}</div>
          </div>
          <div class="gap"></div>
          <div class="side right">
            <div class="val" style="color:${right.color}">${r.value}<span class="unit">${r.unit}</span></div>
            <div class="lbl">${right.label}</div>
            <div class="pct">${fmtPct(right.value, total)}</div>
          </div>
        </div>
        <div class="donut">
          <svg viewBox="0 0 110 110" preserveAspectRatio="xMidYMid meet">
            ${arcL}${arcR}
          </svg>
          <div class="donut-text">
            <div class="dv">${t.value}</div>
            <div class="du">${t.unit}</div>
          </div>
        </div>
      </div>
      </div></section>
    `;
  }

  /* ---------------------------------------------------------------- charts */

  _chartHtml(chart) {
    if (!chart) return `<div class="msg small">No chart data for this period</div>`;
    return chart.kind === "line" ? this._lineChart(chart) : this._barChart(chart);
  }

  _lineChart(chart) {
    const W = 680, H = 272;
    const ml = 52, mr = 14, mt = 34, mb = 38;
    const iw = W - ml - mr, ih = H - mt - mb;

    // Hidden series are excluded from the scale too, so the axis rescales to
    // what is actually shown -- otherwise hiding the big series leaves the
    // remaining ones squashed against the bottom.
    const series = chart.series.filter((s) => !this._hidden.has(s.key));
    let max = 0;
    for (const p of chart.points)
      for (const s of series) {
        const v = p[s.key];
        if (v != null && v > max) max = v;
      }
    const ticks = 5;
    const top = niceMax(max || 1, ticks);
    const x = (t) => ml + (iw * (t - chart.dayStart)) / 86400000;
    const y = (v) => mt + ih - (ih * v) / top;

    let g = "";
    for (let i = 0; i <= ticks; i++) {
      const v = (top / ticks) * i;
      const yy = y(v);
      g += `<line x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}" class="gridline" stroke-dasharray="${i === 0 ? "0" : "7 6"}"/>`;
      g += `<text x="${ml - 10}" y="${yy + 5}" text-anchor="end" class="ax">${trimNum(v)}</text>`;
    }
    // The app labels 00:00 .. 20:00 only; the plot area still spans the full 24 h.
    for (let h = 0; h <= 20; h += 4) {
      const xx = ml + (iw * h) / 24;
      g += `<text x="${xx}" y="${H - 14}" text-anchor="middle" class="ax">${pad2(h)}:00</text>`;
    }

    let paths = "";
    for (const s of series) {
      let dstr = "";
      let open = false;
      for (const p of chart.points) {
        const v = p[s.key];
        if (v == null) { open = false; continue; }
        const px = x(p.t), py = y(v);
        dstr += `${open ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)} `;
        open = true;
      }
      if (dstr) {
        paths += `<path d="${dstr}" fill="none" stroke="${s.color}" stroke-width="1.6"
                        stroke-linejoin="round" stroke-linecap="round"/>`;
      }
    }

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <text x="${ml + 4}" y="18" class="ax unit">${chart.unit}</text>
      ${g}${paths}
    </svg>`;
  }

  _barChart(chart) {
    const W = 680, H = 272;
    const ml = 52, mr = 14, mt = 34, mb = 38;
    const iw = W - ml - mr, ih = H - mt - mb;
    const rows = chart.rows;

    // Choose a display unit: the app switches kWh -> MWh on the year/lifetime views.
    let peak = 0;
    const series = chart.series.filter((s) => !this._hidden.has(s.key));
    for (const r of rows) for (const s of series) peak = Math.max(peak, r[s.key] || 0);
    const useMwh = peak >= 1000;
    const scale = useMwh ? 1 / 1000 : 1;
    const unit = useMwh ? "MWh" : "kWh";

    const ticks = 5;
    const top = niceMax(peak * scale || 1, ticks);
    const y = (v) => mt + ih - (ih * v) / top;

    let g = "";
    for (let i = 0; i <= ticks; i++) {
      const v = (top / ticks) * i;
      const yy = y(v);
      g += `<line x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}" class="gridline" stroke-dasharray="${i === 0 ? "0" : "7 6"}"/>`;
      g += `<text x="${ml - 10}" y="${yy + 5}" text-anchor="end" class="ax">${trimNum(v)}</text>`;
    }

    // Slot geometry: every category gets an equal slot holding 5 thin bars.
    const slots = this._slotCount(chart);
    const slotW = iw / slots;
    const nS = Math.max(1, series.length);
    const barW = Math.max(1.5, Math.min(9, (slotW * 0.85) / nS));
    const groupW = barW * nS;

    let bars = "";
    for (const r of rows) {
      const idx = this._slotIndex(chart, r.t);
      if (idx < 0 || idx >= slots) continue;
      const x0 = ml + slotW * (idx + 0.5) - groupW / 2;
      series.forEach((s, i) => {
        const v = (r[s.key] || 0) * scale;
        if (v <= 0) return;
        const hgt = Math.max(0.5, mt + ih - y(v));
        bars += `<rect x="${(x0 + i * barW).toFixed(2)}" y="${y(v).toFixed(2)}" width="${barW.toFixed(2)}" height="${hgt.toFixed(2)}" fill="${s.color}" rx="0.5"/>`;
      });
    }

    let labels = "";
    const every = this._labelEvery(chart, slots);
    for (let i = 0; i < slots; i++) {
      if (i % every !== 0) continue;
      const xx = ml + slotW * (i + 0.5);
      labels += `<text x="${xx}" y="${H - 14}" text-anchor="middle" class="ax">${this._slotLabel(chart, i)}</text>`;
    }

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <text x="${ml + 4}" y="18" class="ax unit">${unit}</text>
      ${g}${bars}${labels}
    </svg>`;
  }

  _slotCount(chart) {
    if (chart.period === "month") {
      const a = this._anchor;
      return new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();
    }
    if (chart.period === "year") return 12;
    const years = chart.rows.map((r) => new Date(r.t).getFullYear());
    if (!years.length) return 1;
    const lo = Math.min(...years) - 1;
    const hi = Math.max(...years);
    return Math.max(1, hi - lo + 1);
  }

  _slotIndex(chart, t) {
    const d = new Date(t);
    if (chart.period === "month") return d.getDate() - 1;
    if (chart.period === "year") return d.getMonth();
    const years = chart.rows.map((r) => new Date(r.t).getFullYear());
    const lo = Math.min(...years) - 1;
    return d.getFullYear() - lo;
  }

  _slotLabel(chart, i) {
    if (chart.period === "month" || chart.period === "year") return pad2(i + 1);
    const years = chart.rows.map((r) => new Date(r.t).getFullYear());
    const lo = Math.min(...years) - 1;
    return String(lo + i);
  }

  _labelEvery(chart, slots) {
    if (chart.period === "month") return 2; // the app labels odd days: 01, 03, 05 ...
    return 1;
  }

  _legendHtml(chart) {
    const series = (chart && chart.series) || [];
    if (!series.length) return "";
    return `<div class="legend">${series
      .map((s) => {
        const off = this._hidden.has(s.key);
        return `<button class="pill${off ? " off" : ""}" data-key="${escapeHtml(s.key)}"
                  aria-pressed="${off ? "false" : "true"}"
                  title="${off ? "Show" : "Hide"} ${escapeHtml(s.label)}"
                ><i style="background:${off ? "transparent" : s.color};border-color:${s.color}"></i>${escapeHtml(s.label)}</button>`;
      })
      .join("")}</div>`;
  }

  /* ------------------------------------------------------------------ css */

  _css() {
    /* Sizes are calibrated from the FusionSolar app screenshots as a fraction
       of card width, then expressed in `em` off a container-scaled base so the
       proportions hold at phone width and stay sane on a wide desktop card. */
    return `
      :host { display:block; }

      /* ---- theme tokens ----
         Only the ring/chart brand colours are fixed; every neutral comes from
         here, so the card is legible on a dark theme instead of painting near
         black text onto a near black card. Home Assistant's own variables come
         first (a custom theme then just works), with the FusionSolar greys as
         the fallback. The data-theme attribute is set from hass.themes.darkMode; the media
         query only covers the standalone demo, where there is no hass to ask. */
      :host {
        --fsc-ink: var(--primary-text-color, #1D1D1F);
        --fsc-sub: var(--secondary-text-color, #6B6B6B);
        --fsc-faint: #9A9A9A;
        --fsc-grid: var(--divider-color, #D5D7DA);
        --fsc-surface: #F5F6F7;   /* stat cards, legend pills, tab track */
        --fsc-chip: #FFFFFF;      /* the selected tab */
        --fsc-chip-shadow: 0 1px 3px rgba(0,0,0,.10);
        --fsc-hairline: #B6B6B6;
        --fsc-ring-shadow: drop-shadow(0 2px 4px rgba(0,0,0,.12));
        --fsc-card-bg: var(--ha-card-background, var(--card-background-color, #fff));
      }
      /* Translucent surfaces, so they sit on whatever card colour the theme
         gives us rather than assuming one. */
      :host([data-theme="dark"]) {
        color-scheme: dark;
        --fsc-ink: var(--primary-text-color, #E9E9EB);
        --fsc-sub: var(--secondary-text-color, #A9A9AE);
        --fsc-faint: #8B8B91;
        --fsc-grid: var(--divider-color, rgba(255,255,255,.17));
        --fsc-surface: rgba(255,255,255,.07);
        --fsc-chip: rgba(255,255,255,.17);
        --fsc-chip-shadow: 0 1px 3px rgba(0,0,0,.45);
        --fsc-hairline: rgba(255,255,255,.34);
        --fsc-ring-shadow: none;
      }
      @media (prefers-color-scheme: dark) {
        :host(:not([data-theme="light"])) {
          color-scheme: dark;
          --fsc-ink: var(--primary-text-color, #E9E9EB);
          --fsc-sub: var(--secondary-text-color, #A9A9AE);
          --fsc-faint: #8B8B91;
          --fsc-grid: var(--divider-color, rgba(255,255,255,.17));
          --fsc-surface: rgba(255,255,255,.07);
          --fsc-chip: rgba(255,255,255,.17);
          --fsc-chip-shadow: 0 1px 3px rgba(0,0,0,.45);
          --fsc-hairline: rgba(255,255,255,.34);
          --fsc-ring-shadow: none;
        }
      }

      ha-card {
        display: block;          /* explicit, so the standalone demo works too */
        container-type: inline-size;
        padding: 12px 12px 16px;
        font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
        color: var(--fsc-ink);
        background: var(--fsc-card-bg);
      }
      ha-card.fullscreen {
        position: fixed; inset: 0; z-index: 9999; overflow: auto;
        border-radius: 0; margin: 0;
      }
      .wrap { font-size: clamp(12px, 3.25cqi, 17px); line-height: 1.2; }

      /* ---- segmented tabs ---- */
      .tabs {
        display: grid; grid-template-columns: repeat(4, 1fr);
        background: var(--fsc-surface); border-radius: 999px; padding: 0.21em; gap: 0.14em;
      }
      .tab {
        appearance: none; border: 0; background: transparent; cursor: pointer;
        font: inherit; font-size: 1.04em; color: var(--fsc-sub);
        padding: 0.6em 0.2em; border-radius: 999px;
        transition: background .15s, color .15s; white-space: nowrap;
      }
      .tab.active {
        background: var(--fsc-chip); color: var(--fsc-ink); font-weight: 600;
        box-shadow: var(--fsc-chip-shadow);
      }

      /* ---- date navigator ---- */
      .datenav {
        display: flex; align-items: center; justify-content: space-between;
        margin: 1em 0.15em 0.2em;
      }
      .navbtn {
        appearance: none; border: 0; background: transparent; cursor: pointer;
        padding: 0.2em 0.5em; line-height: 0; color: var(--fsc-ink);
      }
      .navbtn svg { width: 1.5em; height: 1.5em; }
      .navbtn.disabled { opacity: .28; pointer-events: none; }
      .datelabel {
        font-size: 1.16em; font-weight: 700; letter-spacing: .2px;
        display: flex; align-items: center; gap: 0.5em;
        position: relative; cursor: pointer;
      }
      /* Native date/month/year picker, invisible but covering the label. */
      .picker {
        position: absolute; inset: 0; width: 100%; height: 100%;
        opacity: 0; cursor: pointer; border: 0; padding: 0; margin: 0;
        font: inherit; color: inherit; background: transparent;
        -webkit-appearance: none; appearance: none;
      }
      .picker::-webkit-calendar-picker-indicator {
        position: absolute; inset: 0; width: 100%; height: 100%;
        margin: 0; padding: 0; cursor: pointer; opacity: 0;
      }
      .caret {
        width: 0; height: 0; border-left: .34em solid transparent;
        border-right: .34em solid transparent; border-top: .4em solid var(--fsc-ink);
      }

      .section {
        font-size: 1.29em; font-weight: 500; margin: 1em .15em .8em;
        color: var(--fsc-ink);
      }
      .sub {
        font-size: 1.04em; color: var(--fsc-sub); margin: 0 .15em .6em;
        display: flex; align-items: center; gap: .4em;
      }
      .info {
        display: inline-flex; align-items: center; justify-content: center;
        width: 1.05em; height: 1.05em; border: 1px solid var(--fsc-hairline); border-radius: 50%;
        font-size: .78em; font-style: italic; color: var(--fsc-faint); font-family: Georgia, serif;
        flex: none;
      }

      /* ---- ring block ----
         Each ring is its own container, so the donut is sized from the width of
         the COLUMN it lands in - correct whether stacked or side by side. */
      .rings { display: grid; grid-template-columns: 1fr; column-gap: 1.4em; }
      @container (min-width: 620px) {
        .rings { grid-template-columns: 1fr 1fr; }
      }
      .ringcol { container-type: inline-size; min-width: 0; }
      .ringinner { font-size: clamp(12px, 3.25cqi, 17px); }
      .statrow { position: relative; margin-bottom: 1.9em; }
      .statcard {
        background: var(--fsc-surface); border-radius: .85em;
        display: flex; align-items: center; min-height: 4.6em; padding: .6em .3em;
      }
      .side { flex: 1; text-align: left; padding-left: 1.15em; min-width: 0; }
      .side.right { text-align: right; padding-left: 0; padding-right: 1.15em; }
      .gap { width: 8.6em; flex: none; }
      .val { font-size: 1.21em; font-weight: 700; line-height: 1.15; white-space: nowrap; }
      .val .unit { font-size: .59em; font-weight: 600; margin-left: .2em; }
      .lbl { font-size: .86em; color: var(--fsc-sub); margin-top: .25em; }
      .pct { font-size: .79em; color: var(--fsc-faint); margin-top: .1em; }

      .donut {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: 8em; height: 8em; border-radius: 50%;
        background: var(--fsc-card-bg);
        display: flex; align-items: center; justify-content: center;
      }
      .donut svg {
        position: absolute; inset: 0; width: 100%; height: 100%;
        filter: var(--fsc-ring-shadow);
      }
      .donut-text { position: relative; text-align: center; }
      .dv { font-size: 1.43em; font-weight: 500; line-height: 1.1; }
      .du { font-size: .86em; color: var(--fsc-ink); margin-top: .1em; }

      /* ---- full screen ---- */
      .fsrow { display: flex; justify-content: flex-end; margin: .2em 0 .8em; }
      .fs-btn {
        appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 1.04em;
        background: var(--fsc-surface); color: var(--fsc-ink); border-radius: .55em;
        padding: .6em .9em; display: inline-flex; align-items: center; gap: .5em;
      }
      .fs-btn svg { width: 1em; height: 1em; }

      /* ---- chart ---- */
      .chartbox { width: 100%; overflow: hidden; }
      svg.chart { width: 100%; height: auto; display: block; }
      .ax { font-size: 17px; fill: var(--fsc-faint); font-family: inherit; }
      .ax.unit { fill: var(--fsc-sub); }
      .gridline { stroke: var(--fsc-grid); stroke-width: 1; }

      /* ---- legend ---- */
      .legend { display: flex; flex-wrap: wrap; gap: .45em; margin-top: .7em; }
      .pill {
        display: inline-flex; align-items: center; gap: .42em;
        background: var(--fsc-surface); border: 0; border-radius: 999px; padding: .42em .8em;
        font: inherit; font-size: .86em; color: var(--fsc-ink); white-space: nowrap;
        cursor: pointer; transition: opacity .12s;
        -webkit-tap-highlight-color: transparent;
      }
      .pill:hover { opacity: .85; }
      /* Tapping a pill hides its series; the pill dims and its dot hollows out
         so it still reads as re-enable-able, the way the app does it. */
      .pill.off { opacity: .45; }
      .pill.off i { background: transparent !important; }
      .pill i {
        width: .6em; height: .6em; border-radius: 50%; display: inline-block;
        flex: none; border: 1.5px solid transparent; box-sizing: border-box;
      }

      .msg { padding: 2em .3em; color: var(--fsc-sub); text-align: center; font-size: 1em; }
      .msg.small { padding: 3em .3em; }
      .msg.err { color: var(--error-color, #c62828); }
    `;
  }
}

function trimNum(v) {
  if (v === 0) return "0";
  const s = v >= 10 ? v.toFixed(0) : v >= 1 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100);
  return s.replace(/\.0+$/, "");
}

function chevron(dir) {
  const d = dir === "left" ? "M15 5 L8 12 L15 19" : "M9 5 L16 12 L9 19";
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="${d}"/></svg>`;
}

function expandIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 3H3v6"/><path d="M3 3l7 7"/><path d="M15 21h6v-6"/><path d="M21 21l-7-7"/></svg>`;
}

customElements.define("fusionsolar-statistics-card", FusionSolarStatisticsCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "fusionsolar-statistics-card",
  name: "FusionSolar Statistics Card",
  description:
    "Reproduces the Huawei FusionSolar app Statistics screen (Day/Month/Year/Lifetime) from Home Assistant statistics.",
  preview: true,
  documentationURL: "https://github.com/mayerwin/fusionsolar-statistics",
});

console.info(
  `%c FUSIONSOLAR-STATISTICS-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#00A862;font-weight:700",
  "color:#00A862;background:#f1f2f4;font-weight:700"
);
