import { strFromU8, unzipSync } from "fflate";

// Read the rows of a CSV, TSV or Excel (.xlsx) file as text cells. Runs in the browser and on
// the server, with no spreadsheet library: an .xlsx file is a ZIP of XML parts.

export const MAX_ROWS = 20_000;

function decodeXml(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function columnIndex(ref: string) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || "A";
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

export function xlsxRows(data: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (file) => /^xl\/(sharedStrings\.xml|worksheets\/sheet1\.xml|workbook\.xml)$/.test(file.name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name) });
  } catch {
    throw new Error("That Excel file couldn't be read. Check it opens in Excel, or save it as CSV.");
  }
  const shared: string[] = [];
  const sharedXml = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
  for (const item of sharedXml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push(decodeXml((item.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const sheetName = files["xl/worksheets/sheet1.xml"] ? "xl/worksheets/sheet1.xml" : Object.keys(files).find((n) => n.startsWith("xl/worksheets/"));
  if (!sheetName) throw new Error("That Excel file has no sheets.");
  const xml = strFromU8(files[sheetName]);
  const rows: string[][] = [];
  for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const cells: string[] = [];
    for (const cell of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = /\br="([A-Z]+\d+)"/.exec(cell)?.[1] || "";
      const type = /\bt="(\w+)"/.exec(cell)?.[1] || "";
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
      const inline = /<is>([\s\S]*?)<\/is>/.exec(cell)?.[1];
      let text = "";
      if (type === "s" && value !== undefined) text = shared[Number(value)] || "";
      else if (type === "inlineStr" && inline) text = decodeXml(inline.replace(/<[^>]+>/g, ""));
      else if (value !== undefined) text = decodeXml(value);
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = text.trim();
    }
    rows.push(cells);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

export function csvRows(text: string): string[][] {
  const sample = text.slice(0, 5000);
  const delimiter = [",", ";", "\t", "|"].map((d) => [d, sample.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= MAX_ROWS) return rows;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

export function readRows(filename: string, data: Uint8Array): string[][] {
  const lower = (filename || "").toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(lower)) return xlsxRows(data);
  if (lower.endsWith(".xls")) throw new Error("Old .xls files aren't supported. Save the sheet as .xlsx or CSV.");
  if (!/\.(csv|tsv|txt)$/.test(lower)) throw new Error("Upload a CSV or Excel (.xlsx) file.");
  let text = new TextDecoder("utf-8").decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return csvRows(text);
}
