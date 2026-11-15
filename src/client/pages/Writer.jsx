import { useEffect, useMemo, useRef, useState } from "react";
import { api, uploadImage } from "../api.js";
import { CostCard, ErrorNote, MANUSCRIPT_OPEN_KEY, SuccessNote, announceTask } from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";
import { readProofFile } from "../lib/readfiles.js";
import { FONTS, PAGE_SIZES, STYLES, pageSize } from "../lib/layout.js";
import Preview, { printPages } from "../lib/Preview.jsx";
import { exportDocx, downloadBlob } from "../lib/exportDocx.js";
import { toBibtex, toRis } from "../../shared/render.ts";
import { chartSvg, checkChart, sourceDataCsv, suggestCharts } from "../../shared/charts.ts";
import { readRows } from "../../shared/sheets.ts";

// Manuscript & Book Writer. Choose a manuscript or a book, give the topic, add proof material,
// research published work between two dates (up to 100 titles to pick from), choose a writing
// voice and the page layout, and the AI writes it step by step. Then edit on the left while the
// laid-out pages update on the right, and download Word or print to PDF.

const VOICES = [
  ["ai", "AI-written", "Clear, polished and neutral. Adds a \"Use of generative AI\" statement."],
  ["researcher", "Researcher", "Careful and methodical, claims hedged to the evidence."],
  ["professor", "Professor", "Authoritative and explanatory, links ideas to first principles."],
  ["expert", "Industry expert", "Practical insight and clear recommendations."],
  ["student", "Student", "Simpler sentences, terms explained, modest tone."],
  ["clinician", "Clinician / practitioner", "Focused on real-world decisions and outcomes."],
  ["communicator", "Science communicator", "Plain words for general readers, never sensational."],
];
const ARTICLE_TYPES = {
  original: "Original research article", review: "Review article", systematic_review: "Systematic review / meta-analysis", mini_review: "Mini review",
  case_report: "Case report", short_communication: "Short communication", commentary: "Commentary / perspective", editorial: "Editorial",
  letter: "Letter to the editor", software: "Software / methods paper", study_protocol: "Study protocol", thesis_chapter: "Thesis chapter",
};
const BOOK_TYPES = {
  academic: "Academic monograph", textbook: "Textbook (objectives, summaries, questions)", reference: "Reference handbook",
  guide: "Practical guide", research_summary: "Research compendium", popular: "Popular non-fiction",
};
const STEPS = ["Type", "Topic & details", "Proof material", "Research", "Voice & layout"];
const RESEARCH_MESSAGES = ["Researching…", "Searching published work…", "Reading abstracts…", "Removing duplicates…", "Ranking by relevance…"];
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const defaultLayout = (mode) => (mode === "book"
  ? { page_size: "6x9", margin_top: 20, margin_bottom: 20, margin_inside: 22, margin_outside: 16, gutter: 0, mirror_margins: true, page_number_start: 1, page_number_position: "bottom-outside",
    front_matter_roman: true, font: "Georgia", font_size: 11, line_spacing: 1.4, paragraph_indent: true, chapter_start: "odd-page", running_headers: true, drop_caps: true,
    line_numbers: false, title_page: true, copyright_page: true, toc: true, justify: true }
  : { page_size: "a4", margin_top: 25, margin_bottom: 25, margin_inside: 25, margin_outside: 25, gutter: 0, mirror_margins: false, page_number_start: 1, page_number_position: "bottom-center",
    front_matter_roman: false, font: "Times New Roman", font_size: 12, line_spacing: 2, paragraph_indent: false, chapter_start: "continuous", running_headers: false, drop_caps: false,
    line_numbers: true, title_page: false, copyright_page: false, toc: false, justify: false });

const blankOptions = (mode) => ({
  topic: "", brief: "", voice: "researcher", authors: "", style: mode === "book" ? "apa" : "vancouver", from: "", to: "", layout: defaultLayout(mode),
  ...(mode === "book"
    ? { book_name: "", subtitle: "", publisher: "", edition: "", isbn: "", year: String(new Date().getFullYear()), book_type: "academic", audience: "", chapters: 8, words_per_chapter: 2500,
      preface: true, introduction: false, conclusion: true, glossary: true, learning_objectives: false, key_points: true, chapter_summary: true, review_questions: false,
      case_studies: false, key_terms: true, references_placement: "book", dedication: "" }
    : { type: "original", length: "standard", journal_url: "", figures: "auto", figure_count: 2 }),
});

function Toggle({ label, checked, onChange, note }) {
  return (
    <label className="check">
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} /> {label}
      {note && <span className="muted-text"> · {note}</span>}
    </label>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="wr-num">
      <span>{label}</span>
      <span className="wr-num-row">
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
        {suffix && <small>{suffix}</small>}
      </span>
    </label>
  );
}

export function LayoutPanel({ mode, layout, onChange }) {
  const set = (patch) => onChange({ ...layout, ...patch });
  const custom = layout.page_size === "custom";
  return (
    <div className="wr-layout">
      <div className="two-col">
        <label>Page size
          <select value={custom ? "custom" : layout.page_size} onChange={(e) => set(e.target.value === "custom" ? { page_size: "a4", page_width_mm: 170, page_height_mm: 240 } : { page_size: e.target.value, page_width_mm: 0, page_height_mm: 0 })}>
            {Object.entries(PAGE_SIZES).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>Page numbers
          <select value={layout.page_number_position} onChange={(e) => set({ page_number_position: e.target.value })}>
            <option value="bottom-center">Bottom, centre</option><option value="bottom-outside">Bottom, outside corner</option>
            <option value="top-outside">Top, outside corner</option><option value="top-center">Top, centre</option><option value="none">No page numbers</option>
          </select>
        </label>
      </div>
      <div className="wr-grid4">
        <NumberField label="Width (custom)" value={layout.page_width_mm || ""} min={90} max={300} suffix="mm" onChange={(v) => set({ page_width_mm: v || 0 })} />
        <NumberField label="Height (custom)" value={layout.page_height_mm || ""} min={120} max={420} suffix="mm" onChange={(v) => set({ page_height_mm: v || 0 })} />
        <NumberField label="Page numbers start at" value={layout.page_number_start} min={0} max={9999} onChange={(v) => set({ page_number_start: Number(v) || 0 })} />
        <NumberField label="Font size" value={layout.font_size} min={8} max={16} step={0.5} suffix="pt" onChange={(v) => set({ font_size: v })} />
        <NumberField label="Top margin" value={layout.margin_top} min={5} max={60} suffix="mm" onChange={(v) => set({ margin_top: v })} />
        <NumberField label="Bottom margin" value={layout.margin_bottom} min={5} max={60} suffix="mm" onChange={(v) => set({ margin_bottom: v })} />
        <NumberField label={layout.mirror_margins ? "Inside margin" : "Left margin"} value={layout.margin_inside} min={5} max={60} suffix="mm" onChange={(v) => set({ margin_inside: v })} />
        <NumberField label={layout.mirror_margins ? "Outside margin" : "Right margin"} value={layout.margin_outside} min={5} max={60} suffix="mm" onChange={(v) => set({ margin_outside: v })} />
        <NumberField label="Gutter (binding)" value={layout.gutter} min={0} max={30} suffix="mm" onChange={(v) => set({ gutter: v })} />
        <NumberField label="Line spacing" value={layout.line_spacing} min={1} max={2.5} step={0.05} onChange={(v) => set({ line_spacing: v })} />
        <label className="wr-num"><span>Font</span>
          <select value={layout.font} onChange={(e) => set({ font: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
        {mode === "book" && (
          <label className="wr-num"><span>Chapters start</span>
            <select value={layout.chapter_start} onChange={(e) => set({ chapter_start: e.target.value })}>
              <option value="odd-page">On a right-hand (odd) page</option><option value="new-page">On a new page</option><option value="continuous">Straight after</option>
            </select>
          </label>
        )}
      </div>
      <div className="wr-toggles">
        <Toggle label="Mirror margins (facing pages)" checked={layout.mirror_margins} onChange={(v) => set({ mirror_margins: v })} />
        <Toggle label="Justify text" checked={layout.justify} onChange={(v) => set({ justify: v })} />
        <Toggle label="Indent paragraphs" checked={layout.paragraph_indent} onChange={(v) => set({ paragraph_indent: v })} />
        {mode === "book" ? (
          <>
            <Toggle label="Title page" checked={layout.title_page} onChange={(v) => set({ title_page: v })} />
            <Toggle label="Copyright page" checked={layout.copyright_page} onChange={(v) => set({ copyright_page: v })} />
            <Toggle label="Table of contents" checked={layout.toc} onChange={(v) => set({ toc: v })} />
            <Toggle label="Roman numerals for front matter" checked={layout.front_matter_roman} onChange={(v) => set({ front_matter_roman: v })} />
            <Toggle label="Running headers" checked={layout.running_headers} onChange={(v) => set({ running_headers: v })} />
            <Toggle label="Drop capital at chapter start" checked={layout.drop_caps} onChange={(v) => set({ drop_caps: v })} />
          </>
        ) : <Toggle label="Line numbers in Word (for reviewers)" checked={layout.line_numbers} onChange={(v) => set({ line_numbers: v })} />}
      </div>
    </div>
  );
}

// --- Research ---

function Research({ mode, topic, from, to, onRange, state, setState }) {
  const [message, setMessage] = useState(0);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!state.busy) return undefined;
    const timer = setInterval(() => setMessage((m) => (m + 1) % RESEARCH_MESSAGES.length), 2200);
    return () => clearInterval(timer);
  }, [state.busy]);
  async function search() {
    setState({ ...state, busy: true, error: null });
    try {
      const data = await api("/api/research", { method: "POST", json: { topic, from, to, mode } });
      setState({ busy: false, error: null, id: data.research_id, results: data.results, selected: data.results.slice(0, 25).map((r) => r.id), usage: data.usage });
    } catch (failure) {
      setState({ ...state, busy: false, error: failure });
    }
  }
  const shown = (state.results || []).filter((r) => !filter.trim() || `${r.title} ${r.authors} ${r.venue}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id) => setState({ ...state, selected: state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id] });
  return (
    <div>
      <p className="lead">Search free scholarly sources for published work on your topic. Pick the titles to cite: references are built only from these real records.</p>
      <div className="wr-grid4">
        <label className="wr-num"><span>Published from</span><input type="date" value={from} onChange={(e) => onRange({ from: e.target.value })} /></label>
        <label className="wr-num"><span>Published to</span><input type="date" value={to} onChange={(e) => onRange({ to: e.target.value })} /></label>
        <div className="wr-quick">
          {[["Last 5 years", 5], ["Last 10 years", 10], ["Any time", 0]].map(([label, years]) => (
            <button key={label} type="button" className="chip" onClick={() => onRange(years ? { from: `${new Date().getFullYear() - years}-01-01`, to: new Date().toISOString().slice(0, 10) } : { from: "", to: "" })}>{label}</button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button className="accent" onClick={search} disabled={state.busy || !topic.trim()}>
          <Icon name="globe" /> {state.busy ? RESEARCH_MESSAGES[message] : state.results ? "Search again" : "Search online"}
        </button>
      </div>
      {state.busy && <div className="wr-researching"><span className="job-orb" aria-hidden="true" /> {RESEARCH_MESSAGES[message]}</div>}
      <ErrorNote error={state.error} />
      {state.results && (
        <div className="wr-results">
          <div className="wr-results-head">
            <strong>{state.results.length} titles found · {state.selected.length} selected</strong>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the list" aria-label="Filter the results" />
            <button type="button" className="small" onClick={() => setState({ ...state, selected: [...new Set([...state.selected, ...shown.map((r) => r.id)])] })}>Select shown</button>
            <button type="button" className="small" onClick={() => setState({ ...state, selected: [] })}>Clear</button>
          </div>
          <ol className="wr-result-list">
            {shown.map((r) => (
              <li key={r.id} className={state.selected.includes(r.id) ? "on" : ""}>
                <label className="wr-result">
                  <input type="checkbox" checked={state.selected.includes(r.id)} onChange={() => toggle(r.id)} />
                  <span>
                    <strong>{r.title}</strong>
                    <span className="muted-text">{[r.authors, r.year, r.venue].filter(Boolean).join(" · ")}</span>
                    <span className="wr-tags">
                      {r.kind === "book" && <span className="badge muted">Book</span>}
                      {r.kind === "preprint" && <span className="badge warn">Preprint</span>}
                      {r.open_access && <span className="badge good">Open access</span>}
                      {r.citations > 0 && <span className="badge muted">Cited {r.citations}×</span>}
                      {r.abstract && <button type="button" className="link-button" onClick={(e) => { e.preventDefault(); setOpen(open === r.id ? null : r.id); }}>{open === r.id ? "Hide abstract" : "Abstract"}</button>}
                    </span>
                    {open === r.id && <span className="wr-abstract">{r.abstract}…</span>}
                  </span>
                </label>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// --- Proof material ---

function ProofMaterial({ sources, setSources, extraRefs, setExtraRefs }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [link, setLink] = useState("");
  const [book, setBook] = useState("");
  async function addFiles(files) {
    setError(null);
    for (const file of files) {
      setBusy(`Reading ${file.name}…`);
      try {
        const source = await readProofFile(file);
        setSources((old) => [...old, source]);
      } catch (failure) {
        setError({ message: `${file.name}: ${failure.message}` });
      }
    }
    setBusy("");
  }
  async function addLink(kind) {
    setError(null);
    setBusy(kind === "book" ? "Looking up the book…" : "Reading the page…");
    try {
      const source = await api("/api/sources/read", { method: "POST", json: kind === "book" ? { book } : { url: link.trim() } });
      setSources((old) => [...old, { kind: source.kind, label: source.label, text: source.text, url: source.url }]);
      if (source.reference) setExtraRefs((old) => [...old, source.reference]);
      if (kind === "book") setBook(""); else setLink("");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }
  return (
    <div>
      <p className="lead">Upload your own evidence first: data, drafts, lab notes, PDFs of papers, a thesis, code. The AI treats it as authoritative. This step is optional.</p>
      <label className="wr-drop">
        <Icon name="upload" size={22} />
        <span><strong>Upload proof material</strong><br /><small>PDF, Word (.docx), ZIP, Excel/CSV, text, Markdown or code. Read in your browser; up to 12 files.</small></span>
        <input type="file" multiple hidden accept=".pdf,.docx,.zip,.xlsx,.csv,.tsv,.txt,.md,.tex,.bib,.json,.ipynb,.py,.r,.js,.ts,.html"
          onChange={(e) => { addFiles([...e.target.files]); e.target.value = ""; }} />
      </label>
      <div className="two-col">
        <div>
          <label htmlFor="wr-link">Add a web page or public GitHub repository</label>
          <div className="wr-inline">
            <input id="wr-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… or https://github.com/owner/repo" />
            <button type="button" onClick={() => addLink("url")} disabled={!/^https?:\/\/\S+\.\S+/.test(link.trim()) || Boolean(busy)}>Add</button>
          </div>
        </div>
        <div>
          <label htmlFor="wr-book">Add a book (ISBN or title)</label>
          <div className="wr-inline">
            <input id="wr-book" value={book} onChange={(e) => setBook(e.target.value)} placeholder="978-0-19-… or exact title" />
            <button type="button" onClick={() => addLink("book")} disabled={!book.trim() || Boolean(busy)}>Add</button>
          </div>
        </div>
      </div>
      {busy && <p className="muted-text"><span className="job-orb small" aria-hidden="true" /> {busy}</p>}
      <ErrorNote error={error} />
      {sources.length > 0 && (
        <ul className="wr-sources">
          {sources.map((s, i) => (
            <li key={`${s.label}-${i}`}>
              <span className="badge muted">{s.kind}</span> {s.label} <span className="muted-text">· {s.text.length.toLocaleString()} characters</span>
              <button type="button" className="icon small" aria-label={`Remove ${s.label}`} onClick={() => setSources((old) => old.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      {extraRefs.length > 0 && <p className="field-note">{extraRefs.length} of these will also be cited as references.</p>}
    </div>
  );
}

// --- The editor (left) ---

function autosize(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

function Area({ value, onChange, ...props }) {
  const ref = useRef(null);
  useEffect(() => autosize(ref.current), [value]);
  return <textarea ref={ref} value={value} onChange={(e) => { onChange(e.target.value); autosize(e.target); }} {...props} />;
}

function SectionsEditor({ sections, onChange }) {
  const update = (index, patch) => onChange(sections.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const move = (index, by) => {
    const next = [...sections];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
    onChange(next);
  };
  return (
    <div className="wr-sections">
      {sections.map((section, index) => (
        <div key={index} className={`wr-section level-${section.level || 1}`}>
          <div className="wr-section-head">
            <input value={section.heading} onChange={(e) => update(index, { heading: e.target.value })} aria-label="Heading" placeholder="Heading" />
            <select value={section.level || 1} onChange={(e) => update(index, { level: Number(e.target.value) })} aria-label="Heading level">
              <option value={1}>Heading</option><option value={2}>Subheading</option>
            </select>
            <button type="button" className="icon small" onClick={() => move(index, -1)} aria-label="Move up" disabled={index === 0}>↑</button>
            <button type="button" className="icon small" onClick={() => move(index, 1)} aria-label="Move down" disabled={index === sections.length - 1}>↓</button>
            <button type="button" className="icon small" aria-label="Delete section" onClick={() => window.confirm(`Delete "${section.heading || "this section"}"?`) && onChange(sections.filter((_, i) => i !== index))}><Icon name="trash" size={14} /></button>
          </div>
          <Area value={section.paragraphs.join("\n\n")} rows={4} onChange={(text) => update(index, { paragraphs: text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean) })}
            aria-label={`Text of ${section.heading}`} />
          <button type="button" className="link-button" onClick={() => onChange([...sections.slice(0, index + 1), { heading: "New section", level: section.level || 1, paragraphs: ["[[Write this section]]"] }, ...sections.slice(index + 1)])}>+ Add a section below</button>
        </div>
      ))}
      {!sections.length && <button type="button" onClick={() => onChange([{ heading: "New section", level: 1, paragraphs: ["[[Write this section]]"] }])}>Add a section</button>}
    </div>
  );
}

const lines = (list) => (list || []).join("\n");
const fromLines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function ManuscriptEditor({ draft, setDraft }) {
  return (
    <div className="wr-editor-body">
      <label>Title</label>
      <Area value={draft.title || ""} rows={1} onChange={(title) => setDraft({ ...draft, title })} />
      <div className="two-col">
        <div><label>Running title</label><input value={draft.running_title || ""} onChange={(e) => setDraft({ ...draft, running_title: e.target.value })} /></div>
        <div><label>Keywords (separated by ;)</label><input value={(draft.keywords || []).join("; ")} onChange={(e) => setDraft({ ...draft, keywords: e.target.value.split(";").map((k) => k.trim()).filter(Boolean) })} /></div>
      </div>
      {(draft.abstract || []).length > 0 && <h3 className="wr-h">Abstract</h3>}
      {(draft.abstract || []).map((item, i) => (
        <div key={i} className="wr-abstract-item">
          <input value={item.heading} placeholder="(unstructured)" onChange={(e) => setDraft({ ...draft, abstract: draft.abstract.map((a, j) => (j === i ? { ...a, heading: e.target.value } : a)) })} />
          <Area value={item.text} rows={3} onChange={(text) => setDraft({ ...draft, abstract: draft.abstract.map((a, j) => (j === i ? { ...a, text } : a)) })} />
        </div>
      ))}
      <h3 className="wr-h">Main text</h3>
      <SectionsEditor sections={draft.sections || []} onChange={(sections) => setDraft({ ...draft, sections })} />
      {(draft.tables || []).length > 0 && <h3 className="wr-h">Tables</h3>}
      {(draft.tables || []).map((table, i) => (
        <div key={i} className="wr-table-edit">
          <label>Table {i + 1} caption</label>
          <input value={table.caption} onChange={(e) => setDraft({ ...draft, tables: draft.tables.map((t, j) => (j === i ? { ...t, caption: e.target.value } : t)) })} />
          <label>Cells (one row per line, cells separated by | ; first line is the header)</label>
          <Area value={[table.columns, ...table.rows].map((r) => r.join(" | ")).join("\n")} rows={4} onChange={(text) => {
            const rows = text.split("\n").filter((l) => l.trim()).map((l) => l.split("|").map((c) => c.trim()));
            setDraft({ ...draft, tables: draft.tables.map((t, j) => (j === i ? { ...t, columns: rows[0] || [], rows: rows.slice(1) } : t)) });
          }} />
          <button type="button" className="link-button" onClick={() => setDraft({ ...draft, tables: draft.tables.filter((_, j) => j !== i) })}>Remove this table</button>
        </div>
      ))}
      <h3 className="wr-h">Declarations</h3>
      {(draft.declarations || []).map((item, i) => (
        <div key={i} className="wr-abstract-item">
          <input value={item.heading} onChange={(e) => setDraft({ ...draft, declarations: draft.declarations.map((a, j) => (j === i ? { ...a, heading: e.target.value } : a)) })} />
          <Area value={item.text} rows={2} onChange={(text) => setDraft({ ...draft, declarations: draft.declarations.map((a, j) => (j === i ? { ...a, text } : a)) })} />
        </div>
      ))}
      <button type="button" className="link-button" onClick={() => setDraft({ ...draft, declarations: [...(draft.declarations || []), { heading: "Acknowledgements", text: "[[Acknowledgements]]" }] })}>+ Add a declaration</button>
      {(draft.author_notes || []).length > 0 && (
        <div className="note note-warn"><strong>Before you submit</strong><ul>{draft.author_notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
      )}
    </div>
  );
}

function BookEditor({ project, draft, setDraft, options, setOptions, part, setPart }) {
  const chapters = draft.chapters || [];
  const chapter = typeof part === "number" ? chapters[part] : null;
  const setChapter = (patch) => setDraft({ ...draft, chapters: chapters.map((c, i) => (i === part ? { ...c, ...patch } : c)) });
  return (
    <div className="wr-editor-body">
      <label htmlFor="wr-part">Edit</label>
      <select id="wr-part" value={String(part)} onChange={(e) => setPart(/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>
        <option value="details">Book details (title page)</option>
        <option value="preface">Preface</option>
        <option value="introduction">Introduction</option>
        {chapters.map((c, i) => <option key={i} value={i}>Chapter {i + 1}: {c.title}</option>)}
        <option value="conclusion">Conclusion</option>
        <option value="glossary">Glossary</option>
        <option value="blurb">Back-cover blurb</option>
      </select>
      {part === "details" && (
        <>
          <label>Book name</label><Area rows={1} value={draft.title || ""} onChange={(title) => setDraft({ ...draft, title })} />
          <label>Subtitle</label><Area rows={1} value={draft.subtitle || ""} onChange={(subtitle) => setDraft({ ...draft, subtitle })} />
          <div className="two-col">
            <div><label>Author(s)</label><input value={options.authors || ""} onChange={(e) => setOptions({ authors: e.target.value })} /></div>
            <div><label>Publisher</label><input value={options.publisher || ""} onChange={(e) => setOptions({ publisher: e.target.value })} /></div>
            <div><label>Edition</label><input value={options.edition || ""} onChange={(e) => setOptions({ edition: e.target.value })} placeholder="First" /></div>
            <div><label>ISBN</label><input value={options.isbn || ""} onChange={(e) => setOptions({ isbn: e.target.value })} /></div>
            <div><label>Year</label><input value={options.year || ""} onChange={(e) => setOptions({ year: e.target.value })} /></div>
          </div>
          <label>Dedication</label><Area rows={2} value={options.dedication || ""} onChange={(dedication) => setOptions({ dedication })} />
        </>
      )}
      {["preface", "introduction", "conclusion", "blurb"].includes(part) && (
        <>
          <label>{part === "blurb" ? "Back-cover blurb" : part.charAt(0).toUpperCase() + part.slice(1)} (blank lines separate paragraphs)</label>
          <Area rows={10} value={draft[part] || ""} onChange={(value) => setDraft({ ...draft, [part]: value })} />
        </>
      )}
      {part === "glossary" && (
        <>
          <label>Glossary (one term per line: Term — definition)</label>
          <Area rows={12} value={(draft.glossary || []).map((g) => `${g.term} — ${g.definition}`).join("\n")}
            onChange={(text) => setDraft({ ...draft, glossary: fromLines(text).map((l) => { const [term, ...rest] = l.split(/\s+[—–-]\s+/); return { term: term.trim(), definition: rest.join(" — ").trim() }; }) })} />
        </>
      )}
      {chapter && (
        <>
          <label>Chapter title</label><Area rows={1} value={chapter.title} onChange={(title) => setChapter({ title })} />
          {(project.options.learning_objectives || chapter.objectives?.length > 0) && (
            <><label>Learning objectives (one per line)</label><Area rows={3} value={lines(chapter.objectives)} onChange={(t) => setChapter({ objectives: fromLines(t) })} /></>
          )}
          <h3 className="wr-h">Sections</h3>
          <SectionsEditor sections={chapter.sections || []} onChange={(sections) => setChapter({ sections })} />
          {(chapter.case_study || project.options.case_studies) && (
            <>
              <label>Case study title</label><input value={chapter.case_study?.title || ""} onChange={(e) => setChapter({ case_study: { ...(chapter.case_study || {}), title: e.target.value } })} />
              <label>Case study</label><Area rows={4} value={chapter.case_study?.text || ""} onChange={(text) => setChapter({ case_study: { ...(chapter.case_study || {}), text } })} />
            </>
          )}
          <label>Key points (one per line)</label><Area rows={3} value={lines(chapter.key_points)} onChange={(t) => setChapter({ key_points: fromLines(t) })} />
          <label>Chapter summary</label><Area rows={3} value={chapter.summary || ""} onChange={(summary) => setChapter({ summary })} />
          <label>Review questions (one per line)</label><Area rows={3} value={lines(chapter.questions)} onChange={(t) => setChapter({ questions: fromLines(t) })} />
        </>
      )}
    </div>
  );
}

// --- Figures, review, references ---

function FiguresPanel({ project, onProject, chapter }) {
  const [tab, setTab] = useState("data");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [caption, setCaption] = useState("");
  const [description, setDescription] = useState("");
  const [credit, setCredit] = useState("");
  const [after, setAfter] = useState("");
  const [options, setOptions] = useState([]);
  const [choice, setChoice] = useState(0);
  const sections = project.mode === "book" ? (project.draft?.chapters?.[chapter]?.sections || []) : (project.draft?.sections || []);
  async function add(json) {
    setBusy(true);
    setError(null);
    try {
      onProject(await api(`/api/manuscript/${project.id}/figures`, { method: "POST", json: { caption, after, chapter: project.mode === "book" ? chapter : undefined, ...json } }));
      setCaption("");
      setDescription("");
      setOptions([]);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function readSheet(file) {
    setError(null);
    try {
      const rows = readRows(file.name, new Uint8Array(await file.arrayBuffer()));
      const found = suggestCharts(rows);
      if (!found.length) throw new Error("No numeric columns were found. The first row should hold the column names.");
      setOptions(found);
      setChoice(0);
    } catch (failure) {
      setError({ message: failure.message });
    }
  }
  const remove = async (n) => {
    if (!window.confirm(`Delete Figure ${n}? Later figures are renumbered.`)) return;
    onProject(await api(`/api/manuscript/${project.id}/figures/${n}`, { method: "DELETE" }));
  };
  return (
    <div className="wr-panel">
      {(project.figures || []).length > 0 && (
        <ol className="wr-figure-list">
          {project.figures.map((f) => (
            <li key={f.number}>
              {f.svg ? <span className="wr-thumb" dangerouslySetInnerHTML={{ __html: f.svg }} /> : f.image ? <img className="wr-thumb" src={f.image} alt="" /> : null}
              <span><strong>Figure {f.number}</strong>{project.mode === "book" && Number.isInteger(f.chapter) ? ` · Chapter ${f.chapter + 1}` : ""}<br /><small>{f.caption}</small></span>
              <button type="button" className="icon small" aria-label={`Delete figure ${f.number}`} onClick={() => remove(f.number)}><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ol>
      )}
      <div className="segmented">
        {[["data", "From my data"], ["chart", "Chart from the text"], ["diagram", "Diagram"], ["free", "Free photo"], ["upload", "Upload"]].map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "data" && (
        <>
          <p className="field-note">Upload a spreadsheet (CSV or Excel). The first row names the columns. You get 2–3 suitable chart types, drawn in a journal style with a colour-blind-safe palette.</p>
          <input type="file" accept=".csv,.tsv,.xlsx,.txt" onChange={(e) => e.target.files?.[0] && readSheet(e.target.files[0])} />
          {options.length > 0 && (
            <div className="wr-chart-options">
              {options.map((o, i) => (
                <button key={o.name} type="button" className={`wr-chart-option${choice === i ? " on" : ""}`} onClick={() => setChoice(i)}>
                  <span dangerouslySetInnerHTML={{ __html: chartSvg(checkChart(o.spec, null)) }} />
                  <strong>{o.name}</strong><small>{o.why}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {["chart", "diagram", "free"].includes(tab) && (
        <>
          <label>{tab === "free" ? "What should the photo show?" : `What should the ${tab} show?`}</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tab === "chart" ? "e.g. prevalence by age group (numbers must be in the text)" : tab === "diagram" ? "e.g. the steps of the method" : "e.g. electron microscope"} />
        </>
      )}
      {tab === "upload" && (
        <>
          <label>Image credit and licence</label>
          <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Photo by the authors" />
        </>
      )}
      <label>Caption</label>
      <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Figure legend (optional for charts and diagrams)" />
      <label>Place it after</label>
      <select value={after} onChange={(e) => setAfter(e.target.value)}>
        <option value="">Where it is first mentioned</option>
        {sections.map((s, i) => <option key={i} value={s.heading}>{s.heading}</option>)}
      </select>
      <div className="actions">
        {tab === "data" && options[choice] && (
          <>
            <button className="primary" disabled={busy} onClick={() => add({ source: "data", spec: options[choice].spec, credit: "Drawn from the authors' data." })}>Add this chart</button>
            <button type="button" onClick={() => downloadBlob(new Blob([sourceDataCsv(options[choice].spec)], { type: "text/csv" }), `figure-source-data.csv`)}><Icon name="download" /> Source data (CSV)</button>
          </>
        )}
        {["chart", "diagram", "free"].includes(tab) && <button className="primary" disabled={busy || !description.trim()} onClick={() => add({ source: tab, description })}>{busy ? "Working…" : "Create figure"}</button>}
        {tab === "upload" && (
          <label className="button">
            <Icon name="upload" /> {busy ? "Uploading…" : "Choose image"}
            <input type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={busy || !credit.trim()} onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              try {
                const saved = await uploadImage(file);
                await add({ source: "upload", key: saved.key, credit });
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }} />
          </label>
        )}
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

function ReviewPanel({ project, onProject, onRevise, busy }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const review = project.review;
  async function run() {
    setRunning(true);
    setError(null);
    try {
      onProject(await api(`/api/manuscript/${project.id}/review`, { method: "POST" }));
    } catch (failure) {
      setError(failure);
    } finally {
      setRunning(false);
    }
  }
  return (
    <div className="wr-panel">
      <p className="field-note">Three AI reviewers (harsh but fair, critical, open-minded) score the draft and list concrete fixes you can apply.</p>
      <button onClick={run} disabled={running || busy}><Icon name="sparkles" /> {running ? "Reviewing…" : review ? "Review again" : "Run quality review"}</button>
      <ErrorNote error={error} />
      {review && (
        <div className="wr-review">
          <div className="wr-scores">
            {Object.entries(review.scores).map(([key, value]) => <span key={key} className="wr-score"><strong>{value}</strong>/10<small>{key}</small></span>)}
          </div>
          <p><strong>{review.decision}</strong> · {review.summary}</p>
          {review.placeholders > 0 && <p className="warn-text">{review.placeholders} [[placeholders]] still need your facts.</p>}
          <div className="two-col">
            <div><h4>Strengths</h4><ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
            <div><h4>Weaknesses</h4><ul>{review.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          </div>
          <h4>Fixes</h4>
          <ol>{review.fixes.map((f, i) => (
            <li key={i}><strong>{f.where}:</strong> {f.change} {f.instruction && <button type="button" className="link-button" disabled={busy} onClick={() => onRevise(f.instruction)}>Apply with AI</button>}</li>
          ))}</ol>
          {review.questions.length > 0 && <><h4>Questions for you</h4><ul>{review.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></>}
        </div>
      )}
    </div>
  );
}

function ReferencesPanel({ project }) {
  const refs = project.references || [];
  const name = (project.draft?.title || "references").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 50);
  return (
    <div className="wr-panel">
      <p className="field-note">Cite in the text with the id in square brackets, such as [R3]. The list and numbering are made in the chosen style.</p>
      <div className="actions">
        <button type="button" onClick={() => downloadBlob(new Blob([toBibtex(refs)], { type: "application/x-bibtex" }), `${name}.bib`)}><Icon name="download" /> BibTeX</button>
        <button type="button" onClick={() => downloadBlob(new Blob([toRis(refs)], { type: "application/x-research-info-systems" }), `${name}.ris`)}><Icon name="download" /> RIS (EndNote, Zotero)</button>
      </div>
      <ol className="wr-ref-list">
        {refs.map((r) => (
          <li key={r.id}>
            <button type="button" className="chip" title="Copy the citation" onClick={() => navigator.clipboard?.writeText(`[${r.id}]`)}>{r.id}</button>
            <span>{r.title} <span className="muted-text">({r.year || "n.d."})</span></span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// --- Workspace ---

function Workspace({ initial, onClose }) {
  const [project, setProject] = useState(initial);
  const [draft, setDraftState] = useState(initial.draft);
  const [options, setOptionsState] = useState(initial.options);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState(null);
  const [tool, setTool] = useState("edit");
  const [part, setPart] = useState(initial.mode === "book" ? 0 : null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState("");
  const [zoom, setZoom] = useState(0.62);
  const [pageCount, setPageCount] = useState(0);
  const [previewProject, setPreviewProject] = useState(initial);
  const pagesRef = useRef(null);
  const dirty = useRef(false);
  const isBook = project.mode === "book";

  const setDraft = (next) => {
    dirty.current = true;
    setDraftState(next);
  };
  const setOptions = (patch) => {
    dirty.current = true;
    setOptionsState((old) => ({ ...old, ...patch }));
  };
  const adopt = (data) => {
    setProject(data);
    setDraftState(data.draft);
    setOptionsState(data.options);
    dirty.current = false;
  };

  // The preview follows edits after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setPreviewProject({ ...project, draft, options }), 350);
    return () => clearTimeout(timer);
  }, [draft, options, project]);

  // Autosave.
  useEffect(() => {
    if (!dirty.current) return undefined;
    setSaving("Unsaved changes");
    const timer = setTimeout(async () => {
      setSaving("Saving…");
      try {
        const data = await api(`/api/manuscript/${project.id}`, { method: "PUT", json: {
          draft, layout: options.layout, style: options.style,
          ...Object.fromEntries(["authors", "publisher", "edition", "isbn", "year", "dedication", "book_name", "subtitle"].map((k) => [k, options[k] ?? ""])),
        } });
        setProject((old) => ({ ...old, word_count: data.word_count, updated_at: data.updated_at }));
        dirty.current = false;
        setSaving("Saved");
      } catch (failure) {
        setSaving("Not saved");
        setError(failure);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [draft, options]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reviseWith(text) {
    setBusy("revise");
    setError(null);
    try {
      adopt(await api(`/api/manuscript/${project.id}/revise`, { method: "POST", json: { instruction: text, chapter: typeof part === "number" ? part : 0 } }));
      setInstruction("");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }
  async function undo() {
    try {
      adopt(await api(`/api/manuscript/${project.id}/undo`, { method: "POST" }));
    } catch (failure) {
      setError(failure);
    }
  }
  async function downloadWord() {
    setBusy("docx");
    setError(null);
    try {
      const blob = await exportDocx({ ...project, draft, options });
      downloadBlob(blob, `${(draft.title || "document").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60)}.docx`);
    } catch (failure) {
      setError({ message: `The Word file couldn't be made: ${failure.message}` });
    } finally {
      setBusy("");
    }
  }
  function print() {
    try {
      printPages(pagesRef.current, draft.title || "Document", pageSize(options.layout));
    } catch (failure) {
      setError({ message: failure.message });
    }
  }
  const words = useMemo(() => {
    const count = (sections) => (sections || []).reduce((n, s) => n + s.paragraphs.join(" ").split(/\s+/).filter(Boolean).length, 0);
    return isBook ? (draft.chapters || []).reduce((n, c) => n + count(c.sections), 0) : count(draft.sections);
  }, [draft, isBook]);

  return (
    <div className="wr-workspace">
      <div className="wr-toolbar card">
        <button type="button" onClick={onClose}><Icon name="list" /> Projects</button>
        <strong className="wr-doc-name">{draft.title || "Untitled"}</strong>
        <span className="muted-text">{words.toLocaleString()} words · {pageCount} pages · {saving || "Saved"}</span>
        <span className="spacer" />
        <label className="wr-inline-label">Citation style
          <select value={options.style} onChange={(e) => setOptions({ style: e.target.value })}>{Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <button type="button" onClick={downloadWord} disabled={busy === "docx"}><Icon name="download" /> {busy === "docx" ? "Making…" : "Word"}</button>
        <button type="button" onClick={print}><Icon name="doc" /> Print / PDF</button>
      </div>
      <ErrorNote error={error} />
      {project.warnings?.length > 0 && <div className="note note-warn"><ul>{project.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      <div className="wr-split">
        <div className="wr-left card">
          <div className="segmented wr-tools">
            {[["edit", "Edit"], ["layout", isBook ? "Book layout" : "Page layout"], ["ai", "Revise with AI"], ["figures", "Figures"], ["review", "Quality review"], ["refs", "References"]].map(([key, label]) => (
              <button key={key} type="button" className={tool === key ? "on" : ""} onClick={() => setTool(key)}>{label}</button>
            ))}
          </div>
          {tool === "edit" && (isBook
            ? <BookEditor project={project} draft={draft} setDraft={setDraft} options={options} setOptions={setOptions} part={part} setPart={setPart} />
            : <ManuscriptEditor draft={draft} setDraft={setDraft} />)}
          {tool === "layout" && <LayoutPanel mode={project.mode} layout={options.layout} onChange={(layout) => setOptions({ layout })} />}
          {tool === "ai" && (
            <div className="wr-panel">
              {isBook && (
                <>
                  <label>Chapter to revise</label>
                  <select value={typeof part === "number" ? part : 0} onChange={(e) => setPart(Number(e.target.value))}>
                    {(draft.chapters || []).map((c, i) => <option key={i} value={i}>Chapter {i + 1}: {c.title}</option>)}
                  </select>
                </>
              )}
              <label htmlFor="wr-instruction">What should change?</label>
              <Area id="wr-instruction" rows={3} value={instruction} onChange={setInstruction} placeholder="e.g. Expand the discussion of limitations and compare with the 2021 trials" />
              <div className="chips">
                {["Make it more concise", "Strengthen the argument with more citations", "Simplify the language for students", "Add a section on limitations", "Improve transitions between paragraphs"].map((chip) => (
                  <button key={chip} type="button" className="chip" onClick={() => setInstruction(chip)}>{chip}</button>
                ))}
              </div>
              <div className="actions">
                <button className="accent" disabled={!instruction.trim() || Boolean(busy)} onClick={() => reviseWith(instruction)}><Icon name="wand" /> {busy === "revise" ? "Revising… (up to a minute)" : "Revise"}</button>
                {project.can_undo && <button onClick={undo} disabled={Boolean(busy)}>Undo last revision</button>}
              </div>
              {project.revisions?.length > 0 && <ul className="wr-revisions">{project.revisions.slice().reverse().map((r, i) => <li key={i}>{r.note} <span className="muted-text">{r.at ? new Date(r.at).toLocaleString() : ""}</span></li>)}</ul>}
            </div>
          )}
          {tool === "figures" && <FiguresPanel project={{ ...project, draft }} onProject={adopt} chapter={typeof part === "number" ? part : 0} />}
          {tool === "review" && <ReviewPanel project={project} onProject={(data) => setProject(data)} onRevise={(text) => { setTool("ai"); reviseWith(text); }} busy={Boolean(busy)} />}
          {tool === "refs" && <ReferencesPanel project={project} />}
          <CostCard runs={project.usage} title="AI cost for this project" />
        </div>
        <div className="wr-right">
          <div className="wr-zoom">
            <button type="button" className="icon small" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" className="icon small" onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
          </div>
          <Preview project={previewProject} zoom={zoom} onPages={setPageCount} pagesRef={pagesRef} />
        </div>
      </div>
    </div>
  );
}

// --- The page ---

export default function Writer({ me, active }) {
  const [view, setView] = useState("start");
  const [mode, setMode] = useState("manuscript");
  const [step, setStep] = useState(0);
  const [options, setOptions] = useState(blankOptions("manuscript"));
  const [sources, setSources] = useState([]);
  const [extraRefs, setExtraRefs] = useState([]);
  const [research, setResearch] = useState({ busy: false });
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const set = (patch) => setOptions((old) => ({ ...old, ...patch }));

  const loadProjects = () => api("/api/manuscripts").then(setProjects).catch(setError);
  useEffect(() => {
    if (!active) return;
    loadProjects();
    let wanted = null;
    try {
      wanted = sessionStorage.getItem(MANUSCRIPT_OPEN_KEY);
      sessionStorage.removeItem(MANUSCRIPT_OPEN_KEY);
    } catch { /* storage off */ }
    if (wanted) open(wanted);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  function start(kind) {
    setMode(kind);
    setOptions(blankOptions(kind));
    setSources([]);
    setExtraRefs([]);
    setResearch({ busy: false });
    setStep(1);
    setView("wizard");
    setError(null);
  }

  async function open(id) {
    setError(null);
    try {
      const data = await api(`/api/manuscript/${id}`);
      setProject(data);
      setView(data.status === "ready" ? "workspace" : "writing");
      if (data.status !== "ready") follow(data);
    } catch (failure) {
      setError(failure);
    }
  }

  async function follow(current) {
    announceTask("/manuscript", "running");
    let data = current;
    let retries = 0;
    try {
      while (data.status === "writing") {
        data = await api(`/api/manuscript/${data.id}/step`, { method: "POST" });
        // Google's models are sometimes briefly overloaded: wait and carry on from the same step.
        if (data.status === "failed" && retries < 3 && /busy|high demand|overloaded|try again|rate limit|quota|503|429/i.test(`${data.error} ${data.hint}`)) {
          retries += 1;
          setProject({ ...data, status: "writing", progress: { ...data.progress, label: `The AI is busy, trying again in ${10 * retries} seconds (${retries} of 3)` } });
          await wait(10_000 * retries);
          data = { ...data, status: "writing" };
          continue;
        }
        if (data.status === "writing") retries = 0;
        setProject(data);
        if (data.status === "writing") await wait(400);
      }
      if (data.status === "ready") {
        setView("workspace");
        setNotice(data.mode === "book" ? "Your book is written. Edit it on the left; the pages update on the right." : "Your manuscript is written. Edit it on the left; the pages update on the right.");
        loadProjects();
      }
    } catch (failure) {
      setError(failure);
    } finally {
      announceTask("/manuscript", "done");
    }
  }

  async function write() {
    setError(null);
    try {
      const data = await api("/api/manuscripts", { method: "POST", json: {
        mode, options: { ...options, style_chosen: true }, sources, research_id: research.id, selected: research.selected || [], extra_references: extraRefs,
      } });
      setProject(data);
      setView("writing");
      follow(data);
    } catch (failure) {
      setError(failure);
    }
  }

  async function remove(item) {
    if (!window.confirm(`Delete "${item.title}"? This can't be undone.`)) return;
    await api(`/api/manuscript/${item.id}`, { method: "DELETE" }).catch(setError);
    loadProjects();
  }

  const canNext = step === 1 ? Boolean(options.topic.trim()) : true;
  const selectedCount = research.selected?.length || 0;
  const noGemini = !me.services.gemini;

  if (view === "workspace" && project) {
    return <Workspace key={project.id} initial={project} onClose={() => { setView("start"); loadProjects(); }} />;
  }

  return (
    <section>
      <PageHeader eyebrow="Manuscript & Book Writer" title={view === "writing" ? "Writing…" : "Write a manuscript or a book"}
        lead="Research real published work, add your own evidence, choose the voice and the page layout. The AI writes it step by step; then you edit it beside a live, page-by-page preview." />
      {noGemini && <p className="note note-warn">Writing needs the Gemini key on this server. Ask your administrator to set GEMINI_API_KEY.</p>}
      <ErrorNote error={error} />
      <SuccessNote>{notice}</SuccessNote>

      {view === "writing" && project && (
        <div className="card job-card" role="status" aria-live="polite">
          <div className="job-head">
            <span className="job-orb" aria-hidden="true" />
            <div>
              <h2>{project.mode === "book" ? "Writing your book" : "Writing your manuscript"}</h2>
              <p className="muted-text">{project.status === "failed" ? "Stopped." : `${project.progress.label || "Working"}…`}</p>
            </div>
          </div>
          <div className="wr-progress"><span style={{ width: `${Math.round((100 * project.progress.done) / Math.max(1, project.progress.total))}%` }} /></div>
          <p className="muted-text">Step {Math.min(project.progress.done + 1, project.progress.total)} of {project.progress.total}. Keep this page open: each step takes 10–40 seconds. You can use other pages meanwhile.</p>
          {project.status === "failed" && (
            <>
              <ErrorNote error={{ message: project.error, hint: project.hint }} />
              <div className="actions"><button className="primary" onClick={() => follow({ ...project, status: "writing" })}>Continue writing</button></div>
            </>
          )}
          <CostCard runs={project.usage} title="AI cost so far" />
        </div>
      )}

      {view === "start" && (
        <>
          <div className="wr-kinds">
            <button type="button" className="wr-kind card" onClick={() => start("manuscript")}>
              <Icon name="doc" size={30} />
              <strong>Manuscript</strong>
              <span>A journal article: original research, review, case report and more, following a target journal's rules.</span>
            </button>
            <button type="button" className="wr-kind card" onClick={() => start("book")}>
              <Icon name="list" size={30} />
              <strong>Book</strong>
              <span>A full book with chapters, preface, glossary and references, with your page size, margins and page numbering.</span>
            </button>
          </div>
          <div className="card">
            <h2>Your projects</h2>
            {projects === null ? <p className="muted-text">Loading…</p> : projects.manuscripts.length === 0 ? <p className="muted-text">Nothing yet. Projects are kept {projects.keep_days} days after their last change.</p> : (
              <ul className="wr-projects">
                {projects.manuscripts.map((m) => (
                  <li key={m.id}>
                    <span className="badge muted">{m.mode === "book" ? "Book" : "Manuscript"}</span>
                    <button type="button" className="link-button" onClick={() => open(m.id)}>{m.title || "Untitled"}</button>
                    <span className="muted-text">{m.status === "ready" ? `${m.word_count.toLocaleString()} words` : m.status} · {new Date(m.updated_at).toLocaleDateString()}</span>
                    <button type="button" className="icon small" aria-label={`Delete ${m.title}`} onClick={() => remove(m)}><Icon name="trash" size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {view === "wizard" && (
        <div className="card">
          <ol className="wr-steps">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? "active" : index < step ? "done" : ""}>
                <button type="button" disabled={index === 0 || (index > 1 && !options.topic.trim())} onClick={() => setStep(index)}>{index + 1}. {label}</button>
              </li>
            ))}
          </ol>

          {step === 1 && (
            <div>
              <div className="segmented">
                <button type="button" className={mode === "manuscript" ? "on" : ""} onClick={() => start("manuscript")}>Manuscript</button>
                <button type="button" className={mode === "book" ? "on" : ""} onClick={() => start("book")}>Book</button>
              </div>
              <label htmlFor="wr-topic">{mode === "book" ? "What is the book about?" : "What is the manuscript about?"}</label>
              <textarea id="wr-topic" rows={3} value={options.topic} onChange={(e) => set({ topic: e.target.value })}
                placeholder={mode === "book" ? "e.g. Antimicrobial resistance in South Asia: causes, surveillance and stewardship" : "e.g. Effect of vitamin D supplementation on glycaemic control in type 2 diabetes"} />
              <label htmlFor="wr-brief">Anything else the AI should know? (optional)</label>
              <textarea id="wr-brief" rows={3} value={options.brief} onChange={(e) => set({ brief: e.target.value })} placeholder="Your angle, key findings, the argument, what to include or avoid" />
              <label htmlFor="wr-authors">Author(s)</label>
              <input id="wr-authors" value={options.authors} onChange={(e) => set({ authors: e.target.value })} placeholder="e.g. A. Kumar, B. Singh" />
              {mode === "manuscript" ? (
                <div className="two-col">
                  <label>Article type<select value={options.type} onChange={(e) => set({ type: e.target.value })}>{Object.entries(ARTICLE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  <label>Length<select value={options.length} onChange={(e) => set({ length: e.target.value })}><option value="short">Short (1,500–2,500 words)</option><option value="standard">Standard (3,000–4,500)</option><option value="long">Long (5,000–7,000)</option></select></label>
                  <label className="span2">Target journal's web page or author guidelines (optional)
                    <input value={options.journal_url} onChange={(e) => set({ journal_url: e.target.value })} placeholder="https://journal.example.org/authors" />
                  </label>
                </div>
              ) : (
                <>
                  <div className="two-col">
                    <label>Book name<input value={options.book_name} onChange={(e) => set({ book_name: e.target.value })} placeholder="Leave blank to let the AI suggest one" /></label>
                    <label>Subtitle<input value={options.subtitle} onChange={(e) => set({ subtitle: e.target.value })} /></label>
                    <label>Kind of book<select value={options.book_type} onChange={(e) => set({ book_type: e.target.value })}>{Object.entries(BOOK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    <label>Readers<input value={options.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="e.g. postgraduate students and clinicians" /></label>
                    <label>Publisher<input value={options.publisher} onChange={(e) => set({ publisher: e.target.value })} /></label>
                    <label>ISBN (optional)<input value={options.isbn} onChange={(e) => set({ isbn: e.target.value })} /></label>
                  </div>
                  <div className="wr-grid4">
                    <NumberField label="Chapters" value={options.chapters} min={3} max={20} onChange={(v) => set({ chapters: v })} />
                    <NumberField label="Words per chapter" value={options.words_per_chapter} min={800} max={5000} step={100} onChange={(v) => set({ words_per_chapter: v })} />
                  </div>
                  <div className="wr-toggles">
                    <Toggle label="Preface" checked={options.preface} onChange={(v) => set({ preface: v })} />
                    <Toggle label="Introduction" checked={options.introduction} onChange={(v) => set({ introduction: v })} />
                    <Toggle label="Concluding chapter" checked={options.conclusion} onChange={(v) => set({ conclusion: v })} />
                    <Toggle label="Glossary" checked={options.glossary} onChange={(v) => set({ glossary: v })} />
                    <Toggle label="Learning objectives" checked={options.learning_objectives} onChange={(v) => set({ learning_objectives: v })} />
                    <Toggle label="Key points" checked={options.key_points} onChange={(v) => set({ key_points: v })} />
                    <Toggle label="Chapter summaries" checked={options.chapter_summary} onChange={(v) => set({ chapter_summary: v })} />
                    <Toggle label="Review questions" checked={options.review_questions} onChange={(v) => set({ review_questions: v })} />
                    <Toggle label="Case studies" checked={options.case_studies} onChange={(v) => set({ case_studies: v })} />
                    <Toggle label="References after each chapter" checked={options.references_placement === "chapter"} onChange={(v) => set({ references_placement: v ? "chapter" : "book" })} />
                  </div>
                  <label>Dedication (optional)<input value={options.dedication} onChange={(e) => set({ dedication: e.target.value })} /></label>
                </>
              )}
            </div>
          )}
          {step === 2 && <ProofMaterial sources={sources} setSources={setSources} extraRefs={extraRefs} setExtraRefs={setExtraRefs} />}
          {step === 3 && <Research mode={mode} topic={options.topic} from={options.from} to={options.to} onRange={set} state={research} setState={setResearch} />}
          {step === 4 && (
            <div>
              <label>Writing voice</label>
              <div className="wr-voices">
                {VOICES.map(([key, label, note]) => (
                  <button key={key} type="button" className={`wr-voice${options.voice === key ? " on" : ""}`} onClick={() => set({ voice: key })}>
                    <strong>{label}</strong><small>{note}</small>
                  </button>
                ))}
              </div>
              <div className="two-col">
                <label>Citation style<select value={options.style} onChange={(e) => set({ style: e.target.value })}>{Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                {mode === "manuscript" && (
                  <label>Figures<select value={options.figures} onChange={(e) => set({ figures: e.target.value })}>
                    <option value="auto">Charts, diagrams and free photos</option><option value="charts">Only charts and diagrams</option><option value="free">Only openly licensed photos</option><option value="none">No figures</option>
                  </select></label>
                )}
              </div>
              <h3 className="wr-h">{mode === "book" ? "Book layout" : "Page layout"}</h3>
              <LayoutPanel mode={mode} layout={options.layout} onChange={(layout) => set({ layout })} />
              <div className="note">
                <strong>Ready to write.</strong> {selectedCount} researched title{selectedCount === 1 ? "" : "s"} selected, {sources.length} file{sources.length === 1 ? "" : "s"} or link{sources.length === 1 ? "" : "s"} of proof material.
                {mode === "book" ? ` About ${(options.chapters * options.words_per_chapter).toLocaleString()} words in ${options.chapters} chapters.` : ""}
                {selectedCount === 0 && sources.length === 0 && " Add research or proof material first, so the text has real evidence."}
              </div>
            </div>
          )}

          <div className="actions wr-nav">
            <button type="button" onClick={() => (step <= 1 ? setView("start") : setStep(step - 1))}>Back</button>
            {step < 4 && <button type="button" className="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>{step === 3 && !research.results ? "Skip research" : "Next"}</button>}
            {step === 4 && <button type="button" className="accent" disabled={noGemini || (!selectedCount && !sources.length && !options.brief.trim())} onClick={write}><Icon name="sparkles" /> Write the {mode}</button>}
          </div>
          <CostCard runs={[research.usage].filter(Boolean)} title="AI cost so far" />
        </div>
      )}
    </section>
  );
}
