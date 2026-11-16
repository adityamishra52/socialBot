import { afterEach, describe, expect, it, vi } from "vitest";
import { boxFrom, checkShotPlan } from "../src/server/shots";
import { imageSize, pageScreenshot } from "../src/server/web";
import { avoidPopups, coverage, cropFor, shotPalette } from "../src/client/lib/shots.js";

function png(width: number, height: number, extra = 3000) {
  const data = Buffer.alloc(24 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width: number, height: number) {
  // SOI, an APP0 segment, then SOF0 with height and width.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03]),
    Buffer.alloc(20),
  ]);
}

const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const picture = (data: Buffer) => new Response(new Uint8Array(data), { status: 200, headers: { "Content-Type": "image/png" } });

describe("screenshot plan from the AI", () => {
  it("turns 0-1000 boxes into fractions and keeps only usable slides", () => {
    const plan = checkShotPlan({
      slides: [
        { box_2d: [0, 0, 180, 1000], kicker: "new launch today now", headline: "Your **tools**. Your rules. Any AI. #ai" },
        { box_2d: [400, 0, 300, 1000], headline: "Upside down box" },
        { box_2d: [300, 50, 520, 950], headline: "" },
        { box_2d: ["600", 0, 820, 1200], kicker: "pricing", headline: "Free for small teams" },
        { box_2d: [900, 0, 950, 1000], headline: "One too many" },
        { box_2d: [10, 0, 50, 1000], headline: "Over the limit" },
      ],
      popups: [[700, 600, 1000, 1000], [1, 2]],
      color: "#1E40AF",
    });
    expect(plan.slides).toHaveLength(3);
    expect(plan.slides[0]).toEqual({ box: [0, 0, 0.18, 1], headline: "Your tools. Your rules. Any AI. ai", kicker: "NEW LAUNCH TODAY" });
    expect(plan.slides[1].box).toEqual([0.6, 0, 0.82, 1]);
    expect(plan.slides[1].kicker).toBe("PRICING");
    expect(plan.popups).toEqual([[0.7, 0.6, 1, 1]]);
    expect(plan.color).toBe("#1E40AF");
  });

  it("asks again when no slide is usable, and ignores a bad colour", () => {
    expect(() => checkShotPlan({ slides: [{ box_2d: [0, 0, 1, 1], headline: "Too small" }] })).toThrow(/slides/);
    expect(() => checkShotPlan({})).toThrow(/slides/);
    expect(checkShotPlan({ slides: [{ box: [0, 0, 500, 1000], headline: "Hi there" }], color: "blue" }).color).toBe("");
    expect(boxFrom([0, 0, 1000])).toBeNull();
    expect(boxFrom([-50, -10, 2000, 1000])).toEqual([0, 0, 1, 1]);
  });
});

describe("page screenshots", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SCREENSHOTS;
  });

  it("reads PNG and JPEG sizes", () => {
    expect(imageSize(png(1280, 5436))).toEqual({ width: 1280, height: 5436, mime: "image/png" });
    expect(imageSize(jpeg(1280, 1280))).toEqual({ width: 1280, height: 1280, mime: "image/jpeg" });
    expect(imageSize(Buffer.from("<html>not a picture</html>"))).toBeNull();
  });

  it("downloads the first screen and the whole page from the reader", async () => {
    const full = png(1280, 5436);
    const first = png(1280, 1280);
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const address = String(url);
      if (address.startsWith("https://r.jina.ai/")) {
        const format = init.headers["X-Return-Format"];
        asked.push(format);
        expect(address).toBe("https://r.jina.ai/https://93.184.216.34/pricing");
        return json({ data: format === "pageshot" ? { screenshotUrl: "https://8.8.8.8/first.png", pageshotUrl: "https://8.8.8.8/full.png" } : { screenshotUrl: "https://8.8.8.8/first.png" } });
      }
      return picture(address.endsWith("full.png") ? full : first);
    }));
    const shots = await pageScreenshot("https://93.184.216.34/pricing");
    expect(asked.sort()).toEqual(["pageshot", "screenshot"]);
    expect(shots.page?.equals(full)).toBe(true);
    expect(shots.first?.equals(first)).toBe(true);
  });

  it("uses the first screen when the whole page is too tall, and gives up quietly on failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const address = String(url);
      if (address.startsWith("https://r.jina.ai/")) {
        return json({ data: init.headers["X-Return-Format"] === "pageshot" ? { pageshotUrl: "https://8.8.8.8/full.png" } : { screenshotUrl: "https://8.8.8.8/first.png" } });
      }
      return picture(address.endsWith("full.png") ? png(1280, 40_000) : png(1280, 1280));
    }));
    const shots = await pageScreenshot("https://93.184.216.34/");
    expect(imageSize(shots.page!)?.height).toBe(1280);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await pageScreenshot("https://93.184.216.34/")).toEqual({ page: null, first: null });

    vi.stubGlobal("fetch", vi.fn(async (url: any) => (String(url).startsWith("https://r.jina.ai/")
      ? json({ data: { screenshotUrl: "https://8.8.8.8/x.png", pageshotUrl: "https://8.8.8.8/x.png" } })
      : new Response("<html>Access denied</html>", { status: 200, headers: { "Content-Type": "text/html" } }))));
    expect(await pageScreenshot("https://93.184.216.34/")).toEqual({ page: null, first: null });
  });

  it("never photographs private addresses or runs when switched off", async () => {
    const spy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", spy);
    expect(await pageScreenshot("http://127.0.0.1:8080/admin")).toEqual({ page: null, first: null });
    process.env.SCREENSHOTS = "off";
    expect(await pageScreenshot("https://93.184.216.34/")).toEqual({ page: null, first: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("screenshot post layout", () => {
  it("shows the top of the page for a hero box, filling the frame", () => {
    const region = cropFor([0, 0, 0.12, 1], 1280, 5436, 1.2);
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    expect(region.w).toBe(1280);
    expect(region.w / region.h).toBeCloseTo(1.2);
  });

  it("zooms into a small box, stays inside the page and starts a tall box at its top", () => {
    const small = cropFor([0.5, 0.6, 0.55, 0.9], 1280, 5436, 1.2);
    expect(small.w).toBe(640);
    expect(small.x + small.w).toBeLessThanOrEqual(1280);
    expect(small.y).toBeGreaterThan(0.5 * 5436 - small.h);
    const tall = cropFor([0.2, 0, 0.8, 1], 1280, 5436, 1.2);
    expect(tall.y).toBeLessThanOrEqual(0.2 * 5436);
    expect(tall.y).toBeGreaterThan(0.2 * 5436 - 50);
    const bottom = cropFor([0.97, 0, 1, 1], 1280, 1400, 1.2);
    expect(bottom.y + bottom.h).toBeCloseTo(1400);
  });

  it("measures how much a pop-up covers a part of the page", () => {
    const region = { x: 0, y: 0, w: 1280, h: 1066 };
    expect(coverage(region, [0, 0.5, 1, 1], 1280, 1066)).toBeCloseTo(0.5);
    expect(coverage(region, [0.9, 0, 1, 1], 1280, 5000)).toBe(0);
  });

  it("moves a part of the page clear of a pop-up, or drops it", () => {
    // Wikipedia's first screen with the donation box on the right, as the AI found it.
    const box = [0.044, 0.322, 0.217, 0.678];
    const popup = [0.183, 0.603, 0.984, 0.984];
    const region = cropFor(box, 1280, 1280, 1.23);
    expect(coverage(region, popup, 1280, 1280)).toBeGreaterThan(0.1);
    const moved = avoidPopups(region, box, [popup], 1280, 1280)!;
    expect(coverage(moved, popup, 1280, 1280)).toBeLessThan(0.02);
    expect(moved.x + moved.w).toBeLessThanOrEqual(0.603 * 1280 + 1);
    expect(avoidPopups(region, box, [], 1280, 1280)).toBe(region);
    expect(avoidPopups(region, box, [[0, 0, 1, 1]], 1280, 1280)).toBeNull();
  });

  it("picks readable colours", () => {
    expect(shotPalette("#000000").accent).toBe("#FFFFFF");
    const dark = shotPalette("#FACC15");
    expect(dark.ink).toBe("#FFFFFF");
    expect(shotPalette("not a colour").accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(shotPalette("#FACC15", "academic").bg).toBe("#F6F3EC");
  });
});
