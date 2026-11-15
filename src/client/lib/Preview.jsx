import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildBlocks, furniture, pageSize, roman, runs } from "./layout.js";

// The right-hand preview: the document laid out on real pages (size, margins, mirrored inside
// margins, page numbers from the chosen start, running headers, chapters on new or odd pages).

const PX = 96 / 25.4;

export function Inline({ text }) {
  return runs(text).map((run, i) => (run.placeholder ? <mark key={i} className="ph">{run.text}</mark>
    : run.italic ? <em key={i}>{run.text}</em> : <Fragment key={i}>{run.text}</Fragment>));
}

function Block({ block, toc, figuresBase }) {
  switch (block.type) {
    case "doc-title": return <h1 className="pv-doc-title"><Inline text={block.text} /></h1>;
    case "authors": return <p className="pv-authors">{block.text}</p>;
    case "meta": return <p className="pv-meta"><Inline text={block.text} /></p>;
    case "h1": return <h2 className="pv-h1"><Inline text={block.text} /></h2>;
    case "h2": return <h3 className="pv-h2"><Inline text={block.text} /></h3>;
    case "p": return <p className={`pv-p${block.cont ? " cont" : ""}${block.drop ? " drop" : ""}`}><Inline text={block.text} /></p>;
    case "ref": return <p className="pv-ref">{block.number ? <span className="pv-ref-n">{block.number}.</span> : null}<Inline text={block.text} /></p>;
    case "glossary": return <p className="pv-gloss"><strong>{block.term}.</strong> <Inline text={block.text} /></p>;
    case "chapter-title":
      return (
        <div className="pv-chapter">
          {block.label && <p className="pv-chapter-label">{block.label}</p>}
          <h1 className="pv-chapter-title"><Inline text={block.text} /></h1>
        </div>
      );
    case "box":
      return (
        <div className="pv-box">
          <p className="pv-box-title">{block.title}</p>
          {block.text && <p className="pv-p cont"><Inline text={block.text} /></p>}
          {block.items && (block.numbered
            ? <ol>{block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}</ol>
            : <ul>{block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}</ul>)}
        </div>
      );
    case "table":
      return (
        <div className="pv-table">
          <p className="pv-caption"><strong>Table {block.number}.</strong> <Inline text={block.caption} /></p>
          <table>
            <thead><tr>{block.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody>
          </table>
          {block.note && <p className="pv-note"><Inline text={block.note} /></p>}
        </div>
      );
    case "figure":
      return (
        <figure className="pv-figure">
          {block.svg ? <div className="pv-svg" dangerouslySetInnerHTML={{ __html: block.svg }} />
            : block.image ? <img src={block.image} alt={block.caption || `Figure ${block.number}`} crossOrigin="anonymous" /> : null}
          <figcaption><strong>Figure {block.number}.</strong> <Inline text={block.caption} />{block.credit && <span className="pv-credit"> {block.credit}</span>}</figcaption>
        </figure>
      );
    case "title-page":
      return (
        <div className="pv-title-page">
          <h1>{block.title}</h1>
          {block.subtitle && <p className="pv-subtitle">{block.subtitle}</p>}
          {block.authors && <p className="pv-title-authors">{block.authors}</p>}
          {block.publisher && <p className="pv-title-publisher">{block.publisher}</p>}
        </div>
      );
    case "copyright": return <div className="pv-copyright">{block.lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
    case "dedication": return <div className="pv-dedication"><p><Inline text={block.text} /></p></div>;
    case "toc":
      return (
        <div className="pv-toc">
          <h1 className="pv-chapter-title">Contents</h1>
          {(toc || []).map((entry, i) => (
            <p key={i} className="pv-toc-line"><span>{entry.label ? `${entry.label}: ` : ""}{entry.text}</span><span className="pv-dots" /><span>{entry.page}</span></p>
          ))}
        </div>
      );
    default: return null;
  }
}

function useDocStyle(layout) {
  return useMemo(() => ({
    fontFamily: `"${layout.font || "Times New Roman"}", Georgia, serif`,
    fontSize: `${layout.font_size || 12}pt`,
    lineHeight: layout.line_spacing || 1.5,
    textAlign: layout.justify ? "justify" : "left",
    "--indent": layout.paragraph_indent ? "1.4em" : "0",
    "--gap": layout.paragraph_indent ? "0" : "0.7em",
  }), [layout]);
}

/**
 * Lay the blocks out on pages. Returns pages of { blocks, label, front, physical }.
 * `heights` are the blocks' measured heights (px, paragraph gap included); `measureText(block, room)`
 * splits a paragraph so its first part fits in `room` px ({ head, tail, tailHeight }) or returns null.
 * Nothing is placed past `available`, except a block that can't be split and is taller than a page.
 */
export function paginate(blocks, heights, measureText, available, layout, isBook) {
  const pages = [];
  let current = null;
  let used = 0;
  let mainStarted = !isBook;
  // A paragraph is split only when at least two of its lines fit in the room left.
  const minRoom = 2 * (Number(layout.font_size) || 12) * (96 / 72) * (Number(layout.line_spacing) || 1.5);
  const open = (front) => {
    current = { blocks: [], front, mainStart: false };
    pages.push(current);
    used = 0;
  };
  open(Boolean(blocks[0]?.front));
  blocks.forEach((original, index) => {
    let block = original;
    if (block.breakBefore && current.blocks.length) open(Boolean(block.front));
    if (block.breakBefore && block.odd && pages.length % 2 === 0) {
      // A chapter on an odd page: leave a blank left-hand page.
      current.blank = true;
      open(Boolean(block.front));
    }
    if (!block.front && !mainStarted) {
      if (current.blocks.length) open(false);
      current.mainStart = true;
      mainStarted = true;
    }
    current.front = Boolean(block.front);
    let height = heights[index] || 0;
    const next = heights[index + 1] || 0;
    const isHeading = ["h1", "h2", "chapter-title"].includes(block.type);
    if (isHeading && current.blocks.length && used + height + Math.min(next, 60) > available) {
      open(Boolean(block.front)); // Keep a heading with what follows it.
    }
    // A long paragraph continues over as many pages as it needs.
    for (let guard = 0; used + height > available && guard < 1000; guard += 1) {
      const room = available - used;
      const split = block.type === "p" && room >= minRoom ? measureText(block, room) : null;
      if (split) {
        current.blocks.push({ ...block, text: split.head });
        open(Boolean(block.front));
        block = { ...block, text: split.tail, cont: true, drop: false };
        height = split.tailHeight;
      } else if (current.blocks.length) {
        open(Boolean(block.front));
      } else break; // Taller than a page and can't be split: it goes on a page of its own.
    }
    current.blocks.push(block);
    used += height;
    if (block.breakAfter) open(Boolean(blocks[index + 1]?.front));
  });
  if (pages.length > 1 && !pages[pages.length - 1].blocks.length) pages.pop();
  // Page labels: roman numerals for front matter (if chosen), then numbers from the chosen start.
  const start = Number.isFinite(layout.page_number_start) ? layout.page_number_start : 1;
  let frontCount = 0;
  let main = start - 1;
  pages.forEach((page, i) => {
    page.physical = i + 1;
    if (page.mainStart) main = start - 1;
    if (page.front) {
      frontCount += 1;
      page.label = layout.front_matter_roman ? roman(frontCount) : String(frontCount);
    } else {
      main += 1;
      page.label = String(main);
    }
    page.hideNumber = page.blank || page.blocks.some((b) => ["title-page", "copyright", "dedication"].includes(b.type));
  });
  return pages;
}

export default function Preview({ project, zoom = 0.62, onPages, pagesRef }) {
  const layout = project.options?.layout || {};
  const isBook = project.mode === "book";
  const { blocks } = useMemo(() => buildBlocks(project), [project]);
  const [width, height] = pageSize(layout);
  const contentWidth = (width - layout.margin_inside - layout.margin_outside - (layout.gutter || 0)) * PX;
  // The running header and page number sit in the margins; the text moves in only if a margin is too small for them.
  const place = furniture(layout);
  const available = (height - layout.margin_top - layout.margin_bottom - place.top.push - place.bottom.push) * PX;
  const docStyle = useDocStyle(layout);
  const measurer = useRef(null);
  const probe = useRef(null);
  const [pages, setPages] = useState([]);
  const tocProbe = useMemo(() => blocks.filter((b) => b.toc).map((b) => ({ label: b.label, text: b.text, page: "000" })), [blocks]);

  useLayoutEffect(() => {
    const box = measurer.current;
    if (!box) return;
    const heights = [...box.children].map((child) => child.getBoundingClientRect().height);
    // The probe is a paragraph inside a .pv-doc, styled like the part being measured (first part
    // indented and with its drop capital, continuation not); its gap below is counted too.
    const measureText = (block, room) => {
      const el = probe.current;
      const words = String(block.text || "").split(/\s+/).filter(Boolean);
      if (words.length < 12) return null;
      const heightOf = (text, classes) => {
        el.className = classes;
        el.textContent = text;
        return el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).marginBottom) || 0);
      };
      const headClasses = `pv-p${block.cont ? " cont" : ""}${block.drop ? " drop" : ""}`;
      let low = 1;
      let high = words.length - 1;
      let best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (heightOf(words.slice(0, mid).join(" "), headClasses) <= room) {
          best = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (best < 4 || words.length - best < 3) {
        el.textContent = "";
        return null;
      }
      const tailHeight = heightOf(words.slice(best).join(" "), "pv-p cont");
      el.textContent = "";
      return { head: words.slice(0, best).join(" "), tail: words.slice(best).join(" "), tailHeight };
    };
    const laid = paginate(blocks, heights, measureText, available, layout, isBook);
    setPages(laid);
    onPages?.(laid.length);
  }, [blocks, available, contentWidth, docStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  const toc = useMemo(() => {
    const entries = [];
    pages.forEach((page) => page.blocks.forEach((b) => b.toc && !b.cont && entries.push({ label: b.label, text: b.text, page: page.label })));
    return entries;
  }, [pages]);

  const position = layout.page_number_position || "bottom-center";
  return (
    <div className="pv-wrap" style={{ "--zoom": zoom }}>
      <div className="pv-measure" aria-hidden="true" style={{ ...docStyle, width: `${contentWidth}px` }}>
        <div ref={measurer} className="pv-doc">
          {blocks.map((block, i) => <div key={i} className="pv-cell"><Block block={block} toc={tocProbe} /></div>)}
        </div>
        <div className="pv-doc"><p ref={probe} className="pv-p" /></div>
      </div>
      <div className="pv-pages" ref={pagesRef} data-width={width} data-height={height}>
        {pages.map((page) => {
          const right = page.physical % 2 === 1;
          const inside = `${layout.margin_inside + (layout.gutter || 0)}mm`;
          const outside = `${layout.margin_outside}mm`;
          const mirror = layout.mirror_margins;
          const chapter = page.blocks.find((b) => b.chapter)?.chapter || "";
          const header = layout.running_headers && !page.hideNumber && !page.blocks.some((b) => b.type === "chapter-title")
            ? (right ? chapter : project.draft?.title || project.options?.book_name || "") : "";
          const numberAlign = position.endsWith("center") ? "center" : (right || !mirror ? "right" : "left");
          const showNumber = position !== "none" && !page.hideNumber;
          // With the page number at the top too, the header moves out of its way: centred when the
          // number is in the outside corner, at the outside edge (and kept short) when it is centred.
          const headerAlign = place.numberTop && position === "top-outside" ? "center" : right ? "right" : "left";
          const headerMax = place.numberTop && position === "top-center" ? "40%" : place.numberTop ? "62%" : "100%";
          const left = mirror && !right ? outside : inside;
          const rightEdge = mirror && !right ? inside : outside;
          return (
            <div key={page.physical} className="pv-page" style={{
              width: `${width}mm`, height: `${height}mm`, paddingTop: `${layout.margin_top}mm`, paddingBottom: `${layout.margin_bottom}mm`,
              paddingLeft: left, paddingRight: rightEdge,
            }}>
              {header && (
                <div className="pv-running" style={{ top: `${place.top.offset}mm`, left, right: rightEdge, textAlign: headerAlign, fontFamily: docStyle.fontFamily }}>
                  <span style={{ maxWidth: headerMax }}>{header}</span>
                </div>
              )}
              <div className="pv-doc" style={{ ...docStyle, paddingTop: `${place.top.push}mm` }}>
                {page.blocks.map((block, i) => <div key={i} className="pv-cell"><Block block={block} toc={toc} /></div>)}
              </div>
              {showNumber && (
                <div className="pv-number" style={{
                  [place.numberTop ? "top" : "bottom"]: `${place.numberTop ? place.top.offset : place.bottom.offset}mm`,
                  left, right: rightEdge, textAlign: numberAlign, fontFamily: docStyle.fontFamily,
                }}>{page.label}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Open the laid-out pages in a print window: "Save as PDF" gives exactly what the preview shows. */
export function printPages(pagesElement, title, size) {
  const [width, height] = size;
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) throw new Error("Allow pop-ups for this site to print or save as PDF.");
  const css = [...document.querySelectorAll("style, link[rel=stylesheet]")].map((n) => n.outerHTML).join("\n");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>${css}
<style>@page{size:${width}mm ${height}mm;margin:0}html,body{margin:0;padding:0;background:#fff}.pv-pages{gap:0!important;padding:0!important;transform:none!important}.pv-page{box-shadow:none!important;margin:0!important;break-after:page;page-break-after:always}</style>
</head><body>${pagesElement.outerHTML}</body></html>`);
  win.document.close();
  win.onload = () => setTimeout(() => win.print(), 300);
}
