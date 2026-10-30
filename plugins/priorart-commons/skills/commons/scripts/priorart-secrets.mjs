// What must never reach the public commons. Same credential/infrastructure patterns as the server's SecretScanner
// (server/src/main/java/io/priorart/commons/SecretScanner.java; keep in sync), plus the publisher's own company terms
// (repo, org, hosts, team, handle, email domain), which only the client knows.

const SECRETISH = String.raw`(?=\S*[0-9!@#$%^&*_+=])\S{6,}`;
const RULES = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["AWS access key", /\b(AKIA|ASIA)(?=[0-9A-Z]*[0-9])[0-9A-Z]{16}\b/gi],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["OpenAI/Anthropic key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Stripe key", /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["password assignment", /\b(password|passwd|pwd|passphrase|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{6,}/gi],
  ["password in prose", new RegExp(String.raw`\b(password|passwd|passphrase|secret|api[ _-]?key|token)\s+(is|was|=|:)\s*['"]?` + SECRETISH, "gi")],
  ["connection string with credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
  ["private IP address", /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
  ["internal hostname", /\b(?:[a-z0-9-]+\.)+(internal|corp|local|lan|intranet|intra|private|priv|home\.arpa)\b/gi],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

const mask = (s) => (s.length <= 8 ? "****" : s.slice(0, 4) + "…" + "*".repeat(Math.min(8, s.length - 4)));

const INVISIBLE = /[\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
const SPACED_RUN = /(?<![A-Za-z0-9])(?:[A-Za-z0-9_][ \t]+){5,}[A-Za-z0-9_](?![A-Za-z0-9])/g;
const SPACED_DOT = /(?<=\d)[ \t]*\.[ \t]*(?=\d)/g;
const BROKEN_TOKEN = /([A-Za-z0-9_])[ \t]*\r?\n[ \t]*([A-Za-z0-9_])/g;
const BASE64ISH = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

const HEXISH = /\b(?:[0-9a-fA-F]{2}){12,}\b/g;
// Cyrillic and Greek letters that look like Latin ones ("АKIA" with a Cyrillic А).
const LOOK_FROM = "АВЕКМНОРСТХУІЈЅԁаеорсхуіјѕһԛԝΑΒΕΖΗΙΚΜΝΟΡΤΥΧαοικνρτυχ";
const LOOK_TO   = "ABEKMHOPCTXYIJSdaeopcxyijshqwABEZHIKMNOPTYXaoiknptux";
const skeleton = (t) => [...t].map((c) => { const i = LOOK_FROM.indexOf(c); return i >= 0 ? LOOK_TO[i] : c; }).join("");
const normalise = (t) => skeleton(t.normalize("NFKC").replace(INVISIBLE, ""));
function decodeHex(h) {
  const s = Buffer.from(h, "hex").toString("utf8");
  return [...s].filter((c) => c >= " " && c < "\x7f").length >= s.length * 0.9 ? s : null;
}
function decode(token) {
  try {
    const s = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const printable = [...s].filter((c) => c >= " " && c < "\x7f").length;
    return s.length >= 8 && printable >= s.length * 0.9 ? s : null;
  } catch { return null; }
}

/**
 * Credentials and internal infrastructure: always block, no override. Same views as the server's SecretScanner: as
 * written; normalised (NFKC, invisible characters removed); spaced-out runs and line-broken tokens joined; base64
 * decoded; and across field boundaries. Pass an array to scan fields together.
 */
const SPLITTABLE = new Set(["private key", "AWS access key", "GitHub token", "GitLab token", "Slack token",
  "OpenAI/Anthropic key", "Stripe key", "Google API key", "JWT"]);

/** Every key and leaf value of a (nested) environment object, each as its own field for scanSecrets. */
export function envFields(env, depth = 0) {
  if (env == null || depth > 20) return [];
  if (Array.isArray(env)) return env.flatMap((x) => envFields(x, depth + 1));
  if (typeof env === "object") return Object.entries(env).flatMap(([k, v]) => [k, ...envFields(v, depth + 1)]);
  return [String(env)];
}

export function scanSecrets(textOrFields) {
  const fields = (Array.isArray(textOrFields) ? textOrFields : [textOrFields]).filter((f) => f != null).map((f) => normalise(String(f)));
  const all = fields.join("\n");
  const views = [all, all.replace(SPACED_RUN, (m) => m.replace(/[ \t]+/g, "")).replace(BROKEN_TOKEN, "$1$2").replace(SPACED_DOT, ".")];
  for (const m of all.matchAll(BASE64ISH)) { const d = decode(m[0]); if (d) views.push(d); }
  for (const m of all.matchAll(HEXISH)) { const d = decodeHex(m[0]); if (d) views.push(d); }
  const seen = new Map();
  const find = (v, rules) => { for (const [kind, re] of rules) for (const m of v.matchAll(re)) {
    const key = kind + "|" + m[0].replace(/\s+/g, "").toLowerCase();   // one finding per secret, however many views
    if (!seen.has(key) && seen.size < 20) seen.set(key, { kind, preview: mask(m[0]) });
  } };
  for (const v of views) find(v, RULES);
  // A token split across fields: end of one, up to two short fragment fields, start of another, in any order. Only
  // tokens are glued back: "10.2" next to "20.11" is two version numbers, not the address 10.210.220.11.
  const tokens = RULES.filter(([kind]) => SPLITTABLE.has(kind));
  const frags = fields.map((f) => f.trim()).filter((f) => f && f.length <= 40);
  for (let i = 0; i < fields.length; i++) for (let j = 0; j < fields.length; j++) {
    if (i === j) continue;
    const a = fields[i].trim().slice(-60), b = fields[j].trim().slice(0, 60);
    find(a + b, tokens);
    for (const f1 of frags) { find(a + f1 + b, tokens); for (const f2 of frags) if (f2 !== f1) find(a + f1 + f2 + b, tokens); }
  }
  return [...seen.values()];
}

// Words too common to treat as company-identifying even when they're a team or repo name.
const GENERIC = new Set(["core", "api", "app", "apps", "web", "server", "client", "platform", "backend", "frontend", "service",
  "services", "main", "master", "dev", "prod", "test", "tests", "data", "admin", "users", "team", "infra", "common", "shared",
  "src", "lib", "docs", "home", "users", "projects", "repo", "repos", "work", "code", "github.com", "gitlab.com", "bitbucket.org",
  "internal", "corp", "local", "lan"]);
const PUBLIC_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/**
 * Terms that identify the publisher's company or people, from what the client knows about the source record:
 * repo remote (org/group/repo names, private hosts), working directory, team/application slugs, handle, email.
 */
const PRIVATE_HOST = /\b(?:[a-z0-9-]+\.)+(internal|corp|local|lan|intranet|intra|private|priv|home\.arpa)\b/gi;

export const isPrivateHost = (t) => /\.(internal|corp|local|lan|intranet|intra|private|priv|home\.arpa)$/i.test(t);

export function companyTerms({ repo, cwd, team, application, handle, email, text } = {}) {
  const terms = new Set();
  const add = (t) => { if (!t) return; const v = String(t).trim().toLowerCase(); if (v.length >= 3 && !GENERIC.has(v)) terms.add(v); };
  if (repo) {
    const [host, ...path] = String(repo).split("/");
    if (!PUBLIC_HOSTS.has(host)) { add(host); host.split(".").slice(0, -1).forEach(add); }
    path.forEach(add);
  }
  if (cwd) {
    const parts = String(cwd).split("/").filter(Boolean);
    const homeAt = parts.indexOf("Users") >= 0 ? parts.indexOf("Users") : parts.indexOf("home");
    if (homeAt >= 0 && parts[homeAt + 1]) add(parts[homeAt + 1]);   // the account name in /Users/<name> or /home/<name>
    if (parts.length) add(parts[parts.length - 1]);                   // the project directory
  }
  add(team); add(application);
  if (handle) { add(handle); String(handle).split(/[._-]/).forEach(add); }
  if (email && email.includes("@")) {
    const [local, domain] = email.toLowerCase().split("@");
    add(local); local.split(/[._-]/).forEach(add);
    if (!["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com"].includes(domain)) {
      add(domain); add(domain.split(".")[0]);
    }
  }
  // Private hostnames mentioned in the source material ("ora-mirror-02.globex.internal"): the host and its labels.
  if (text) for (const m of String(text).matchAll(PRIVATE_HOST)) { add(m[0]); m[0].split(".").slice(0, -1).forEach(add); }
  return [...terms];
}

/**
 * Company terms present in the text, case-insensitive, as whole words. '_' counts as '-', and a term is also found
 * inside a longer '-'/'_' joined name ("shopco" in "shopco-prod", "checkout-api" in "checkout_api_v2"): internal
 * clusters, tables and services are named like that.
 */
export function scanTerms(text, terms) {
  const hay = text.toLowerCase().replace(/_/g, "-");
  const hits = [];
  for (const t of terms) {
    const esc = t.toLowerCase().replace(/_/g, "-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, "i").test(hay)) hits.push(t);
  }
  return hits;
}
