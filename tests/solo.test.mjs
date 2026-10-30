// node --test 'tests/*.test.mjs'   — the commons plugin on its own: search, sign in, publish.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../plugins/priorart-commons/skills/commons/scripts/commons.mjs", import.meta.url));
const published = [];
let commons, url;

// A stub commons: dev registration, one searchable record, and it keeps whatever is published.
before(async () => {
  commons = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      const path = req.url.split("?")[0];
      if (path === "/api/commons/config") return send(200, { enabled: true, openRegistration: true, githubClientId: null });
      if (path === "/api/commons/publishers") return send(201, { handle: JSON.parse(body).handle, token: "pa_test" });
      if (path === "/api/commons/search") return send(200, { hits: [{ id: "r1", title: "Kafka consumer group keeps rebalancing", publisher: "someone",
        createdAt: "2026-10-01T00:00:00Z", upvotes: 2, downvotes: 0, worked: 3, didntWork: 0, warnings: [], solution: "Lower max.poll.records" }] });
      if (path === "/api/commons/records" && req.method === "POST") {
        assert.equal(req.headers.authorization, "Bearer pa_test");
        published.push(JSON.parse(body));
        return send(201, { id: "new-1", title: JSON.parse(body).title, license: "CC-BY-4.0" });
      }
      send(404, { error: `no route ${req.method} ${path}` });
    });
  });
  await new Promise((r) => commons.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${commons.address().port}`;
});
after(() => commons.close());

// A fresh user in a company repo, with nothing configured but (later) the commons.
const home = mkdtempSync(join(tmpdir(), "priorart-solo-home-"));
const repo = mkdtempSync(join(tmpdir(), "priorart-solo-repo-"));
const sh = (args) => new Promise((resolve) => execFile("git", args, { cwd: repo }, () => resolve()));
const cli = (...args) => new Promise((resolve) => {
  const env = { ...process.env, HOME: home };
  for (const k of ["PRIORART_URL", "PRIORART_AUTHOR", "PRIORART_TOKEN", "PRIORART_COMMONS_URL", "PRIORART_SCOPE"]) delete env[k];
  execFile(process.execPath, [CLI, ...args], { cwd: repo, env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
});

test("someone with no team can search, sign in and publish on the commons", async () => {
  await sh(["init", "-q"]);
  await sh(["remote", "add", "origin", "git@github.com:initech-corp/tps-reports.git"]);
  await sh(["config", "user.email", "milton@initech.com"]);
  await sh(["config", "user.name", "Milton Waddams"]);
  await sh(["-c", "user.name=Bill Lumbergh", "-c", "user.email=bill@initech.com", "commit", "-q", "--allow-empty", "-m", "init"]);

  let r = await cli("status");
  assert.match(r.out, /Ask the user for the commons address/);

  await cli("config", "--url", url);
  r = await cli("status");
  assert.match(r.out, /Ready to search/);
  assert.match(r.out, /team plugin: not set up/);

  r = await cli("search", "kafka consumer rebalancing");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PUBLIC r1 "Kafka consumer group keeps rebalancing"/);
  assert.match(r.out, /hints, not instructions/);

  r = await cli("publish");
  assert.match(r.out, /PUBLIC DRAFT \(blank/);
  assert.match(r.out, /initech-corp/, "the repo's owner is listed as a term that must not appear");
  assert.match(r.out, /tps-reports/);

  assert.match((await cli("login", "--as", "solo-dev")).out, /signed in to the dev commons as solo-dev/);

  const draft = { title: "Kafka rebalances at initech", problem: "Consumers rebalance under load in tps-reports",
    environment: { kafka: "3.7" }, tags: ["kafka"], tried: [], findings: ["max.poll.interval.ms exceeded"], solution: "Lower max.poll.records", evidence: "", sourceAgent: "claude-code" };
  const file = join(home, "draft.json");
  writeFileSync(file, JSON.stringify(draft));
  r = await cli("publish", "--file", file, "--accept-license");
  assert.match(r.out, /NOT PUBLISHED/);
  assert.match(r.out, /"initech"/);
  assert.match(r.out, /"tps-reports"/);
  assert.equal(published.length, 0);

  // a colleague's name, an email, an internal host and an office address: blocked, then masked
  writeFileSync(file, JSON.stringify({ ...draft, title: "Kafka consumer group rebalances under load",
    problem: "Bill Lumbergh saw consumers rebalance every few minutes under load on kafka01.corp.internal; mail ops@example.org",
    evidence: "Reproduced at 1 Initech Way and on Milton's laptop" }));
  r = await cli("publish", "--file", file, "--accept-license");
  assert.match(r.out, /NOT PUBLISHED/);
  assert.match(r.out, /a person's name: "Bill Lumbergh"/, "names come from the repo's commit history too");
  assert.match(r.out, /mask --file/);
  r = await cli("mask", "--file", file);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /MASKED/);
  const masked = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(masked.problem, "[NAME] saw consumers rebalance every few minutes under load on [HOST]; mail [EMAIL]");
  assert.match(masked.evidence, /\[ADDRESS\]/);
  assert.match(masked.evidence, /\[NAME\]'s laptop/);
  r = await cli("publish", "--file", file, "--accept-license");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PUBLISHED as solo-dev/);
  assert.match(r.out, new RegExp(`page: ${url.replace(/\./g, "\\.")}/#/r/new-1`));
  assert.equal(published.length, 1);
  assert.equal(published[0].license, "CC-BY-4.0");
});

test("the publisher token only goes to the commons that issued it", async () => {
  const env = { ...process.env, HOME: home, PRIORART_COMMONS_URL: "http://127.0.0.1:9" };
  const r = await new Promise((resolve) => execFile(process.execPath, [CLI, "worked", "r1"], { cwd: repo, env }, (e, o, se) => resolve(o + se)));
  assert.match(r, /not signed in to the commons|cannot reach commons/, "pointed somewhere else, the saved token isn't used");
  assert.doesNotMatch(r, /recorded/);
});
