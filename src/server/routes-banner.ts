import type { Route } from "./app";
import { ART_STYLES, ASPECTS, BANNER_KINDS, artPrompt, bannerBrief, planBanner } from "./banner";
import { config } from "./env";
import { ConfigError } from "./errors";
import { publicFileUrl, storeBuffer } from "./files";
import { imageModel, makeImage } from "./gemini";
import { freeImage } from "./sources";
import { aiRun } from "./usage";

// Banner & Poster Studio: the words and concepts (text model), then each concept's artwork
// (image model), one request each so every request stays well under Vercel's time limit. Free,
// openly licensed photos are the fallback when AI pictures are off or not in the key's plan.

const dataUrlImage = (value: unknown) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof value === "string" ? value : "");
  if (!match) throw new ConfigError("The picture couldn't be read. Choose it again.");
  if (match[2].length > 4_000_000) throw new ConfigError("The picture is too large to edit. Use a smaller one.");
  return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
};

export const routes: Route[] = [
  ["POST", "/api/banner/plan", "user", async ({ body, user }) => {
    if (!config.geminiKey()) throw new ConfigError("Banners need the Gemini key on this server.", "Ask your administrator to set GEMINI_API_KEY.");
    const brief = bannerBrief(await body());
    const [plan, usage] = await aiRun(user._id, "banner", `Banner: ${brief.topic.slice(0, 80)}`, () => planBanner(brief));
    return { plan, brief, usage };
  }],
  ["POST", "/api/banner/art", "user", async ({ body, user }) => {
    if (!imageModel()) throw new ConfigError("AI pictures are switched off on this server.", "Upload your own picture, or use a plain design background.");
    const data = await body();
    const aspect = ASPECTS.includes(data.aspect) ? data.aspect : "4:5";
    const instruction = String(data.instruction || "").split(/\s+/).join(" ").trim().slice(0, 1000);
    let parts: any[];
    let label: string;
    if (data.image) {
      // Edit the current artwork: keep it, change what the author asks, still no words.
      if (!instruction) throw new ConfigError("Describe the change you want to the picture.");
      parts = [
        { inlineData: dataUrlImage(data.image) },
        { text: `Edit this banner artwork. ${instruction} Keep the overall composition and keep the calm empty area for the words empty. Absolutely no text, letters, numbers, logos or watermarks. Output one high-quality image.` },
      ];
      label = `Banner picture edit: ${instruction.slice(0, 60)}`;
    } else {
      parts = [{ text: artPrompt({
        kind: BANNER_KINDS[data.kind] ? data.kind : "festival", style: ART_STYLES[data.style] ? data.style : "illustration",
        scene: [String(data.scene || ""), instruction].filter(Boolean).join(" "), area: String(data.area || "top"),
        palette: data.palette, mood: String(data.mood || ""), brand_color: String(data.brand_color || ""), topic: String(data.topic || ""),
      }) }];
      label = `Banner picture: ${String(data.topic || data.scene || "").slice(0, 60)}`;
    }
    const [image, usage] = await aiRun(user._id, "banner", label, () => makeImage(parts, aspect));
    return { image: `data:${image.mime};base64,${image.data.toString("base64")}`, usage };
  }],
  ["POST", "/api/banner/photo", "user", async ({ body, user, origin }) => {
    const data = await body();
    const query = String(data.query || "").split(/\s+/).join(" ").trim().slice(0, 200);
    if (!query) throw new ConfigError("Type what the photo should show.");
    const used = new Set<string>((Array.isArray(data.used) ? data.used : []).filter((u: unknown) => typeof u === "string").slice(0, 50));
    const photo = await freeImage(query, used);
    if (!photo) throw new ConfigError("No openly licensed photo was found for that.", "Try other, simpler words: what the picture shows.");
    // Stored and served from this site, so the browser can draw it on the banner (and it's too big to return inline).
    const key = await storeBuffer(user._id, "image", photo.mime, photo.data, "banner-photo");
    return { image: publicFileUrl(origin, key, 6), credit: photo.credit, origin: photo.origin, license: photo.license };
  }],
];
