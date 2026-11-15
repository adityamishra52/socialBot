import { describe, expect, it } from "vitest";
// app.ts first, as on the server: the route modules and app.ts import each other.
import "../src/server/app";
import { layoutOptions } from "../src/server/routes-manuscript";
import { furniture, isCustomSize, pageSize } from "../src/client/lib/layout.js";
import { paginate } from "../src/client/lib/Preview.jsx";

describe("page size", () => {
  it("keeps 0 x 0 (no custom size) and repairs the old 90 x 120 default", () => {
    expect(layoutOptions({ page_size: "6x9" }, "book")).toMatchObject({ page_size: "6x9", page_width_mm: 0, page_height_mm: 0 });
    expect(layoutOptions({ page_size: "6x9", page_width_mm: 0, page_height_mm: 0 }, "book")).toMatchObject({ page_width_mm: 0, page_height_mm: 0 });
    expect(layoutOptions({ page_size: "6x9", page_width_mm: 90, page_height_mm: 120 }, "book")).toMatchObject({ page_width_mm: 0, page_height_mm: 0 });
    expect(layoutOptions({ page_width_mm: 170, page_height_mm: 240 }, "book")).toMatchObject({ page_width_mm: 170, page_height_mm: 240 });
    expect(layoutOptions({ page_width_mm: 20, page_height_mm: 9999 }, "book")).toMatchObject({ page_width_mm: 90, page_height_mm: 420 });
    expect(layoutOptions({ page_width_mm: 170 }, "book")).toMatchObject({ page_width_mm: 0, page_height_mm: 0 });
  });

  it("uses the chosen standard size unless a real custom size is set", () => {
    expect(isCustomSize({ page_width_mm: 90, page_height_mm: 120 })).toBe(false);
    expect(pageSize({ page_size: "6x9", page_width_mm: 90, page_height_mm: 120 })).toEqual([152, 229]);
    expect(pageSize({ page_size: "6x9", page_width_mm: 0, page_height_mm: 0 })).toEqual([152, 229]);
    expect(pageSize({ page_size: "a4", page_width_mm: 170, page_height_mm: 240 })).toEqual([170, 240]);
  });
});

describe("running header and page number", () => {
  it("sit in the margins about 4 mm from the text, pushing the text only when a margin is too small", () => {
    const roomy = furniture({ margin_top: 20, margin_bottom: 20, running_headers: true, page_number_position: "bottom-outside" });
    expect(roomy.top.offset).toBeCloseTo(12.4, 5);
    expect(roomy.top.push).toBe(0);
    expect(roomy.bottom.offset).toBeCloseTo(12.4, 5);
    const tight = furniture({ margin_top: 8, margin_bottom: 8, running_headers: true, page_number_position: "bottom-center" });
    expect(tight.top.offset).toBe(3);
    expect(tight.top.push).toBeCloseTo(2.6, 5);
    const none = furniture({ margin_top: 20, margin_bottom: 20, running_headers: false, page_number_position: "none" });
    expect(none.top).toEqual({ offset: 0, push: 0 });
    expect(none.bottom).toEqual({ offset: 0, push: 0 });
  });
});

describe("pagination", () => {
  // A fake typesetter: 10 words a line, 20 px a line.
  const LINE = 20;
  const heightOf = (text: string) => Math.ceil(text.split(/\s+/).filter(Boolean).length / 10) * LINE;
  const measureText = (block: any, room: number) => {
    const words = block.text.split(/\s+/).filter(Boolean);
    const best = Math.floor(room / LINE) * 10;
    if (best < 4 || words.length - best < 3) return null;
    const tail = words.slice(best).join(" ");
    return { head: words.slice(0, best).join(" "), tail, tailHeight: heightOf(tail) };
  };
  const layout = { font_size: 11, line_spacing: 1.4, page_number_start: 1 };
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it("splits a paragraph longer than a page over as many pages as it needs, never past the bottom", () => {
    const blocks = [{ type: "h1", text: "Introduction" }, { type: "p", text: words(300) }, { type: "p", text: words(40) }];
    const heights = blocks.map((b) => (b.type === "h1" ? 40 : heightOf(b.text)));
    const available = 220; // 11 lines
    const pages = paginate(blocks, heights, measureText, available, layout, false);
    const used = pages.map((page: any) => page.blocks.reduce((n: number, b: any) => n + (b.type === "h1" ? 40 : heightOf(b.text)), 0));
    expect(used.every((n: number) => n <= available)).toBe(true);
    const total = pages.flatMap((page: any) => page.blocks.filter((b: any) => b.type === "p").map((b: any) => b.text.split(" ").length)).reduce((a: number, b: number) => a + b, 0);
    expect(total).toBe(340);
    expect(pages.length).toBe(4);
    expect(pages[1].blocks[0]).toMatchObject({ cont: true });
    expect(pages.map((p: any) => p.label)).toEqual(["1", "2", "3", "4"]);
  });

  it("moves a paragraph to the next page when less than two lines are left", () => {
    const blocks = [{ type: "p", text: words(100) }, { type: "p", text: words(50) }];
    const heights = blocks.map((b) => heightOf(b.text));
    const pages = paginate(blocks, heights, measureText, 215, layout, false); // 10 lines + 15 px left
    expect(pages[0].blocks).toHaveLength(1);
    expect(pages[1].blocks[0].text.split(" ")).toHaveLength(50);
  });
});
