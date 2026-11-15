import { json, textField, validPassword, ADMIN_SESSION_SECONDS, type Route } from "./app";
import { blocked, hashPassword, pinFingerprint, recordFailure, safeEqual, sign } from "./auth";
import { col, now, toObjectId } from "./db";
import { env } from "./env";
import { ConfigError } from "./errors";
import { currentModel, freeTier, PRICES_CHECKED, PRICES_SOURCE } from "./gemini";
import { accountEmail, sendPlain, smtpSettings } from "./mail";
import { usageJson } from "./usage";
import { SETTING } from "./autopilot";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const userJson = (user: any) => ({
  id: String(user._id), email: user.email, name: user.name || "", active: Boolean(user.active), autopost: Boolean(user.autopost),
  created_at: new Date(user.created_at).toISOString(), last_login_at: user.last_login_at ? new Date(user.last_login_at).toISOString() : null,
});

async function accountMail(kind: string, user: any, password: string, origin: string) {
  if (!smtpSettings()) return { sent: false, error: "Email isn't set up on this server.", hint: "Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD on Vercel." };
  const { subject, body } = accountEmail(kind, user.name || "", user.email, password, `${origin}/login`);
  try {
    await sendPlain(user.email, subject, body);
    return { sent: true };
  } catch (error: any) {
    return { sent: false, error: error.message, hint: error.hint };
  }
}

export const routes: Route[] = [
  ["POST", "/api/admin/login", "public", async ({ body }) => {
    if (await blocked("admin", 5)) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const pin = env("ADMIN_PIN");
    if (pin.length < 6) throw new ConfigError("Admin access isn't set up on this server.", "Set ADMIN_PIN on Vercel, with at least 6 characters.");
    const supplied = (await body()).pin;
    if (typeof supplied !== "string" || !safeEqual(supplied, pin)) {
      await recordFailure("admin");
      return json({ error: "That PIN isn't correct." }, 401);
    }
    return { token: sign("admin-session", { pin: pinFingerprint(pin) }, ADMIN_SESSION_SECONDS) };
  }],
  ["GET", "/api/admin/users", "admin", async () => ({
    users: (await (await col("users")).find().sort({ created_at: -1 }).toArray()).map(userJson), email_ready: Boolean(smtpSettings()),
  })],
  ["POST", "/api/admin/users", "admin", async ({ body, origin }) => {
    const data = await body();
    const email = (textField(data, "email") || "").toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new ConfigError("Enter a valid email address.");
    const password = validPassword(data.password);
    const user = { email, name: (textField(data, "name") || "").slice(0, 100), password_hash: hashPassword(password), active: true, autopost: false, session_version: 1, created_at: now(), last_login_at: null };
    try {
      const result = await (await col("users")).insertOne(user);
      const created = { ...user, _id: result.insertedId };
      return json({ user: userJson(created), email: data.send_email === true ? await accountMail("welcome", created, password, origin) : null }, 201);
    } catch (error: any) {
      if (error?.code === 11000) throw new ConfigError("A user with that email already exists.");
      throw error;
    }
  }],
  ["PATCH", "/api/admin/users/:id", "admin", async ({ params, body, origin }) => {
    const id = toObjectId(params.id);
    if (!id) return json({ error: "That user wasn't found." }, 404);
    const data = await body();
    const users = await col("users");
    let update: any;
    let password: string | null = null;
    if (typeof data.active === "boolean") update = { $set: { active: data.active } };
    else if (typeof data.autopost === "boolean") update = { $set: { autopost: data.autopost } };
    else if ("password" in data) {
      password = validPassword(data.password);
      update = { $set: { password_hash: hashPassword(password) }, $inc: { session_version: 1 } };
    } else throw new ConfigError("Nothing to change.");
    const updated = await users.findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
    if (!updated) return json({ error: "That user wasn't found." }, 404);
    return { user: userJson(updated), email: password && data.send_email === true ? await accountMail("reset", updated, password, origin) : null };
  }],
  ["GET", "/api/admin/usage", "admin", async ({ url }) => {
    const days = Math.max(0, Math.min(3650, Number(url.searchParams.get("days") || 30) || 30));
    const match = days ? { created_at: { $gte: new Date(Date.now() - days * 86400_000) } } : {};
    const totals = new Map((await (await col("ai_usage")).aggregate([{ $match: match }, { $group: {
      _id: "$user_id", runs: { $sum: 1 }, calls: { $sum: "$calls" }, input_tokens: { $sum: "$input_tokens" }, output_tokens: { $sum: "$output_tokens" },
      thinking_tokens: { $sum: "$thinking_tokens" }, cost_usd: { $sum: "$cost_usd" }, unpriced_calls: { $sum: "$unpriced_calls" }, last_at: { $max: "$created_at" },
    } }]).toArray()).map((row) => [String(row._id), row]));
    const users = (await (await col("users")).find().toArray()).map((user) => {
      const row: any = totals.get(String(user._id)) || {};
      return { ...userJson(user), runs: row.runs || 0, calls: row.calls || 0, input_tokens: row.input_tokens || 0, output_tokens: (row.output_tokens || 0) + (row.thinking_tokens || 0),
        cost_usd: Math.round((row.cost_usd || 0) * 1e6) / 1e6, unpriced_calls: row.unpriced_calls || 0, last_at: row.last_at ? new Date(row.last_at).toISOString() : null };
    }).sort((a, b) => b.cost_usd - a.cost_usd);
    return { days, users, total_cost_usd: Math.round(users.reduce((n, u) => n + u.cost_usd, 0) * 1e6) / 1e6, total_runs: users.reduce((n, u) => n + u.runs, 0),
      prices: { checked: PRICES_CHECKED, source: PRICES_SOURCE, free_tier: freeTier(), model: currentModel() } };
  }],
  ["GET", "/api/admin/users/:id/usage", "admin", async ({ params }) => {
    const id = toObjectId(params.id);
    if (!id || !(await (await col("users")).findOne({ _id: id }))) return json({ error: "That user wasn't found." }, 404);
    return { runs: (await (await col("ai_usage")).find({ user_id: id }, { projection: { z: 0 } }).sort({ created_at: -1 }).limit(200).toArray()).map(usageJson) };
  }],
  ["GET", "/api/admin/autopilot", "admin", async () => ({ enabled: Boolean((await (await col("settings")).findOne({ _id: SETTING as any }))?.value), reels_unavailable: "Bots make image posts on Vercel; reels are recorded in the browser from Site to Reel." })],
  ["PUT", "/api/admin/autopilot", "admin", async ({ body }) => {
    const enabled = (await body()).enabled;
    if (typeof enabled !== "boolean") throw new ConfigError("Say whether auto-posting is on or off.");
    await (await col("settings")).updateOne({ _id: SETTING as any }, { $set: { value: enabled, updated_at: now() } }, { upsert: true });
    return { enabled, reels_unavailable: "Bots make image posts on Vercel; reels are recorded in the browser from Site to Reel." };
  }],
];
