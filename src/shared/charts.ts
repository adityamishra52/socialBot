// Charts and diagrams drawn as SVG, so figures carry no third-party copyright. Used by the server
// (figures Gemini plans from numbers stated in the text) and the browser (figures from the user's
// own spreadsheet). The style follows journal practice: sans-serif, thin axes, no top/right
// lines, the colour-blind-safe Okabe–Ito palette, and individual points when groups are small.

export const PALETTE = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"];
export const CHART_TYPES = ["bar", "hbar", "line", "pie", "scatter", "dot"];
export const DIAGRAM_LAYOUTS = ["flow", "cycle", "hub"];
const FONT = "Arial, Helvetica, sans-serif";

export class FigureSpecError extends Error {}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const label = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).split(/\s+/).join(" ").slice(0, n) : "");

export function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const m of String(text || "").matchAll(/(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])-?\d+(?:\.\d+)?/g)) {
    const value = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(value)) found.add(value);
  }
  return found;
}

/** A clean chart spec. With `corpus`, every value must be a number stated there (nothing made up). */
export function checkChart(raw: any, corpus: string | null) {
  if (!raw || typeof raw !== "object") throw new FigureSpecError("The chart has no data.");
  const type = CHART_TYPES.includes(raw.type) ? raw.type : "bar";
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).slice(0, 24).map((c: unknown) => label(c, 40));
  if (type !== "scatter" && (categories.length < 2 || !categories.every(Boolean))) throw new FigureSpecError("A chart needs at least two labelled categories.");
  const series: { name: string; values: number[]; points?: number[][] }[] = [];
  for (const item of (Array.isArray(raw.series) ? raw.series : []).slice(0, 6)) {
    const values = Array.isArray(item?.values) ? item.values : null;
    if (!values || (type !== "scatter" && values.length !== categories.length)) throw new FigureSpecError("Each data series needs one value per category.");
    if (!values.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) throw new FigureSpecError("Chart values must be numbers.");
    const points = Array.isArray(item.points) ? item.points.map((p: unknown) => (Array.isArray(p) ? p.filter((x) => typeof x === "number" && Number.isFinite(x)) : [])) : undefined;
    series.push({ name: label(item.name, 40), values, ...(points ? { points } : {}) });
  }
  if (!series.length) throw new FigureSpecError("The chart has no data series.");
  if (type === "pie" && series[0].values.some((v) => v <= 0)) throw new FigureSpecError("A pie chart needs positive values.");
  if (corpus !== null) {
    const known = numbersIn(corpus);
    const missing = series.flatMap((s) => s.values).filter((v) => ![...known].some((n) => Math.abs(v - n) <= 1e-9 * Math.max(1, Math.abs(v))));
    if (missing.length) throw new FigureSpecError(`These chart values aren't stated in the text or sources: ${missing.slice(0, 5).join(", ")}.`);
  }
  return { type, categories, series: type === "pie" ? series.slice(0, 1) : series, x_values: Array.isArray(raw.x_values) ? raw.x_values.filter((v: unknown) => typeof v === "number") : null,
    title: label(raw.title, 120), x_label: label(raw.x_label, 60), y_label: label(raw.y_label, 60) };
}

export function checkDiagram(raw: any) {
  if (!raw || typeof raw !== "object") throw new FigureSpecError("The diagram has no steps.");
  const layout = DIAGRAM_LAYOUTS.includes(raw.layout) ? raw.layout : "flow";
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s: unknown) => label(s, 70)).filter(Boolean).slice(0, 8);
  if (steps.length < 2) throw new FigureSpecError("A diagram needs at least two steps.");
  return { layout, steps, center: label(raw.center, 50) };
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= value / 5) || 10;
  return Math.ceil(value / (step * power)) * step * power;
}
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(Math.round(v * 100) / 100));

function wrap(text: string, width: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width && line) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function legend(series: { name: string }[], x: number, y: number) {
  if (series.length < 2) return "";
  return series.map((s, i) => `<rect x="${x + i * 150}" y="${y - 9}" width="11" height="11" fill="${PALETTE[i % PALETTE.length]}"/><text x="${x + i * 150 + 16}" y="${y}" font-size="12">${esc(s.name)}</text>`).join("");
}

export function chartSvg(spec: ReturnType<typeof checkChart>): string {
  const W = 760, H = 480;
  const m = { l: 74, r: 24, t: spec.title ? 48 : 24, b: 86 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const parts: string[] = [];
  const title = spec.title ? `<text x="${W / 2}" y="26" text-anchor="middle" font-size="15" font-weight="700">${esc(spec.title)}</text>` : "";
  if (spec.type === "pie") {
    const values = spec.series[0].values;
    const total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    const cx = 260, cy = H / 2 + 6, r = 170;
    values.forEach((v, i) => {
      const next = angle + (v / total) * Math.PI * 2;
      const large = next - angle > Math.PI ? 1 : 0;
      const path = values.length === 1 ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
        : `M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(next)} ${cy + r * Math.sin(next)} Z`;
      parts.push(`<path d="${path}" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="1.5"/>`);
      parts.push(`<rect x="470" y="${70 + i * 26}" width="14" height="14" fill="${PALETTE[i % PALETTE.length]}"/><text x="492" y="${82 + i * 26}" font-size="13">${esc(spec.categories[i])} (${fmt((v / total) * 100)}%)</text>`);
      angle = next;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" fill="#111"><rect width="100%" height="100%" fill="#fff"/>${title}${parts.join("")}</svg>`;
  }
  const all = spec.series.flatMap((s) => [...s.values, ...(s.points || []).flat()]);
  const min = Math.min(0, ...all);
  const max = niceMax(Math.max(...all, 0) * 1.05);
  const horizontal = spec.type === "hbar";
  const scale = (v: number) => ((v - min) / (max - min || 1));
  const ticks = 5;
  for (let i = 0; i <= ticks; i += 1) {
    const value = min + ((max - min) * i) / ticks;
    if (horizontal) {
      const x = m.l + scale(value) * pw;
      parts.push(`<line x1="${x}" y1="${m.t}" x2="${x}" y2="${m.t + ph}" stroke="#e5e7eb"/><text x="${x}" y="${m.t + ph + 18}" text-anchor="middle" font-size="12">${fmt(value)}</text>`);
    } else {
      const y = m.t + ph - scale(value) * ph;
      parts.push(`<line x1="${m.l}" y1="${y}" x2="${m.l + pw}" y2="${y}" stroke="#e5e7eb"/><text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="12">${fmt(value)}</text>`);
    }
  }
  const n = spec.type === "scatter" ? 0 : spec.categories.length;
  if (spec.type === "scatter") {
    const xs = spec.x_values && spec.x_values.length ? spec.x_values : spec.series[0].values.map((_, i) => i + 1);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    spec.series.forEach((s, si) => s.values.forEach((v, i) => {
      const x = m.l + ((xs[i] - xmin) / (xmax - xmin || 1)) * pw;
      parts.push(`<circle cx="${x}" cy="${m.t + ph - scale(v) * ph}" r="4.5" fill="${PALETTE[si % PALETTE.length]}" fill-opacity="0.85"/>`);
    }));
    for (let i = 0; i <= 4; i += 1) {
      const value = xmin + ((xmax - xmin) * i) / 4;
      parts.push(`<text x="${m.l + (pw * i) / 4}" y="${m.t + ph + 18}" text-anchor="middle" font-size="12">${fmt(value)}</text>`);
    }
  } else if (spec.type === "line") {
    spec.series.forEach((s, si) => {
      const points = s.values.map((v, i) => [m.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1)), m.t + ph - scale(v) * ph]);
      parts.push(`<polyline fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="2.4" points="${points.map((p) => p.join(",")).join(" ")}"/>`);
      points.forEach(([x, y]) => parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="${PALETTE[si % PALETTE.length]}"/>`));
    });
    spec.categories.forEach((c, i) => parts.push(`<text x="${m.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1))}" y="${m.t + ph + 18}" text-anchor="middle" font-size="12">${esc(c)}</text>`));
  } else {
    const groups = spec.series.length;
    const band = (horizontal ? ph : pw) / n;
    const barSize = Math.min(56, (band * 0.72) / groups);
    spec.categories.forEach((c, i) => {
      spec.series.forEach((s, si) => {
        const v = s.values[i];
        const offset = i * band + (band - barSize * groups) / 2 + si * barSize;
        const color = PALETTE[si % PALETTE.length];
        if (horizontal) {
          const x0 = m.l + scale(Math.min(0, v)) * pw;
          parts.push(`<rect x="${x0}" y="${m.t + offset}" width="${Math.abs(scale(v) - scale(0)) * pw}" height="${barSize - 2}" fill="${color}"/>`);
        } else if (spec.type === "dot") {
          const cx = m.l + offset + barSize / 2;
          const pts = s.points?.[i] || [];
          pts.forEach((p, k) => parts.push(`<circle cx="${cx + ((k % 5) - 2) * 4}" cy="${m.t + ph - scale(p) * ph}" r="3.6" fill="${color}" fill-opacity="0.75"/>`));
          const sd = pts.length > 1 ? Math.sqrt(pts.reduce((a, p) => a + (p - v) ** 2, 0) / (pts.length - 1)) : 0;
          const y = m.t + ph - scale(v) * ph;
          parts.push(`<line x1="${cx - 14}" x2="${cx + 14}" y1="${y}" y2="${y}" stroke="#111" stroke-width="2.4"/>`);
          if (sd) parts.push(`<line x1="${cx}" x2="${cx}" y1="${m.t + ph - scale(v + sd) * ph}" y2="${m.t + ph - scale(v - sd) * ph}" stroke="#111" stroke-width="1.4"/>`);
        } else {
          const y0 = m.t + ph - scale(Math.max(0, v)) * ph;
          parts.push(`<rect x="${m.l + offset}" y="${y0}" width="${barSize - 2}" height="${Math.abs(scale(v) - scale(0)) * ph}" fill="${color}"/>`);
        }
      });
      if (horizontal) parts.push(`<text x="${m.l - 8}" y="${m.t + i * band + band / 2 + 4}" text-anchor="end" font-size="12">${esc(c.slice(0, 22))}</text>`);
      else wrap(c, 14).forEach((line, li) => parts.push(`<text x="${m.l + i * band + band / 2}" y="${m.t + ph + 18 + li * 14}" text-anchor="middle" font-size="12">${esc(line)}</text>`));
    });
  }
  parts.push(`<line x1="${m.l}" y1="${m.t + ph}" x2="${m.l + pw}" y2="${m.t + ph}" stroke="#111"/><line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ph}" stroke="#111"/>`);
  if (spec.x_label) parts.push(`<text x="${m.l + pw / 2}" y="${H - 34}" text-anchor="middle" font-size="13" font-weight="700">${esc(spec.x_label)}</text>`);
  if (spec.y_label) parts.push(`<text transform="translate(18 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="13" font-weight="700">${esc(spec.y_label)}</text>`);
  parts.push(legend(spec.series, m.l, H - 12));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" fill="#111"><rect width="100%" height="100%" fill="#fff"/>${title}${parts.join("")}</svg>`;
}

export function diagramSvg(spec: ReturnType<typeof checkDiagram>): string {
  const W = 760, H = 480;
  const parts: string[] = [`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#374151"/></marker></defs>`];
  const box = (x: number, y: number, w: number, h: number, text: string, fill: string) => {
    const lines = wrap(text, Math.max(10, Math.floor(w / 8.5)));
    parts.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="#1f2937" stroke-width="1.2"/>`);
    lines.forEach((line, i) => parts.push(`<text x="${x}" y="${y + (i - (lines.length - 1) / 2) * 16 + 5}" text-anchor="middle" font-size="14" fill="#fff" font-weight="600">${esc(line)}</text>`));
  };
  const arrow = (x1: number, y1: number, x2: number, y2: number) => parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#374151" stroke-width="2" marker-end="url(#arrow)"/>`);
  const steps = spec.steps;
  if (spec.layout === "flow") {
    const perRow = steps.length > 4 ? Math.ceil(steps.length / 2) : steps.length;
    const rows = Math.ceil(steps.length / perRow);
    const w = Math.min(170, (W - 60) / perRow - 30), h = 84;
    const pos = steps.map((_, i) => {
      const row = Math.floor(i / perRow);
      const col = row % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow);
      return [40 + w / 2 + col * ((W - 80 - w) / Math.max(1, perRow - 1)), H / 2 + (row - (rows - 1) / 2) * 150];
    });
    pos.forEach(([x, y], i) => {
      if (i) {
        const [px, py] = pos[i - 1];
        if (py === y) arrow(px + (x > px ? w / 2 : -w / 2), y, x + (x > px ? -w / 2 - 4 : w / 2 + 4), y);
        else arrow(px, py + h / 2, x, y - h / 2 - 4);
      }
    });
    pos.forEach(([x, y], i) => box(x, y, w, h, steps[i], PALETTE[i % PALETTE.length]));
  } else {
    const cx = W / 2, cy = H / 2, r = 170;
    const pos = steps.map((_, i) => [cx + r * 1.35 * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / steps.length), cy + r * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / steps.length)]);
    if (spec.layout === "hub") {
      pos.forEach(([x, y]) => parts.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#9ca3af" stroke-width="2"/>`));
      parts.push(`<circle cx="${cx}" cy="${cy}" r="74" fill="#111827"/>`);
      wrap(spec.center || "Core idea", 14).forEach((line, i, all) => parts.push(`<text x="${cx}" y="${cy + (i - (all.length - 1) / 2) * 17 + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${esc(line)}</text>`));
    } else {
      pos.forEach(([x, y], i) => {
        const [nx, ny] = pos[(i + 1) % pos.length];
        const t = 0.32;
        arrow(x + (nx - x) * t, y + (ny - y) * t, x + (nx - x) * (1 - t), y + (ny - y) * (1 - t));
      });
    }
    pos.forEach(([x, y], i) => box(x, y, 150, 70, steps[i], PALETTE[i % PALETTE.length]));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
}

// --- From the author's own spreadsheet ---

export function profileRows(rows: string[][]) {
  const header = rows[0] || [];
  const body = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  const columns = header.map((name, i) => {
    const values = body.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "");
    const numeric = values.filter((v) => Number.isFinite(Number(v.replace(/,/g, ""))));
    return { name: name || `Column ${i + 1}`, index: i, numeric: values.length > 0 && numeric.length / values.length >= 0.9, distinct: new Set(values).size, count: values.length };
  });
  return { columns, rows: body.length };
}

/** 2-3 chart options for a sheet, best first, each already drawn as a spec. */
export function suggestCharts(rows: string[][]) {
  const { columns } = profileRows(rows);
  const body = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  const num = (v: string) => Number(String(v).replace(/,/g, ""));
  const numeric = columns.filter((c) => c.numeric);
  const categorical = columns.filter((c) => !c.numeric);
  const options: { name: string; why: string; spec: any }[] = [];
  if (categorical.length && numeric.length) {
    const cat = categorical[0];
    const groups = [...new Set(body.map((r) => r[cat.index]).filter(Boolean))].slice(0, 16);
    const points = (col: number) => groups.map((g) => body.filter((r) => r[cat.index] === g).map((r) => num(r[col])).filter(Number.isFinite));
    const means = (col: number) => points(col).map((p) => (p.length ? Math.round((p.reduce((a, b) => a + b, 0) / p.length) * 1000) / 1000 : 0));
    const replicated = points(numeric[0].index).some((p) => p.length >= 2);
    if (replicated) {
      options.push({ name: "Dot plot with mean ± SD", why: `Several ${numeric[0].name} values per ${cat.name}: showing every point is more honest than a bar for small groups.`,
        spec: { type: "dot", categories: groups, series: [{ name: numeric[0].name, values: means(numeric[0].index), points: points(numeric[0].index) }], x_label: cat.name, y_label: numeric[0].name } });
    }
    options.push({ name: numeric.length > 1 ? "Grouped bar chart" : "Bar chart", why: `Compares ${numeric.slice(0, 3).map((c) => c.name).join(", ")} across ${cat.name}${replicated ? " (bars show means)" : ""}.`,
      spec: { type: groups.length > 8 ? "hbar" : "bar", categories: groups, series: numeric.slice(0, 4).map((c) => ({ name: c.name, values: means(c.index) })), x_label: cat.name, y_label: numeric.length === 1 ? numeric[0].name : "" } });
    if (numeric.length === 1 && !replicated && groups.length <= 7 && means(numeric[0].index).every((v) => v > 0)) {
      options.push({ name: "Pie chart", why: `Shows each ${cat.name}'s share of the total ${numeric[0].name}.`, spec: { type: "pie", categories: groups, series: [{ name: numeric[0].name, values: means(numeric[0].index) }] } });
    }
  }
  if (numeric.length >= 2) {
    const x = numeric[0];
    const ordered = body.map((r) => r.map((c) => c)).sort((a, b) => num(a[x.index]) - num(b[x.index]));
    const timeLike = /time|day|week|month|year|dose|conc|age|hour|min/i.test(x.name);
    options.push({ name: timeLike ? "Line chart" : "Scatter plot", why: timeLike ? `${x.name} looks like time or dose, so a line shows the trend.` : `Shows how ${numeric[1].name} relates to ${x.name}.`,
      spec: timeLike
        ? { type: "line", categories: ordered.map((r) => r[x.index]).slice(0, 24), series: numeric.slice(1, 4).map((c) => ({ name: c.name, values: ordered.slice(0, 24).map((r) => num(r[c.index])) })), x_label: x.name, y_label: numeric.length === 2 ? numeric[1].name : "" }
        : { type: "scatter", categories: [], x_values: ordered.map((r) => num(r[x.index])), series: [{ name: numeric[1].name, values: ordered.map((r) => num(r[numeric[1].index])) }], x_label: x.name, y_label: numeric[1].name } });
  }
  return options.slice(0, 3);
}

/** The plotted values as CSV ("source data", which journals ask for). */
export function sourceDataCsv(spec: any) {
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  if (spec.type === "scatter") return [quote(spec.x_label || "x"), ...spec.series.map((s: any) => quote(s.name))].join(",") + "\n"
    + (spec.x_values || []).map((x: number, i: number) => [x, ...spec.series.map((s: any) => s.values[i])].join(",")).join("\n");
  return [quote(spec.x_label || "Category"), ...spec.series.map((s: any) => quote(s.name))].join(",") + "\n"
    + spec.categories.map((c: string, i: number) => [quote(c), ...spec.series.map((s: any) => s.values[i])].join(",")).join("\n");
}
