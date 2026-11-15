import type { Route } from "./app";
import { col, toObjectId, unpack } from "./db";
import { config } from "./env";
import { ConfigError } from "./errors";
import { shareCopy } from "./share";
import { aiRun } from "./usage";

// Posts announcing a finished book or manuscript. The images are drawn in the browser and posted
// through the same publishing steps as Site to Post (/api/sitepost/publish).

export const routes: Route[] = [
  ["POST", "/api/manuscript/:id/share", "user", async ({ params, body, user }) => {
    if (!config.geminiKey()) throw new ConfigError("Writing the posts needs the Gemini key on this server.");
    const id = toObjectId(params.id);
    const found = id ? await (await col("manuscripts")).findOne({ _id: id, user_id: user._id }) : null;
    if (!found) throw new ConfigError(`That project wasn't found. Projects are deleted ${config.historyDays()} days after their last change.`);
    const project = unpack(found);
    if (project.status !== "ready" || !project.draft) throw new ConfigError("Wait until the first draft is written.");
    const data = await body();
    const request = String(data.request || "").split(/\s+/).join(" ").trim().slice(0, 600);
    const [copy, usage] = await aiRun(user._id, "manuscript", `Share posts: ${String(project.title || "").slice(0, 70)}`, () => shareCopy(project, request));
    return { ...copy, usage };
  }],
];
