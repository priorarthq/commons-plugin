// node --test 'tests/*.test.mjs'   — what may and may not reach the public commons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSecrets, companyTerms, scanTerms, envFields } from "../plugins/priorart-commons/skills/commons/scripts/priorart-secrets.mjs";

test("credentials and internal addresses are found, and never echoed in full", () => {
  const cases = {
    "AWS access key": "key AKIAIOSFODNN7EXAMPLE here",
    "GitHub token": "ghp_" + "a".repeat(36),
    "private key": "-----BEGIN RSA PRIVATE KEY-----",
    "password assignment": "password=hunter2secret",
    "connection string with credentials": "postgres://admin:s3cret@db/prod",
    "private IP address": "db at 10.20.30.40",
    "email address": "ask jane.doe@acme-corp.com",
    "JWT": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  };
  for (const [kind, text] of Object.entries(cases)) {
    const found = scanSecrets(text);
    assert.ok(found.some((f) => f.kind === kind), `${kind} in ${text}`);
    for (const f of found) assert.ok(!f.preview.includes("hunter2secret") && !f.preview.includes("AKIAIOSFODNN7EXAMPLE"));
  }
});

test("ordinary technical text passes", () => {
  const text = "PostgreSQL 16 export job takes an ACCESS EXCLUSIVE lock; run it on a read replica. Timeout was 60s, see RFC 7231.";
  assert.deepEqual(scanSecrets(text), []);
});

test("company terms come from the record's origin, skipping generic words and public hosts", () => {
  const terms = companyTerms({
    repo: "gitlab.com/ops-team7/fin/ledger_platform", cwd: "/Users/jdoe/PycharmProjects/ledger_platform",
    team: "core", application: "ledger", handle: "jordan.doe", email: "jordan.doe@globexa.com",
  });
  for (const t of ["ops-team7", "fin", "ledger_platform", "jdoe", "ledger", "jordan", "doe", "globexa.com", "globexa"])
    assert.ok(terms.includes(t), `expected ${t} in ${terms}`);
  for (const t of ["gitlab.com", "core", "users"]) assert.ok(!terms.includes(t), `did not expect ${t}`);
  const privateHost = companyTerms({ repo: "ghe.acme.internal/payments/ledger" });
  for (const t of ["ghe.acme.internal", "acme", "payments", "ledger"]) assert.ok(privateHost.includes(t), `private host: expected ${t} in ${privateHost}`);
});

test("company terms match whole words only", () => {
  const terms = ["globexa", "fin", "ledger_platform"];
  assert.deepEqual(scanTerms("The ledger_platform repo at Globexa failed", terms).sort(), ["globexa", "ledger_platform"]);
  assert.deepEqual(scanTerms("the final finance figures", terms), [], "substrings of other words don't count");
});

test("obfuscations the red team used are caught by the client too", () => {
  for (const text of ["A K I A I O S F O D N N 7 E X A M P L E", "AKIA\u200bIOSFODNN7EXAMPLE", "akiaiosfodnn7example",
    "the password is Globex!Ledger2026", "db01.corp.internal", "10 . 0 . 0 . 5", Buffer.from("AKIAIOSFODNN7EXAMPLE").toString("base64")])
    assert.ok(scanSecrets(text).length, text);
  assert.ok(scanSecrets(["starts AKIAIOSF", "ODNN7EXAMPLE rest"]).length, "split across fields");
  assert.deepEqual(scanSecrets("Asia Pacific region latency rose in 2026; the token is valid for 60 minutes"), []);
});

test("a company label inside a dotted hostname is found", () => {
  assert.deepEqual(scanTerms("mirror at ora-mirror-02.globex.internal", ["globex"]), ["globex"]);
  assert.ok(companyTerms({ text: "ora-mirror-02.globex.internal timed out" }).includes("globex"));
});

test("round-2 bypasses are caught by the client too, once per secret", () => {
  assert.ok(scanSecrets("key \u0410KIAIOSFODNN7EXAMPLE").length, "Cyrillic А");
  assert.ok(scanSecrets("hex " + Buffer.from("AKIAIOSFODNN7EXAMPLE").toString("hex")).length, "hex");
  assert.ok(scanSecrets(["title ends AKIAIOSF", "nothing here", "ODNN7EXA", "mple"]).length, "3 fields");
  assert.equal(scanSecrets("the password is Globex!Ledger2026").filter((f) => f.kind === "password in prose").length, 1);
});


test("company terms are found inside '-' and '_' joined names", () => {
  assert.deepEqual(scanTerms("the shopco-prod cluster and the shopco_orders table", ["shopco"]), ["shopco"]);
  assert.deepEqual(scanTerms("picked the name ana-dev", ["ana"]), ["ana"]);
  assert.deepEqual(scanTerms("checkout-api-v2 and checkout_api_v3 are down", ["checkout-api"]), ["checkout-api"]);
  assert.deepEqual(scanTerms("the precheckout-api service", ["checkout-api"]), [], "still a whole name, not a substring");
  assert.deepEqual(scanTerms("banana bread", ["ana"]), []);
});

test("split tokens are glued back across fields, version numbers are not an address", () => {
  assert.deepEqual(scanSecrets(["node", "20.11", "npm", "10.2", "postgres", "16.4"]), []);
  assert.ok(scanSecrets(envFields({ creds: ["AKIAIOSFODNN7", "EXAMPLE"] })).length, "nested environment array");
  assert.ok(scanSecrets(envFields({ t: { a: "ghp_", b: "A".repeat(36) } })).length, "nested environment object");
});
