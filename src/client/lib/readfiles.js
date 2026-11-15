import { strFromU8, unzipSync } from "fflate";

// Proof material is read here in the browser (PDF, Word, ZIP, text, code, data), so only its text
// goes to the server: uploads never hit Vercel's 4.5 MB request limit.

export const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 40_000;
const TEXT_EXT = /\.(txt|md|markdown|rst|csv|tsv|tex|bib|json|ya?ml|toml|cfg|ini|py|r|js|jsx|ts|tsx|java|c|h|cpp|hpp|cs|go|rs|rb|php|m|jl|sh|sql|ipynb|html?|xml|swift|kt|scala|dart|vue)$/i;
const SKIP = /(^|\/)(__MACOSX|\.git|node_modules|\.venv|venv|dist|build|\.idea|\.vscode|__pycache__)(\/|$)|(^|\/)\.[^/]+$|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

const clip = (text, limit = MAX_TEXT) => String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, limit);

async function pdfText(data) {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const pages = [];
  let total = 0;
  for (let n = 1; n <= Math.min(pdf.numPages, 120) && total < MAX_TEXT; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let line = "";
    const lines = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      } else line += " ";
    }
    if (line) lines.push(line);
    const text = lines.join("\n");
    pages.push(text);
    total += text.length;
  }
  const text = clip(pages.join("\n\n"));
  if (text.length < 40) throw new Error("No text was found in this PDF (it may be a scanned image). Upload a PDF with selectable text, or a Word file.");
  return text;
}

async function docxText(data) {
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await (mammoth.default || mammoth).extractRawText({ arrayBuffer: data });
  return clip(result.value);
}

function notebook(raw) {
  try {
    return (JSON.parse(raw).cells || []).map((c) => (c.source || []).join("")).join("\n\n");
  } catch {
    return raw;
  }
}

function plain(name, bytes) {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (/\.ipynb$/i.test(name)) text = notebook(text);
  if (/\.html?$/i.test(name)) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
    text = doc.body?.innerText || doc.body?.textContent || "";
  }
  return clip(text);
}

async function zipText(data) {
  const files = unzipSync(new Uint8Array(data));
  const names = Object.keys(files).filter((n) => !n.endsWith("/") && !SKIP.test(n));
  const rank = (n) => (/readme/i.test(n.split("/").pop()) ? 0 : /\.(pdf|docx|md|txt|tex)$/i.test(n) ? 1 : /\.(csv|bib|json|ipynb)$/i.test(n) ? 2 : 3);
  const parts = [`Files in the archive:\n${names.slice(0, 150).join("\n")}`];
  let total = parts[0].length;
  for (const name of [...names].sort((a, b) => rank(a) - rank(b)).slice(0, 40)) {
    if (total >= MAX_TEXT) break;
    try {
      const bytes = files[name];
      const text = /\.pdf$/i.test(name) ? await pdfText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        : /\.docx$/i.test(name) ? await docxText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          : TEXT_EXT.test(name) ? plain(name, bytes) : "";
      if (text) {
        parts.push(`--- ${name} ---\n${clip(text, 12_000)}`);
        total += Math.min(text.length, 12_000);
      }
    } catch {
      // A damaged file inside the archive is skipped.
    }
  }
  if (parts.length === 1) throw new Error("No readable documents or text files were found in that ZIP.");
  return clip(parts.join("\n\n"));
}

/** One uploaded file as proof material: { kind, label, text }. */
export async function readProofFile(file) {
  const name = file.name || "file";
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is over 40 MB.`);
  const data = await file.arrayBuffer();
  const lower = name.toLowerCase();
  const head = new Uint8Array(data.slice(0, 5));
  if (lower.endsWith(".pdf") || String.fromCharCode(...head) === "%PDF-") return { kind: "pdf", label: name, text: await pdfText(data) };
  if (lower.endsWith(".docx")) return { kind: "docx", label: name, text: await docxText(data) };
  if (lower.endsWith(".doc")) throw new Error(`${name} is an old Word file (.doc). Save it as .docx or PDF.`);
  if (lower.endsWith(".zip")) return { kind: "zip", label: name, text: await zipText(data) };
  if (lower.endsWith(".xlsx")) {
    const { xlsxRows } = await import("../../shared/sheets.ts");
    return { kind: "data", label: name, text: clip(xlsxRows(new Uint8Array(data)).map((r) => r.join("\t")).join("\n")) };
  }
  if (TEXT_EXT.test(lower)) {
    const text = plain(name, new Uint8Array(data));
    if (!text) throw new Error(`${name} is empty.`);
    return { kind: /\.(csv|tsv)$/.test(lower) ? "data" : "text", label: name, text };
  }
  throw new Error(`${name} isn't a supported file. Upload PDF, Word (.docx), ZIP, Excel, CSV or text files.`);
}

export function readStrings(file) {
  return file.arrayBuffer().then((b) => strFromU8(new Uint8Array(b)));
}
