import nodemailer from "nodemailer";
import { env } from "./env";
import { AppError, ConfigError } from "./errors";

// SMTP, always encrypted: port 465 uses TLS, any other port must support STARTTLS.

export const APP_NAME = "Social Autopost";

export class MailError extends AppError {}

export function smtpSettings() {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const password = env("SMTP_PASSWORD");
  if (!host || !user || !password) return null;
  const port = Number(env("SMTP_PORT", "587")) || 587;
  return { host, port, user, password, sender: env("SMTP_FROM", user) };
}

export function requireSmtp() {
  const settings = smtpSettings();
  if (!settings) throw new ConfigError("Email isn't set up on this server.", "Ask your administrator to set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD on Vercel.");
  return settings;
}

export function transport(settings = requireSmtp()) {
  return nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.port === 465, requireTLS: settings.port !== 465,
    auth: { user: settings.user, pass: settings.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
    pool: false,
  });
}

const cleanName = (name: string) => name.split(/\s+/).join(" ").trim().slice(0, 100);

export interface HtmlMessage {
  to: string; subject: string; text: string; html: string; fromName?: string; replyTo?: string;
  images?: { cid: string; data: Buffer; mime: string }[]; headers?: Record<string, string>;
}

export async function sendHtml(transporter: ReturnType<typeof nodemailer.createTransport>, settings: { sender: string }, message: HtmlMessage) {
  try {
    await transporter.sendMail({
      from: { name: cleanName(message.fromName || "") || APP_NAME, address: settings.sender },
      to: message.to, subject: message.subject.split(/\s+/).join(" "), text: message.text, html: message.html,
      replyTo: message.replyTo || undefined, headers: message.headers,
      attachments: (message.images || []).map((image) => ({ cid: image.cid, content: image.data, contentType: image.mime, filename: `${image.cid.split("@")[0]}.jpg`, contentDisposition: "inline" as const })),
    });
  } catch (error: any) {
    if (error?.code === "EAUTH") throw new MailError("The email server rejected the sign-in.", "Check SMTP_USER and SMTP_PASSWORD. Gmail needs an app password.");
    if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(error?.code)) {
      throw new MailError("Couldn't connect to the email server.", "Check SMTP_HOST and SMTP_PORT.");
    }
    if (error?.responseCode && error.responseCode >= 500) throw new MailError(`The email server refused the address ${message.to}.`);
    throw new MailError(`Couldn't send the email to ${message.to}.`);
  }
}

export async function sendPlain(to: string, subject: string, body: string) {
  const settings = requireSmtp();
  const transporter = transport(settings);
  try {
    await transporter.sendMail({ from: { name: APP_NAME, address: settings.sender }, to, subject, text: body });
  } catch (error: any) {
    if (error?.code === "EAUTH") throw new MailError("The email server rejected the sign-in.", "Check SMTP_USER and SMTP_PASSWORD. Gmail needs an app password.");
    throw new MailError("Couldn't send the email.", "Check the SMTP settings on Vercel.");
  } finally {
    transporter.close();
  }
}

export function accountEmail(kind: string, name: string, email: string, password: string, loginUrl: string | null) {
  const greeting = cleanName(name) ? `Hi ${cleanName(name)},` : "Hi,";
  const where = loginUrl ? `Sign in here: ${loginUrl}` : "Ask your administrator for the sign-in address.";
  const subject = kind === "welcome" ? `Your ${APP_NAME} account` : `Your ${APP_NAME} password was reset`;
  const opening = kind === "welcome" ? `An account has been created for you on ${APP_NAME}.` : `Your ${APP_NAME} password was reset by an administrator.`;
  const body = `${greeting}\n\n${opening}\n\n${where}\nEmail: ${email}\nPassword: ${password}\n\nPlease change this password after you sign in, on the Settings page.\n\nIf you weren't expecting this email, you can ignore it.\n`;
  return { subject, body };
}
