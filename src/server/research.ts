import { env } from "./env";
import { USER_AGENT } from "./web";

// Finds real published works on a topic, between two dates, in free scholarly services: PubMed,
// Europe PMC, Crossref, Semantic Scholar, OpenAlex, arXiv, DOAJ and Open Library (books). The
// page only says "Researching": it never shows which service a result came from. Results are
// merged, de-duplicated by DOI and title, and ranked by relevance.

export interface Work {
  id?: string; kind: string; title: string; authors: { family: string; given: string }[]; journal: string; publisher?: string;
  year: string; month?: number; volume?: string; issue?: string; pages?: string; doi: string; url: string; isbn?: string;
  abstract: string; open_access?: boolean; citations?: number;
}

const TAGS = /<[^>]+>/g;
const ORG = /\b(university|association|department|institute|faculty|college|ministry|society|organi[sz]ation|council|hospital|inc|ltd|llc|gmbh|network|group|committee|consortium)\b|\//i;
const tidy = (v: unknown, n = 400) => String(v ?? "").replace(TAGS, " ").split(/\s+/).filter(Boolean).join(" ").slice(0, n);

function person(name: string) {
  const clean = name.split(/\s+/).join(" ").trim();
  if (clean.includes(",")) {
    const [family, given] = clean.split(",", 2);
    return { family: family.trim().slice(0, 80), given: given.trim().slice(0, 80) };
  }
  const parts = clean.split(" ");
  return { family: parts[parts.length - 1].slice(0, 80), given: parts.slice(0, -1).join(" ").slice(0, 80) };
}

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 12_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export interface Range { from: string; to: string }
const yearOf = (date: string) => (/^\d{4}/.exec(date || "")?.[0] || "");
const isoDay = (date: string, end: boolean) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  if (/^\d{4}$/.test(date)) return end ? `${date}-12-31` : `${date}-01-01`;
  return "";
};

async function pubmed(query: string, range: Range, rows: number): Promise<Work[]> {
  const key = env("NCBI_API_KEY") ? `&api_key=${encodeURIComponent(env("NCBI_API_KEY"))}` : "";
  const dates = range.from || range.to
    ? `&datetype=pdat&mindate=${(isoDay(range.from, false) || "1800-01-01").replace(/-/g, "/")}&maxdate=${(isoDay(range.to, true) || "3000-12-31").replace(/-/g, "/")}` : "";
  const search = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${rows}&term=${encodeURIComponent(query)}${dates}${key}`);
  const ids: string[] = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const summary = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}${key}`);
  const result = summary?.result || {};
  return ids.map((id) => result[id]).filter(Boolean).map((item: any): Work => {
    const doi = (item.articleids || []).find((a: any) => a.idtype === "doi")?.value || "";
    return {
      kind: "article", title: tidy(item.title).replace(/\.$/, ""), authors: (item.authors || []).filter((a: any) => a.authtype === "Author").slice(0, 30).map((a: any) => {
        const [family, ...rest] = String(a.name || "").split(" ");
        return { family, given: rest.join(" ") };
      }),
      journal: tidy(item.fulljournalname || item.source, 200), year: yearOf(item.pubdate || ""), volume: item.volume || "", issue: item.issue || "", pages: item.pages || "",
      doi, url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${item.uid}/`, abstract: "",
    };
  });
}

async function europePmc(query: string, range: Range, rows: number): Promise<Work[]> {
  const dates = range.from || range.to ? ` AND FIRST_PDATE:[${isoDay(range.from, false) || "1800-01-01"} TO ${isoDay(range.to, true) || "3000-12-31"}]` : "";
  const data = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`(${query}) AND HAS_ABSTRACT:y AND NOT SRC:PPR${dates}`)}&format=json&resultType=core&pageSize=${rows}`);
  return (data?.resultList?.result || []).map((item: any): Work | null => {
    const doi = String(item.doi || "");
    const pmid = String(item.pmid || "");
    if (!item.title || !(doi || pmid)) return null;
    const authors = (item.authorList?.author || []).slice(0, 30).map((p: any) => (p.lastName ? { family: p.lastName, given: p.firstName || p.initials || "" } : { family: p.collectiveName || "", given: "" })).filter((a: any) => a.family);
    return {
      kind: "article", title: tidy(item.title).replace(/\.$/, ""), authors, journal: tidy(item.journalInfo?.journal?.title, 200), year: String(item.pubYear || ""),
      volume: item.journalInfo?.volume || "", issue: item.journalInfo?.issue || "", pages: item.pageInfo || "", doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, abstract: tidy(item.abstractText, 1200),
      open_access: item.isOpenAccess === "Y", citations: Number(item.citedByCount) || 0,
    };
  }).filter(Boolean) as Work[];
}

function crossrefItem(item: any): Work | null {
  const title = tidy((item.title || []).join(" "));
  const doi = String(item.DOI || "");
  if (!title || !doi) return null;
  const parts = item.issued?.["date-parts"]?.[0] || [];
  const kind = ["book", "monograph", "edited-book", "reference-book"].includes(item.type) ? "book" : item.type === "posted-content" ? "preprint" : "article";
  const authors = (item.author || []).filter((p: any) => p.family && !ORG.test(`${p.family} ${p.given || ""}`)).slice(0, 30)
    .map((p: any) => ({ family: String(p.family).replace(/^(dr|prof)\.\s*/i, ""), given: String(p.given || "").replace(/^(dr|prof)\.?\s*/i, "") }));
  return {
    kind, title, authors, journal: kind === "book" ? "" : tidy((item["container-title"] || [""])[0], 200), publisher: kind === "book" ? tidy(item.publisher, 200) : "",
    year: parts[0] ? String(parts[0]) : "", month: Number.isInteger(parts[1]) ? parts[1] : 0, volume: String(item.volume || ""), issue: String(item.issue || ""),
    pages: String(item.page || ""), doi, url: `https://doi.org/${doi}`, isbn: (item.ISBN || [])[0] || "",
    abstract: tidy(item.abstract, 1200).replace(/^(abstract|summary)\s*/i, ""), citations: Number(item["is-referenced-by-count"]) || 0,
  };
}

async function crossref(query: string, range: Range, rows: number, books = false): Promise<Work[]> {
  const filters = [books ? "type:book,type:monograph,type:edited-book,type:reference-book" : "type:journal-article"];
  if (range.from) filters.push(`from-pub-date:${isoDay(range.from, false)}`);
  if (range.to) filters.push(`until-pub-date:${isoDay(range.to, true)}`);
  const data = await getJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&filter=${filters.join(",")}&select=DOI,title,author,issued,container-title,volume,issue,page,abstract,type,ISBN,publisher,is-referenced-by-count`);
  return (data?.message?.items || []).map(crossrefItem).filter(Boolean) as Work[];
}

async function semanticScholar(query: string, range: Range, rows: number): Promise<Work[]> {
  const years = range.from || range.to ? `&year=${yearOf(range.from) || ""}-${yearOf(range.to) || ""}` : "";
  const headers: Record<string, string> = env("SEMANTIC_SCHOLAR_API_KEY") ? { "x-api-key": env("SEMANTIC_SCHOLAR_API_KEY") } : {};
  const data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${rows}${years}&fields=title,abstract,year,authors,venue,externalIds,citationCount,isOpenAccess,url,publicationTypes,journal`, headers);
  return (data?.data || []).map((item: any): Work | null => {
    if (!item.title) return null;
    const doi = item.externalIds?.DOI || "";
    return {
      kind: (item.publicationTypes || []).includes("Book") ? "book" : "article", title: tidy(item.title), authors: (item.authors || []).slice(0, 30).map((a: any) => person(a.name || "")),
      journal: tidy(item.journal?.name || item.venue, 200), year: item.year ? String(item.year) : "", volume: item.journal?.volume || "", pages: (item.journal?.pages || "").trim(),
      doi, url: doi ? `https://doi.org/${doi}` : item.url || "", abstract: tidy(item.abstract, 1200), open_access: Boolean(item.isOpenAccess), citations: Number(item.citationCount) || 0,
    };
  }).filter(Boolean) as Work[];
}

function invertedAbstract(index: Record<string, number[]> | null) {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return tidy(words.join(" "), 1200);
}

async function openAlex(query: string, range: Range, rows: number): Promise<Work[]> {
  const filters = [range.from ? `from_publication_date:${isoDay(range.from, false)}` : "", range.to ? `to_publication_date:${isoDay(range.to, true)}` : ""].filter(Boolean);
  const mail = env("OPENALEX_EMAIL") ? `&mailto=${encodeURIComponent(env("OPENALEX_EMAIL"))}` : "";
  const data = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${rows}${filters.length ? `&filter=${filters.join(",")}` : ""}${mail}`);
  return (data?.results || []).map((item: any): Work | null => {
    if (!item.title) return null;
    const doi = String(item.doi || "").replace(/^https?:\/\/doi\.org\//, "");
    const kind = item.type === "book" || item.type === "book-chapter" ? "book" : item.type === "preprint" ? "preprint" : "article";
    return {
      kind, title: tidy(item.title), authors: (item.authorships || []).slice(0, 30).map((a: any) => person(a.author?.display_name || "")).filter((a: any) => a.family),
      journal: venueName(tidy(item.primary_location?.source?.display_name, 200)), publisher: kind === "book" ? tidy(item.primary_location?.source?.host_organization_name, 200) : "",
      year: item.publication_year ? String(item.publication_year) : "", volume: item.biblio?.volume || "", issue: item.biblio?.issue || "",
      pages: [item.biblio?.first_page, item.biblio?.last_page].filter(Boolean).join("-"), doi, url: doi ? `https://doi.org/${doi}` : item.id || "",
      abstract: invertedAbstract(item.abstract_inverted_index), open_access: Boolean(item.open_access?.is_oa), citations: Number(item.cited_by_count) || 0,
    };
  }).filter(Boolean) as Work[];
}

async function arxiv(query: string, range: Range, rows: number): Promise<Work[]> {
  const words = query.replace(/[^\w\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 8).map((w) => `all:${w}`).join("+AND+");
  if (!words) return [];
  const from = (isoDay(range.from, false) || "1991-01-01").replace(/-/g, "");
  const to = (isoDay(range.to, true) || "2999-12-31").replace(/-/g, "");
  const xml = await getText(`https://export.arxiv.org/api/query?search_query=${words}+AND+submittedDate:[${from}0000+TO+${to}2359]&max_results=${rows}&sortBy=relevance`);
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map((entry): Work => {
    const tag = (name: string) => tidy(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] || "", 1200);
    const id = tag("id");
    const doi = /<arxiv:doi[^>]*>([^<]+)</.exec(entry)?.[1] || "";
    return {
      kind: "preprint", title: tag("title"), authors: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 30).map((m) => person(m[1])),
      journal: "arXiv", year: tag("published").slice(0, 4), doi, url: doi ? `https://doi.org/${doi}` : id, abstract: tag("summary"), open_access: true,
    };
  }).filter((w) => w.title);
}

async function doaj(query: string, range: Range, rows: number): Promise<Work[]> {
  let q = query.replace(/[^\w\s-]/g, " ").split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
  if (!q) return [];
  if (range.from || range.to) q += ` AND bibjson.year:[${yearOf(range.from) || "1800"} TO ${yearOf(range.to) || "3000"}]`;
  const data = await getJson(`https://doaj.org/api/search/articles/${encodeURIComponent(q)}?pageSize=${rows}`);
  return (data?.results || []).map((item: any): Work | null => {
    const bib = item.bibjson || {};
    const doi = (bib.identifier || []).find((i: any) => i.type === "doi")?.id || "";
    const link = (bib.link || []).find((l: any) => l.url)?.url || "";
    if (!bib.title || !(doi || link)) return null;
    return {
      kind: "article", title: tidy(bib.title).replace(/\.$/, ""), authors: (bib.author || []).filter((a: any) => a.name && !ORG.test(a.name)).slice(0, 30).map((a: any) => person(a.name)),
      journal: tidy(bib.journal?.title, 200), year: String(bib.year || ""), volume: bib.journal?.volume || "", issue: bib.journal?.number || "",
      pages: [bib.start_page, bib.end_page].filter(Boolean).join("-"), doi, url: doi ? `https://doi.org/${doi}` : link, abstract: tidy(bib.abstract, 1200), open_access: true,
    };
  }).filter(Boolean) as Work[];
}

async function openLibrary(query: string, range: Range, rows: number): Promise<Work[]> {
  const years = range.from || range.to ? ` first_publish_year:[${yearOf(range.from) || "1500"} TO ${yearOf(range.to) || "3000"}]` : "";
  const data = await getJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(query + years)}&limit=${rows}&fields=key,title,subtitle,author_name,first_publish_year,publisher,isbn,subject,first_sentence`);
  return (data?.docs || []).map((doc: any): Work | null => {
    const names = (doc.author_name || []).filter((n: string) => n && !ORG.test(n));
    if (!doc.title || !names.length || !doc.first_publish_year) return null;
    const isbns: string[] = doc.isbn || [];
    const first = Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence;
    return {
      kind: "book", title: tidy(doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title), authors: names.slice(0, 10).map(person), journal: "",
      publisher: tidy((doc.publisher || [""])[0], 200), year: String(doc.first_publish_year), doi: "", isbn: isbns.find((i) => i.length === 13) || isbns[0] || "",
      url: doc.key ? `https://openlibrary.org${doc.key}` : "", abstract: tidy([doc.subject?.length ? `Subjects: ${doc.subject.slice(0, 10).join(", ")}` : "", first ? `Opening: ${first}` : ""].filter(Boolean).join(". "), 900),
    };
  }).filter(Boolean) as Work[];
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "their", "about", "using", "study", "review", "analysis", "effect", "effects", "role"]);

function relevance(work: Work, terms: string[]) {
  const title = work.title.toLowerCase();
  const abstract = work.abstract.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    if (abstract.includes(term)) score += 1;
  }
  score += Math.log10(1 + (work.citations || 0));
  if (work.abstract) score += 1;
  if (work.authors.length) score += 0.5;
  return score;
}

/** Merge works from every service, best first, up to `limit`, with no duplicates. */
export function mergeWorks(groups: Work[][], topic: string, limit = 100, range: Range = { from: "", to: "" }): Work[] {
  const terms = [...new Set(topic.toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((t) => !STOP.has(t));
  const byKey = new Map<string, Work>();
  const fromYear = Number(yearOf(range.from)) || 0;
  const toYear = Number(yearOf(range.to)) || 9999;
  for (const group of groups) {
    for (const work of group) {
      if (!work.title || work.title.length < 8) continue;
      const year = Number(work.year) || 0;
      if (year && (year < fromYear || year > toYear)) continue;
      const doiKey = work.doi ? `doi:${work.doi.toLowerCase()}` : "";
      const titleKey = `t:${normTitle(work.title)}`;
      const existing = (doiKey && byKey.get(doiKey)) || byKey.get(titleKey);
      if (existing) {
        // Keep the richest record: fill in what the first copy lacked.
        if (!existing.abstract && work.abstract) existing.abstract = work.abstract;
        if (!existing.doi && work.doi) {
          existing.doi = work.doi;
          existing.url = work.url;
          byKey.set(doiKey, existing);
        }
        if (!existing.authors.length && work.authors.length) existing.authors = work.authors;
        existing.citations = Math.max(existing.citations || 0, work.citations || 0);
        existing.open_access = existing.open_access || work.open_access;
        for (const key of ["volume", "issue", "pages", "journal", "year"] as const) if (!existing[key] && work[key]) (existing as any)[key] = work[key];
        continue;
      }
      const copy = { ...work };
      if (doiKey) byKey.set(doiKey, copy);
      byKey.set(titleKey, copy);
    }
  }
  const unique = [...new Set(byKey.values())];
  return unique.map((w) => [w, relevance(w, terms)] as const).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w], i) => ({ ...w, id: `W${i + 1}` }));
}

/** Search every service for each query in parallel. */
export async function searchAll(queries: string[], topic: string, range: Range, options: { books?: boolean; limit?: number } = {}) {
  const tasks: Promise<Work[]>[] = [];
  queries.slice(0, 3).forEach((query, index) => {
    const rows = index === 0 ? 30 : 15;
    tasks.push(europePmc(query, range, rows), crossref(query, range, rows), openAlex(query, range, rows), semanticScholar(query, range, Math.min(rows, 20)));
    if (index < 2) tasks.push(pubmed(query, range, rows), doaj(query, range, 10), arxiv(query, range, 10));
    if (options.books && index < 2) tasks.push(crossref(query, range, 10, true), openLibrary(query, range, 10));
  });
  const settled = await Promise.allSettled(tasks);
  const groups = settled.map((r) => (r.status === "fulfilled" ? r.value : []));
  return mergeWorks(groups, topic, options.limit || 100, range);
}

// Names of the indexes searched. They are never shown, and never used as a journal's name.
const INDEX_NAMES = /(doaj|directory of open access journals|pubmed( central)?|europe ?pmc|crossref|semantic scholar|openalex|arxiv|open library|zenodo|ssrn|research ?square|biorxiv|medrxiv|figshare)/i;
const venueName = (value: string) => (INDEX_NAMES.test(value || "") ? "" : value);

/** A short summary for the page: no service names. */
export function publicWork(work: Work) {
  const names = work.authors.map((a) => a.family).filter(Boolean);
  return {
    id: work.id, title: work.title, authors: names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", "), year: work.year,
    venue: work.kind === "book" ? venueName(work.publisher || "") || "Book" : venueName(work.journal) || (work.kind === "preprint" ? "Preprint" : ""), kind: work.kind, doi: work.doi, url: work.url,
    abstract: work.abstract.slice(0, 420), open_access: Boolean(work.open_access), citations: work.citations || 0,
  };
}
