import type { Route } from "./app";
import { col, toObjectId, unpack } from "./db";
import { config } from "./env";
import { ConfigError } from "./errors";
import { bookListing } from "./listing";
import { shareCopy } from "./share";
import { aiRun } from "./usage";

// Posts announcing a finished book or manuscript, and a book's store listing for KDP, Google Play
// Books and Draft2Digital. The images and files are made in the browser; posting goes through the
// same publishing steps as Site to Post (/api/sitepost/publish).

async function readyProject(userId: any, id: string) {
  if (!config.geminiKey()) throw new ConfigError("Writing this needs the Gemini key on this server.");
  const objectId = toObjectId(id);
  const found = objectId ? await (await col("manuscripts")).findOne({ _id: objectId, user_id: userId }) : null;
  if (!found) throw new ConfigError(`That project wasn't found. Projects are deleted ${config.historyDays()} days after their last change.`);
  const project = unpack(found);
  if (project.status !== "ready" || !project.draft) throw new ConfigError("Wait until the first draft is written.");
  return project;
}

export const routes: Route[] = [
  ["POST", "/api/manuscript/:id/share", "user", async ({ params, body, user }) => {
    const project = await readyProject(user._id, params.id);
    const data = await body();
    const request = String(data.request || "").split(/\s+/).join(" ").trim().slice(0, 600);
    const [copy, usage] = await aiRun(user._id, "manuscript", `Share posts: ${String(project.title || "").slice(0, 70)}`, () => shareCopy(project, request));
    return { ...copy, usage };
  }],
  ["POST", "/api/manuscript/:id/listing", "user", async ({ params, user }) => {
    const project = await readyProject(user._id, params.id);
    if (project.mode !== "book") throw new ConfigError("Store listings are for books.");
    const [listing, usage] = await aiRun(user._id, "manuscript", `Store listing: ${String(project.title || "").slice(0, 70)}`, () => bookListing(project));
    return { ...listing, usage };
  }],
];
