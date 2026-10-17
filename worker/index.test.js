import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { dayKey, nextDailyResetAt } from "./index.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, role TEXT DEFAULT 'user', display_name TEXT DEFAULT '', about_text TEXT DEFAULT '', default_model TEXT DEFAULT 'gpt-6-luna', memory_enabled INTEGER DEFAULT 1, reset_balance INTEGER DEFAULT 1, reset_last_grant_at INTEGER, created_at INTEGER);
    CREATE TABLE settings (id INTEGER PRIMARY KEY, daily_limit INTEGER, reset_interval_days INTEGER, reset_cap INTEGER, reset_grant_amount INTEGER);
    INSERT INTO settings VALUES (1, 30, 7, 3, 1);
    CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, model TEXT, messages_json TEXT, updated_at INTEGER);
    CREATE TABLE usage (user_id TEXT, day TEXT, count INTEGER, PRIMARY KEY(user_id,day));
    CREATE TABLE smart_usage (user_id TEXT, day TEXT, count INTEGER, PRIMARY KEY(user_id,day));
    CREATE TABLE files (id TEXT PRIMARY KEY, user_id TEXT, chat_id TEXT, name TEXT, mime TEXT, size INTEGER, r2_key TEXT, created_at INTEGER);
  `);
  sqlite.exec(readFileSync(new URL("./migrations/003_email_auth.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./migrations/004_telegram_auth.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./migrations/005_pins_memory.sql", import.meta.url), "utf8"));
  return {
    sqlite,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      const self = {
        bind(...values) { args = values; return self; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return statement.run(...args); },
      };
      return self;
    },
  };
}

function setupUser(db, id, token) {
  const now = Date.now();
  db.sqlite.prepare("INSERT INTO users (id, token_hash, reset_last_grant_at, created_at) VALUES (?, ?, ?, ?)").run(id, createHash("sha256").update(token).digest("hex"), now, now);
}

function makeRequest(path, token, method = "GET", body = null, extraHeaders = {}) {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: { Origin: "https://site.example.test", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const env = (db) => ({ DB: db, ALLOWED_ORIGIN: "https://site.example.test", ROUTER_CHEAP_API_KEY: "test-router-cheap", GEMINI_API_KEY: "test-gemini", OPENROUTER_API_KEY: "test-openrouter" });
const emailEnv = (db) => ({ ...env(db), EMAIL_AUTH_ENABLED: "true", EMAIL_AUTH_SECRET: "test-hmac-secret", RESEND_API_KEY: "test-resend", RESEND_FROM: "AI Studio <login@example.test>" });

test("pinned chats persist, sort first, remain private and can be unpinned", async context => {
  const db = database();
  context.after(() => db.sqlite.close());
  setupUser(db, "pin-owner", TOKEN_A);
  setupUser(db, "other-owner", TOKEN_B);
  const insert = db.sqlite.prepare("INSERT INTO chats VALUES (?, ?, ?, 'gemini-3.8-flash', '[]', ?)");
  insert.run("older", "pin-owner", "Older chat", 100);
  insert.run("newer", "pin-owner", "Newer chat", 200);
  const environment = env(db);
  const pin = () => worker.fetch(makeRequest("/api/chats/older/pin", TOKEN_A, "PUT", { pinned: true }), environment);
  const first = await (await pin()).json();
  assert.equal(first.pinned, true);
  assert.deepEqual(await (await pin()).json(), first);
  assert.equal((await worker.fetch(makeRequest("/api/chats/older/pin", TOKEN_B, "PUT", { pinned: true }), environment)).status, 404);
  const chats = (await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), environment)).json()).chats;
  assert.deepEqual(chats.map(c => c.id), ["older", "newer"]);
  assert.equal(chats[0].pinned, true);
  assert.equal((await (await worker.fetch(makeRequest("/api/chats", TOKEN_B), environment)).json()).chats.length, 0);
  await worker.fetch(makeRequest("/api/chats/older/pin", TOKEN_A, "PUT", { pinned: false }), environment);
  assert.deepEqual((await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), environment)).json()).chats.map(c => c.id), ["newer", "older"]);
});

test("AI memory updates a separate private summary without creating chats or spending chat quota", async context => {
  const db = database();
  setupUser(db, "memory-owner", TOKEN_A);
  setupUser(db, "memory-other", TOKEN_B);
  const originalFetch = globalThis.fetch;
  const received = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    received.push(body);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Изучает английский язык." }) }] } }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = env(db);
  const updated = await worker.fetch(makeRequest("/api/memory", TOKEN_A, "POST", { command: "я учу английский", version: 0 }), environment);
  assert.equal(updated.status, 200);
  const memory = await updated.json();
  assert.equal(memory.version, 1);
  assert.equal(memory.remaining, 9);
  assert.match(memory.summary, /английский/);
  assert.match(received.find(body => body.systemInstruction).contents[0].parts[0].text, /я учу английский/);
  assert.match(received.find(body => body.systemInstruction).systemInstruction.parts[0].text, /без команды/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM smart_usage").get().n, 0);
  assert.equal((await (await worker.fetch(makeRequest("/api/memory", TOKEN_B), environment)).json()).summary, "");
  assert.equal((await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), environment)).json()).summary, memory.summary);
  await worker.fetch(makeRequest("/api/chats", TOKEN_A, "DELETE"), environment);
  assert.equal((await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), environment)).json()).summary, memory.summary);
  const stale = await worker.fetch(makeRequest("/api/memory", TOKEN_A, "POST", { command: "Удали всё", version: 0 }), environment);
  assert.equal(stale.status, 409);
  assert.equal(received.length, 2);
});

test("memory summary enters normal model context only with memory enabled, never temporary chats", async context => {
  const db = database();
  setupUser(db, "context-owner", TOKEN_A);
  db.sqlite.prepare("INSERT INTO memory_summaries VALUES (?, ?, 1, ?)").run("context-owner", "SECRET_MEMORY_FACT", Date.now());
  const originalFetch = globalThis.fetch;
  const contexts = [];
  globalThis.fetch = async (_url, options) => { contexts.push(JSON.parse(options.body).systemInstruction.parts[0].text); return Response.json({ candidates: [{ content: { parts: [{ text: "Ответ" }] } }] }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const chat = temporary => worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary, model: "gemini-3.8-flash", thinking: "low", content: "Привет", files: [], history: [] }), env(db));
  assert.equal((await chat(false)).status, 200);
  assert.match(contexts[0], /SECRET_MEMORY_FACT/);
  assert.equal((await chat(true)).status, 200);
  assert.ok(!contexts[1].includes("SECRET_MEMORY_FACT"));
  db.sqlite.exec("UPDATE users SET memory_enabled = 0");
  assert.equal((await chat(false)).status, 200);
  assert.ok(!contexts[2].includes("SECRET_MEMORY_FACT"));
});

test("normal chats automatically update memory in the same provider call without exposing metadata", async context => {
  const db = database();
  setupUser(db, "auto-memory", TOKEN_A);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    const instructions = body.instructions || body.systemInstruction?.parts[0].text || body.messages[0].content;
    const marker = instructions.match(/AI_STUDIO_MEMORY_[a-f0-9]{32}/)?.[0];
    assert.ok(marker);
    const text = `Помогу с изучением английского.\n<${marker}>${JSON.stringify({ summary: `Пользователь учит английский. Версия ${requests}.` })}</${marker}>`;
    if (String(url).includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
    if (String(url).includes('openrouter')) return Response.json({ choices: [{ message: { content: text } }] });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  for (const model of ["gpt-6-luna", "gemini-3.8-flash", "nemotron-3-ultra"]) {
    const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model, content: "я учу английский", files: [], thinking: "low" }), env(db));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.memoryUpdated, true);
    assert.equal(result.answer, "Помогу с изучением английского.");
  }
  assert.equal(requests, 3);
  const memory = await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), env(db))).json();
  assert.match(memory.summary, /английский/);
  assert.equal(memory.version, 3);
  assert.equal(memory.remaining, 10);
  assert.equal(db.sqlite.prepare("SELECT count FROM usage WHERE user_id = 'auto-memory'").get().count, 3);
  const rows = db.sqlite.prepare("SELECT messages_json FROM chats").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => !row.messages_json.includes("AI_STUDIO_MEMORY")));
});

test("automatic memory stays off in temporary chats and respects memory disabled during a request", async context => {
  const db = database();
  setupUser(db, "auto-private", TOKEN_A);
  const originalFetch = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = async (_url, options) => {
    const instructions = JSON.parse(options.body).systemInstruction.parts[0].text;
    const marker = instructions.match(/AI_STUDIO_MEMORY_[a-f0-9]{32}/)?.[0];
    turn++;
    if (turn < 3) assert.equal(marker, undefined);
    if (turn === 3) db.sqlite.exec("UPDATE users SET memory_enabled = 0 WHERE id = 'auto-private'");
    return Response.json({ candidates: [{ content: { parts: [{ text: marker ? `Ответ\n<${marker}>{"summary":"Не сохранять"}</${marker}>` : "Ответ" }] } }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const chat = temporary => worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary, model: "gemini-3.8-flash", content: "Обо мне", files: [], thinking: "low" }), env(db));
  assert.equal((await chat(true)).status, 200);
  db.sqlite.exec("UPDATE users SET memory_enabled = 0");
  assert.equal((await chat(false)).status, 200);
  db.sqlite.exec("UPDATE users SET memory_enabled = 1");
  const response = await chat(false);
  assert.equal((await response.json()).memoryUpdated, false);
  const summary = await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), env(db))).json();
  assert.equal(summary.summary, "");
});

test("malformed memory metadata cannot corrupt summary or leak into chat history", async context => {
  const db = database();
  setupUser(db, "auto-malformed", TOKEN_A);
  db.sqlite.prepare("INSERT INTO memory_summaries VALUES (?, 'Keep this', 1, ?)").run("auto-malformed", Date.now());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const marker = JSON.parse(options.body).systemInstruction.parts[0].text.match(/AI_STUDIO_MEMORY_[a-f0-9]{32}/)[0];
    return Response.json({ candidates: [{ content: { parts: [{ text: `Обычный ответ\n<${marker}>{broken` }] } }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", content: "Привет", files: [], thinking: "low" }), env(db));
  const data = await response.json();
  assert.equal(data.answer, "Обычный ответ");
  assert.equal(data.memoryUpdated, false);
  assert.equal(db.sqlite.prepare("SELECT summary FROM memory_summaries WHERE user_id = 'auto-malformed'").get().summary, "Keep this");
});

test("memory accepts a plain fact through Luna without a normal chat request", async context => {
  const db = database();
  setupUser(db, "memory-luna", TOKEN_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://router.cheap/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-6-luna");
    assert.match(JSON.stringify(body.input), /я учу английский/);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Пользователь учит английский." }) }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const result = await worker.fetch(makeRequest("/api/memory", TOKEN_A, "POST", { command: "я учу английский", version: 0 }), env(db));
  assert.equal(result.status, 200);
  assert.match((await result.json()).summary, /английский/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chats").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 0);
});

test("memory page toggle updates only the owner's memory setting and preserves profile and summary", async context => {
  const db = database();
  context.after(() => db.sqlite.close());
  setupUser(db, "toggle-owner", TOKEN_A);
  setupUser(db, "toggle-other", TOKEN_B);
  db.sqlite.exec("UPDATE users SET display_name = 'Saved name', about_text = 'Saved about'");
  db.sqlite.prepare("INSERT INTO memory_summaries VALUES (?, 'Saved summary', 2, ?)").run("toggle-owner", Date.now());
  const response = await worker.fetch(makeRequest("/api/memory/settings", TOKEN_A, "PUT", { memoryEnabled: false }), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).memoryEnabled, false);
  const profile = await (await worker.fetch(makeRequest("/api/profile", TOKEN_A), env(db))).json();
  assert.equal(profile.displayName, "Saved name");
  assert.equal(profile.aboutText, "Saved about");
  assert.equal(profile.memoryEnabled, false);
  assert.equal((await (await worker.fetch(makeRequest("/api/profile", TOKEN_B), env(db))).json()).memoryEnabled, true);
  const summary = await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), env(db))).json();
  assert.equal(summary.summary, "Saved summary");
  assert.equal(summary.version, 2);
  assert.equal((await worker.fetch(makeRequest("/api/memory/settings", TOKEN_A, "PUT", { memoryEnabled: "true" }), env(db))).status, 400);
});

test("memory updates have a separate daily cap, failed updates are refunded, and clearing works", async context => {
  const db = database();
  setupUser(db, "memory-limits", TOKEN_A);
  const originalFetch = globalThis.fetch;
  let bad = true;
  globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: bad ? "invalid JSON" : JSON.stringify({ summary: "" }) }] } }] });
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const update = version => worker.fetch(makeRequest("/api/memory", TOKEN_A, "POST", { command: "Очисти всю память", version }), env(db));
  assert.equal((await update(0)).status, 502);
  assert.equal((await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), env(db))).json()).remaining, 10);
  bad = false;
  for (let version = 0; version < 10; version++) {
    const r = await update(version);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).summary, "");
  }
  assert.equal((await update(10)).status, 429);
  const me = await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json();
  assert.equal(me.remaining, 30);
  assert.equal(me.smartRemaining, 5);
});

test("concurrent memory updates cannot overwrite another version", async context => {
  const db = database();
  setupUser(db, "memory-race", TOKEN_A);
  db.sqlite.prepare("INSERT INTO memory_summaries VALUES (?, 'old', 0, ?)").run("memory-race", Date.now());
  const originalFetch = globalThis.fetch;
  let complete;
  const wait = new Promise(resolve => { complete = resolve; });
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 2) complete(); await wait; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "new" }) }] } }] }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const results = await Promise.all([1, 2].map(() => worker.fetch(makeRequest("/api/memory", TOKEN_A, "POST", { command: "Обнови", version: 0 }), env(db))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await worker.fetch(makeRequest("/api/memory", TOKEN_A), env(db))).json()).remaining, 9);
});
const telegramEnv = db => ({ ...env(db), TELEGRAM_AUTH_ENABLED: "true", TELEGRAM_CLIENT_ID: "8890017118" });
const telegramKey = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
async function mockTelegram(context) {
  const originalFetch = globalThis.fetch;
  const jwk = { ...await crypto.subtle.exportKey("jwk", telegramKey.publicKey), kid: "test-telegram", alg: "RS256", use: "sig" };
  globalThis.fetch = async url => {
    assert.equal(url, "https://oauth.telegram.org/.well-known/jwks.json");
    return Response.json({ keys: [jwk] });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
}
async function telegramToken(nonce, overrides = {}, headerOverrides = {}) {
  const enc = data => Buffer.from(JSON.stringify(data)).toString("base64url");
  const header = enc({ alg: "RS256", kid: "test-telegram", ...headerOverrides });
  const now = Math.floor(Date.now() / 1000);
  const payload = enc({ iss: "https://oauth.telegram.org", aud: "8890017118", sub: "123456789", iat: now, exp: now + 300, nonce, name: "Telegram User", preferred_username: "test_user", ...overrides });
  const signed = `${header}.${payload}`;
  return `${signed}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", telegramKey.privateKey, new TextEncoder().encode(signed))).toString("base64url")}`;
}

test("Telegram signs in to a persistent separate account, preserves chats and quota, and revokes sessions", async context => {
  const db = database();
  context.after(() => db.sqlite.close());
  await mockTelegram(context);
  setupUser(db, "legacy-admin", TOKEN_A);
  db.sqlite.exec("UPDATE users SET role = 'admin' WHERE id = 'legacy-admin'");
  const environment = telegramEnv(db);
  const login = async () => {
    const challenge = await (await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), environment)).json();
    const result = await worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...challenge, idToken: await telegramToken(challenge.nonce) }), environment);
    assert.equal(result.status, 200);
    return { ...await result.json(), challenge };
  };
  const first = await login();
  const me = await (await worker.fetch(makeRequest("/api/me", first.token), environment)).json();
  assert.equal(me.authType, "telegram");
  assert.equal(me.telegramUsername, "test_user");
  assert.equal(me.role, "user");
  assert.equal(me.remaining, 30);
  assert.equal(me.smartRemaining, 5);
  const tgId = db.sqlite.prepare("SELECT user_id FROM telegram_accounts").get().user_id;
  db.sqlite.prepare("UPDATE users SET display_name = 'Custom name' WHERE id = ?").run(tgId);
  db.sqlite.prepare("INSERT INTO usage VALUES (?, ?, 7)").run(tgId, dayKey());
  db.sqlite.prepare("INSERT INTO chats VALUES ('tg-chat', ?, 'Saved chat', 'gpt-6-luna', '[]', ?)").run(tgId, Date.now());
  const second = await login();
  assert.notEqual(second.token, first.token);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", second.token), environment)).json()).remaining, 23);
  assert.equal((await (await worker.fetch(makeRequest("/api/profile", second.token), environment)).json()).displayName, "Custom name");
  const chats = await (await worker.fetch(makeRequest("/api/chats", second.token), environment)).json();
  assert.ok(JSON.stringify(chats).includes("tg-chat"));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_sessions WHERE token_hash = ?").get(first.token).n, 0);
  const replay = await worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...first.challenge, idToken: await telegramToken(first.challenge.nonce) }), environment);
  assert.equal(replay.status, 400);
  await worker.fetch(makeRequest("/api/auth/logout", first.token, "POST", {}), environment);
  assert.equal((await worker.fetch(makeRequest("/api/me", first.token), environment)).status, 401);
  assert.equal((await worker.fetch(makeRequest("/api/me", second.token), environment)).status, 200);
  db.sqlite.exec("UPDATE telegram_sessions SET expires_at = 0");
  assert.equal((await worker.fetch(makeRequest("/api/me", second.token), environment)).status, 401);
  assert.equal((await worker.fetch(makeRequest("/api/me", TOKEN_A), environment)).status, 200);
});

test("Telegram rejects forged, expired, wrong audience, wrong nonce and unsupported algorithm tokens", async context => {
  const db = database();
  context.after(() => db.sqlite.close());
  await mockTelegram(context);
  const environment = telegramEnv(db);
  const challenge = await (await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), environment)).json();
  const badTokens = [
    await telegramToken(challenge.nonce, { aud: "another-app" }),
    await telegramToken(challenge.nonce, { iss: "https://evil.test" }),
    await telegramToken(challenge.nonce, { exp: 1 }),
    await telegramToken(challenge.nonce, { iat: 1 }),
    await telegramToken("another-nonce"),
    await telegramToken(challenge.nonce, {}, { alg: "none" }),
    (await telegramToken(challenge.nonce)).split(".").slice(0, 2).join(".") + ".AAAA",
  ];
  for (const idToken of badTokens) assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...challenge, idToken }), environment)).status, 401);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  const validToken = await telegramToken(challenge.nonce);
  assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...challenge, verifier: "x".repeat(43), idToken: validToken }), environment)).status, 400);
  db.sqlite.exec("UPDATE telegram_challenges SET expires_at = 0");
  assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...challenge, idToken: validToken }), environment)).status, 400);
});

test("Telegram challenge is single use under concurrent verification and starting login is throttled", async context => {
  const db = database();
  context.after(() => db.sqlite.close());
  await mockTelegram(context);
  const environment = telegramEnv(db);
  const challenge = await (await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), environment)).json();
  const idToken = await telegramToken(challenge.nonce);
  const results = await Promise.all([0, 1].map(() => worker.fetch(makeRequest("/api/auth/telegram/verify", null, "POST", { ...challenge, idToken }), environment)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_sessions").get().n, 1);
  db.sqlite.exec("UPDATE auth_rate_limits SET expires_at = 0");
  for (let i = 0; i < 20; i++) assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), environment)).status, 200);
  assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), environment)).status, 429);
  assert.equal((await worker.fetch(makeRequest("/api/auth/telegram/challenge", null, "POST", {}), env(db))).status, 503);
});

test("email code creates a separate user, stores only hashes, and cannot be replayed", async (context) => {
  const db = database();
  setupUser(db, "old-link-user", TOKEN_A);
  db.sqlite.exec("UPDATE users SET role = 'admin' WHERE id = 'old-link-user'");
  const originalFetch = globalThis.fetch;
  let mail;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers.Authorization, "Bearer test-resend");
    mail = JSON.parse(options.body);
    return Response.json({ id: "test-mail" });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = emailEnv(db);
  const requested = await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: " New.User@Example.com " }), environment);
  assert.equal(requested.status, 200);
  const challenge = await requested.json();
  assert.deepEqual(mail.to, ["new.user@example.com"]);
  const code = mail.text.match(/\b\d{6}\b/)[0];
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  const stored = db.sqlite.prepare("SELECT code_hash FROM email_challenges WHERE id = ?").get(challenge.challengeId);
  assert.equal(stored.code_hash.length, 64);
  assert.notEqual(stored.code_hash, createHash("sha256").update(code).digest("hex"));
  const verified = await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment);
  assert.equal(verified.status, 200);
  const login = await verified.json();
  const me = await (await worker.fetch(makeRequest("/api/me", login.token), environment)).json();
  assert.equal(me.authType, "email");
  assert.equal(me.email, "new.user@example.com");
  assert.equal(me.role, "user");
  assert.equal(me.limit, 30);
  assert.equal(me.smartRemaining, 5);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM email_sessions WHERE token_hash = ?").get(login.token).n, 0);
  const replay = await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment);
  assert.equal(replay.status, 400);
  const oldMe = await (await worker.fetch(makeRequest("/api/me", TOKEN_A), environment)).json();
  assert.equal(oldMe.authType, "link");
  assert.equal(oldMe.role, "admin");
  const logout = await worker.fetch(makeRequest("/api/auth/logout", login.token, "POST", {}), environment);
  assert.equal(logout.status, 200);
  assert.equal((await worker.fetch(makeRequest("/api/me", login.token), environment)).status, 401);
});

test("email resend is throttled and a code allows only five guesses", async (context) => {
  const db = database();
  let code;
  let sends = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { sends++; code = JSON.parse(options.body).text.match(/\b\d{6}\b/)[0]; return Response.json({ id: "sent" }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = emailEnv(db);
  const requestCode = () => worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "user@example.com" }), environment);
  const challenge = await (await requestCode()).json();
  assert.equal((await requestCode()).status, 429);
  assert.equal(sends, 1);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code: wrong }), environment);
    assert.equal(response.status, 400);
  }
  assert.equal((await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment)).status, 400);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM email_sessions").get().n, 0);
});

test("concurrent verification of one email code creates only one session", async (context) => {
  const db = database();
  let code;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { code = JSON.parse(options.body).text.match(/\b\d{6}\b/)[0]; return Response.json({ id: "sent" }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = emailEnv(db);
  const challenge = await (await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "race@example.com" }), environment)).json();
  const results = await Promise.all([0, 1].map(() => worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM email_sessions").get().n, 1);
});

test("repeat email sign-in uses the same account and expired sessions cannot authenticate", async (context) => {
  const db = database();
  let code;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { code = JSON.parse(options.body).text.match(/\b\d{6}\b/)[0]; return Response.json({ id: "sent" }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = emailEnv(db);
  async function signIn() {
    db.sqlite.exec("UPDATE auth_rate_limits SET expires_at = 0");
    const challenge = await (await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "same@example.com" }), environment)).json();
    return (await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment)).json();
  }
  const first = await signIn();
  db.sqlite.prepare("UPDATE users SET display_name = 'Сохранённое имя' WHERE id = (SELECT user_id FROM email_accounts WHERE email = ?)").run("same@example.com");
  const second = await signIn();
  assert.notEqual(first.token, second.token);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  const profile = await (await worker.fetch(makeRequest("/api/profile", second.token), environment)).json();
  assert.equal(profile.displayName, "Сохранённое имя");
  db.sqlite.exec("UPDATE email_sessions SET expires_at = 0");
  assert.equal((await worker.fetch(makeRequest("/api/me", second.token), environment)).status, 401);
});

test("expired or unsent email codes cannot log in and disabled auth never sends", async (context) => {
  const db = database();
  let code;
  const originalFetch = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (_url, options) => { code = JSON.parse(options.body).text.match(/\b\d{6}\b/)[0]; return failed ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ id: "sent" }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = emailEnv(db);
  const disabled = await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "user@example.com" }), env(db));
  assert.equal(disabled.status, 503);
  const challenge = await (await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "user@example.com" }), environment)).json();
  db.sqlite.exec("UPDATE email_challenges SET expires_at = 0");
  assert.equal((await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: challenge.challengeId, code }), environment)).status, 400);
  failed = true;
  db.sqlite.exec("UPDATE auth_rate_limits SET expires_at = 0");
  const sendFailure = await worker.fetch(makeRequest("/api/auth/request-code", null, "POST", { email: "user@example.com" }), environment);
  assert.equal(sendFailure.status, 502);
  const pending = db.sqlite.prepare("SELECT id FROM email_challenges WHERE state = 'failed'").get();
  assert.equal((await worker.fetch(makeRequest("/api/auth/verify-code", null, "POST", { challengeId: pending.id, code }), environment)).status, 400);
});

test("GPT-6 Astra uses router.cheap and can be selected as default", async (context) => {
  const db = database();
  setupUser(db, "astra-user", TOKEN_A);
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) };
    return Response.json({ output: [{ content: [{ type: "output_text", text: "Привет от Astra" }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = env(db);
  const profile = await worker.fetch(makeRequest("/api/profile", TOKEN_A, "PUT", { defaultModel: "gpt-6-astra" }), environment);
  assert.equal((await profile.json()).defaultModel, "gpt-6-astra");
  const chat = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-astra", thinking: "low", content: "Привет", files: [] }), environment);
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).answer, "Привет от Astra");
  assert.equal(request.url, "https://router.cheap/v1/responses");
  assert.equal(request.authorization, "Bearer test-router-cheap");
  assert.equal(request.body.model, "gpt-6-astra");
  assert.deepEqual(request.body.reasoning, { effort: "low" });
});

test("Luna and Sol use router.cheap and are available for new chats", async (context) => {
  const db = database();
  setupUser(db, "gpt-user", TOKEN_A);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    return Response.json({ output: [{ content: [{ type: "output_text", text: "Ответ GPT" }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  for (const model of ["gpt-6-luna", "gpt-6-sol"]) {
    const profile = await worker.fetch(makeRequest("/api/profile", TOKEN_A, "PUT", { defaultModel: model }), env(db));
    assert.equal((await profile.json()).defaultModel, model);
    const chat = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model, thinking: "low", content: "Привет", files: [] }), env(db));
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).answer, "Ответ GPT");
  }
  assert.deepEqual(requests.map((request) => request.body.model), ["gpt-6-luna", "gpt-6-sol"]);
  assert.ok(requests.every((request) => request.url === "https://router.cheap/v1/responses" && request.authorization === "Bearer test-router-cheap"));
});

test("Astra and Sol share five daily requests without using the ordinary limit", async (context) => {
  const db = database();
  setupUser(db, "smart-user", TOKEN_A);
  db.sqlite.exec("UPDATE settings SET daily_limit = 1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ output: [{ content: [{ type: "output_text", text: "Готово" }] }] });
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  for (let index = 0; index < 5; index++) {
    const model = index % 2 ? "gpt-6-sol" : "gpt-6-astra";
    const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model, thinking: "low", content: "Привет", files: [] }), env(db));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.smartRemaining, 4 - index);
    assert.equal(result.remaining, 1);
  }
  const blocked = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-astra", thinking: "low", content: "Ещё", files: [] }), env(db));
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Astra и Sol/);
  const ordinary = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-luna", thinking: "low", content: "Обычный запрос", files: [] }), env(db));
  assert.equal(ordinary.status, 200);
  const me = await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json();
  assert.equal(me.remaining, 0);
  assert.equal(me.smartRemaining, 0);
  assert.equal(me.smartLimit, 5);
  assert.equal(db.sqlite.prepare("SELECT count FROM usage WHERE user_id = 'smart-user'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT count FROM smart_usage WHERE user_id = 'smart-user'").get().count, 5);
});

test("failed smart-model requests return their separate allowance", async (context) => {
  const db = database();
  setupUser(db, "smart-failure", TOKEN_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: "Provider unavailable" } }, { status: 503 });
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-sol", thinking: "low", content: "Привет", files: [] }), env(db));
  assert.equal(response.status, 502);
  const me = await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json();
  assert.equal(me.smartRemaining, 5);
  assert.equal(me.remaining, 30);
});

test("OpenRouter models use their own IDs, thinking levels, and supported attachments", async (context) => {
  const db = database();
  setupUser(db, "router-user", TOKEN_A);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: "Ответ модели" } }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = env(db);
  const textFile = { name: "note.txt", type: "text/plain", size: 6, data: Buffer.from("Привет").toString("base64") };
  const nemotron = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "nemotron-3-ultra", thinking: "high", content: "Прочти", files: [textFile] }), environment);
  assert.equal(nemotron.status, 200);
  assert.equal((await nemotron.json()).answer, "Ответ модели");
  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer test-openrouter");
  assert.equal(requests[0].body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.deepEqual(requests[0].body.reasoning, { effort: "high" });
  assert.match(requests[0].body.messages.at(-1).content, /Файл «note\.txt»:.*Привет/s);
  const image = { name: "picture.png", type: "image/png", size: 3, data: Buffer.from("png").toString("base64") };
  const rejected = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "nemotron-3-ultra", thinking: "low", content: "Опиши", files: [image] }), environment);
  assert.equal(rejected.status, 400);
  assert.equal(requests.length, 1);
  assert.equal(db.sqlite.prepare("SELECT count FROM usage WHERE user_id = 'router-user'").get().count, 1);
});

test("upstream free-model rate limits are explained and do not spend daily quota", async (context) => {
  const db = database();
  setupUser(db, "rate-limited-user", TOKEN_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: "Provider returned error", metadata: { limit_source: "upstream_provider_shared_pool" } } }, { status: 429 });
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "nemotron-3-ultra", thinking: "low", content: "Привет", files: [] }), env(db));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Бесплатный сервер.*временно перегружен/);
  assert.equal(db.sqlite.prepare("SELECT count FROM usage WHERE user_id = 'rate-limited-user'").get().count, 0);
});

test("daily quota rolls over at midnight in Moscow", () => {
  const before = Date.parse("2026-09-26T20:59:59Z");
  const after = Date.parse("2026-09-26T21:00:00Z");
  assert.equal(dayKey(before), "2026-09-26");
  assert.equal(dayKey(after), "2026-09-27");
  assert.ok(nextDailyResetAt(before) >= after);
  assert.ok(nextDailyResetAt(before) < after + 1000);
});

test("voice transcription is capped separately and a spoken chat uses one daily request", async (context) => {
  const db = database();
  setupUser(db, "voice-user", TOKEN_A);
  db.sqlite.exec("UPDATE settings SET daily_limit = 1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("gemini-3.8-flash:generateContent")) {
      const body = JSON.parse(options.body);
      assert.equal(body.contents[0].parts[1].inline_data.mime_type, "audio/webm");
      return Response.json({ candidates: [{ content: { parts: [{ text: "Привет, помощник" }] } }] });
    }
    return Response.json({ output: [{ content: [{ type: "output_text", text: "Текстовый ответ" }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  function voiceRequest() {
    const form = new FormData();
    form.set("audio", new File([new Uint8Array(200)], "speech.webm", { type: "audio/webm" }));
    return new Request("https://api.example.test/api/transcribe", { method: "POST", headers: { Origin: "https://site.example.test", Authorization: `Bearer ${TOKEN_A}` }, body: form });
  }
  const transcription = await worker.fetch(voiceRequest(), env(db));
  assert.equal(transcription.status, 200);
  assert.equal((await transcription.json()).text, "Привет, помощник");
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).remaining, 1);
  const blockedVoice = await worker.fetch(voiceRequest(), env(db));
  assert.equal(blockedVoice.status, 429);
  const chat = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gpt-6-luna", thinking: "medium", content: "Привет, помощник", files: [] }), env(db));
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).answer, "Текстовый ответ");
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).remaining, 0);
});

test("Gemini chat and voice try backup keys before returning an error", async (context) => {
  const db = database();
  setupUser(db, "backup-user", TOKEN_A);
  const keys = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const key = options.headers["x-goog-api-key"];
    keys.push(key);
    const isVoice = JSON.parse(options.body).contents[0].parts.some((part) => part.inline_data);
    if (key === "primary" || (isVoice && key === "backup-one")) return Response.json({ error: { message: "Unavailable" } }, { status: 429 });
    return Response.json({ candidates: [{ content: { parts: [{ text: isVoice ? "Голосовой текст" : "Ответ Gemini" }] } }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = { ...env(db), GEMINI_API_KEY: "primary", GEMINI_API_KEY_BACKUP_1: "backup-one", GEMINI_API_KEY_BACKUP_2: "backup-two", GEMINI_API_KEY_BACKUP_3: "backup-three" };
  const chat = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gemini-3.8-flash", thinking: "low", content: "Привет", files: [] }), environment);
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).answer, "Ответ Gemini");
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(200)], "speech.webm", { type: "audio/webm" }));
  const voice = await worker.fetch(new Request("https://api.example.test/api/transcribe", { method: "POST", headers: { Origin: "https://site.example.test", Authorization: `Bearer ${TOKEN_A}` }, body: form }), environment);
  assert.equal(voice.status, 200);
  assert.equal((await voice.json()).text, "Голосовой текст");
  assert.deepEqual(keys, ["primary", "backup-one", "primary", "backup-one", "backup-two"]);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), environment)).json()).remaining, 29);
});

test("browser preflight allows saving profile settings", async () => {
  const response = await worker.fetch(new Request("https://api.example.test/api/profile", {
    method: "OPTIONS",
    headers: { Origin: "https://site.example.test", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" },
  }), { ALLOWED_ORIGIN: "https://site.example.test" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://site.example.test");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /\bPUT\b/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("personal links isolate chats and share daily quota", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  setupUser(db, "user-b", TOKEN_B);
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return Response.json({ output: [{ content: [{ type: "output_text", text: "Ответ" }] }] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });

  const unauthorized = await worker.fetch(makeRequest("/api/me", "z".repeat(43)), env(db));
  assert.equal(unauthorized.status, 401);

  const first = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { chatId: "local-id", model: "gpt-6-luna", thinking: "high", content: "Привет", files: [] }), env(db));
  assert.equal(first.status, 200);
  const { chatId } = await first.json();
  assert.notEqual(chatId, "local-id");
  assert.equal(seen[0].body.reasoning.effort, "high");

  const second = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { chatId, model: "gpt-6-luna", thinking: "medium", content: "Продолжи", files: [] }), env(db));
  assert.equal(second.status, 200);
  assert.equal(seen[1].body.input[0].content, "Привет");
  assert.equal(seen[1].body.input[1].content, "Ответ");

  const aChats = await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), env(db))).json();
  const bChats = await (await worker.fetch(makeRequest("/api/chats", TOKEN_B), env(db))).json();
  assert.equal(aChats.chats.length, 1);
  assert.equal(bChats.chats.length, 0);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).remaining, 28);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_B), env(db))).json()).remaining, 30);

  const foreign = await worker.fetch(makeRequest("/api/chat", TOKEN_B, "POST", { chatId, model: "gpt-6-luna", thinking: "medium", content: "Чужой чат", files: [] }), env(db));
  assert.equal(foreign.status, 200);
  assert.notEqual((await foreign.json()).chatId, chatId);
});

test("quota stops the 31st request and invalid files do not use quota", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: "Ок" }] } }] }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const bad = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", thinking: "none", content: "Привет", files: [] }), env(db));
  assert.equal(bad.status, 400);
  const badFile = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", thinking: "medium", content: "Привет", files: [{ name: "archive.zip", type: "application/zip", size: 2, data: "YWE=" }] }), env(db));
  assert.equal(badFile.status, 400);
  for (let i = 0; i < 30; i++) {
    const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", thinking: "low", content: "Привет", files: [] }), env(db));
    assert.equal(response.status, 200);
  }
  const blocked = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", thinking: "low", content: "Ещё", files: [] }), env(db));
  assert.equal(blocked.status, 429);
  assert.equal(calls, 30);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).remaining, 0);
  const reset = await worker.fetch(makeRequest("/api/reset", TOKEN_A, "POST", {}), env(db));
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).remaining, 30);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).resetBalance, 0);
});

test("temporary chat uses quota without saving, profile and memory reach the provider", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { seen.push(JSON.parse(options.body)); return Response.json({ output: [{ content: [{ type: "output_text", text: "Запомнил" }] }] }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });

  const profile = await worker.fetch(makeRequest("/api/profile", TOKEN_A, "PUT", { displayName: "Юра", aboutText: "Люблю программировать", defaultModel: "gemini-3.8-flash", memoryEnabled: true }), env(db));
  assert.equal(profile.status, 200);
  assert.equal((await (await worker.fetch(makeRequest("/api/profile", TOKEN_A), env(db))).json()).defaultModel, "gemini-3.8-flash");
  const first = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gpt-6-luna", thinking: "medium", content: "Мой проект про космос", files: [] }), env(db));
  assert.equal(first.status, 200);
  const second = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gpt-6-luna", thinking: "medium", content: "Что с проектом про космос?", files: [] }), env(db));
  assert.equal(second.status, 200);
  assert.match(seen[1].instructions, /Юра/);
  assert.match(seen[1].instructions, /проект про космос/);
  const temporary = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-luna", thinking: "medium", content: "Временный секрет", files: [], history: [] }), env(db));
  assert.equal(temporary.status, 200);
  assert.equal((await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), env(db))).json()).chats.length, 2);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json()).remaining, 27);
  assert.doesNotMatch(seen[2].instructions, /проект про космос/);
});

test("admin can change reset policy and create personal links", async (context) => {
  const db = database();
  setupUser(db, "admin", TOKEN_A);
  db.sqlite.prepare("UPDATE users SET role='admin' WHERE id='admin'").run();
  setupUser(db, "user-b", TOKEN_B);
  context.after(() => db.sqlite.close());
  const password = "test-admin-password";
  const adminEnv = { ...env(db), ADMIN_PASSWORD_HASH: createHash("sha256").update(password).digest("hex") };
  const adminHeaders = { "X-Admin-Password": password };
  const denied = await worker.fetch(makeRequest("/api/admin/settings", TOKEN_B, "GET", null, adminHeaders), adminEnv);
  assert.equal(denied.status, 403);
  assert.equal((await worker.fetch(makeRequest("/api/admin/settings", TOKEN_A), adminEnv)).status, 401);
  assert.equal((await worker.fetch(makeRequest("/api/admin/settings", TOKEN_A, "GET", null, { "X-Admin-Password": "wrong" }), adminEnv)).status, 401);
  const changed = await worker.fetch(makeRequest("/api/admin/settings", TOKEN_A, "PUT", { dailyLimit: 35, resetIntervalDays: 2, resetCap: 5, resetGrantAmount: 2 }, adminHeaders), adminEnv);
  assert.equal(changed.status, 200);
  assert.equal((await (await worker.fetch(makeRequest("/api/me", TOKEN_B), env(db))).json()).limit, 35);
  const invite = await worker.fetch(makeRequest("/api/admin/invite", TOKEN_A, "POST", {}, adminHeaders), adminEnv);
  assert.equal(invite.status, 200);
  const created = await invite.json();
  assert.equal((await worker.fetch(makeRequest("/api/me", created.token), env(db))).status, 200);
});

test("admin grants one reset to every user up to the shared cap", async () => {
  const db = database();
  setupUser(db, "admin", TOKEN_A);
  setupUser(db, "user-b", TOKEN_B);
  setupUser(db, "user-c", "c".repeat(43));
  db.sqlite.exec("UPDATE users SET role = 'admin', reset_balance = 2 WHERE id = 'admin'; UPDATE users SET reset_balance = 3 WHERE id = 'user-b'; UPDATE users SET reset_balance = 0 WHERE id = 'user-c'");
  const password = "test-admin-password";
  const environment = { ...env(db), ADMIN_PASSWORD_HASH: createHash("sha256").update(password).digest("hex") };
  const path = "/api/admin/grant-all";
  assert.equal((await worker.fetch(makeRequest(path, TOKEN_B, "POST", {}), environment)).status, 403);
  assert.equal((await worker.fetch(makeRequest(path, TOKEN_A, "POST", {}), environment)).status, 401);
  const granted = await worker.fetch(makeRequest(path, TOKEN_A, "POST", {}, { "X-Admin-Password": password }), environment);
  assert.equal(granted.status, 200);
  assert.deepEqual(await granted.json(), { granted: 2, total: 3 });
  const balances = db.sqlite.prepare("SELECT id, reset_balance FROM users ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(balances, [{ id: "admin", reset_balance: 3 }, { id: "user-b", reset_balance: 3 }, { id: "user-c", reset_balance: 1 }]);
  assert.equal((await worker.fetch(makeRequest("/api/admin/users/user-c/grant", TOKEN_A, "POST", {}, { "X-Admin-Password": password }), environment)).status, 404);
  db.sqlite.close();
});

test("attachments persist for their owner and are removed with the chat", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  setupUser(db, "user-b", TOKEN_B);
  const objects = new Map();
  const files = {
    async put(key, data) { objects.set(key, data); },
    async get(key, type) { assert.equal(type, "arrayBuffer"); const data = objects.get(key); return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null; },
    async delete(key) { objects.delete(key); },
  };
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => { seen.push(JSON.parse(options.body)); return Response.json({ output: [{ content: [{ type: "output_text", text: "Файл прочитан" }] }] }); };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const environment = { ...env(db), FILE_KV: files };
  const upload = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gpt-6-luna", thinking: "medium", content: "Прочти", files: [{ name: "note.txt", type: "text/plain", size: 6, data: "0L/RgNC40LLQtdGC" }] }), environment);
  assert.equal(upload.status, 200);
  const result = await upload.json();
  assert.equal(result.files.length, 1);
  const path = `/api/files/${result.files[0].id}`;
  assert.equal((await worker.fetch(makeRequest(path, TOKEN_B), environment)).status, 404);
  const download = await worker.fetch(makeRequest(path, TOKEN_A), environment);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "привет");
  assert.equal(objects.size, 1);
  const followup = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { chatId: result.chatId, model: "gpt-6-luna", thinking: "medium", content: "Что было в файле?", files: [] }), environment);
  assert.equal(followup.status, 200);
  assert.equal(seen[1].input.at(-1).content[1].filename, "note.txt");
  const removed = await worker.fetch(makeRequest(`/api/chats/${result.chatId}`, TOKEN_A, "DELETE"), environment);
  assert.equal(removed.status, 200);
  assert.equal(objects.size, 0);
});

test("removed models cannot spend a request or become the default", async () => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  for (const model of ["claude-opus-5", "qwen3.8-27b"]) {
    const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model, thinking: "low", content: "Привет", files: [] }), env(db));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Неизвестная модель.");
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM usage").get().total, 0);
  db.sqlite.prepare("UPDATE users SET default_model = 'claude-opus-5' WHERE id = 'user-a'").run();
  const oldProfile = await worker.fetch(makeRequest("/api/profile", TOKEN_A), env(db));
  assert.equal((await oldProfile.json()).defaultModel, "gemini-3.8-flash");
  assert.equal(db.sqlite.prepare("SELECT default_model FROM users WHERE id = 'user-a'").get().default_model, "gemini-3.8-flash");
  const profile = await worker.fetch(makeRequest("/api/profile", TOKEN_A, "PUT", { displayName: "", aboutText: "", defaultModel: "claude-opus-5", memoryEnabled: true }), env(db));
  assert.equal((await profile.json()).defaultModel, "gemini-3.8-flash");
  db.sqlite.close();
});

test("restored Luna can continue old chats", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  db.sqlite.prepare("INSERT INTO chats (id, user_id, title, model, messages_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("old-luna", "user-a", "Старый чат", "gpt-6-luna", JSON.stringify([{ role: "user", content: "Привет" }]), Date.now());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ output: [{ content: [{ type: "output_text", text: "Продолжение" }] }] });
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const profile = await (await worker.fetch(makeRequest("/api/profile", TOKEN_A), env(db))).json();
  assert.equal(profile.defaultModel, "gpt-6-luna");
  const chats = await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), env(db))).json();
  assert.equal(chats.chats[0].model, "gpt-6-luna");
  const continued = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { chatId: "old-luna", model: "gpt-6-luna", thinking: "medium", content: "Продолжи", files: [] }), env(db));
  assert.equal(continued.status, 200);
  assert.equal((await continued.json()).answer, "Продолжение");
});

test("web search is opt-in for every GPT model and preserves clickable citation data", async (context) => {
  const db = database();
  setupUser(db, "user-a", TOKEN_A);
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return Response.json({ output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", content: [{ type: "output_text", text: "Ответ [1]", annotations: [{ type: "url_citation", start_index: 6, end_index: 9, url: "https://example.org/source", title: "Источник" }] }] },
    ] });
  };
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  const searched = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gpt-6-luna", thinking: "medium", webSearch: true, content: "Найди новость", files: [] }), env(db));
  assert.equal(searched.status, 200);
  const result = await searched.json();
  assert.deepEqual(seen[0].tools, [{ type: "web_search" }]);
  assert.equal(seen[0].tool_choice, "required");
  assert.deepEqual(result.citations, [{ startIndex: 6, endIndex: 9, url: "https://example.org/source", title: "Источник" }]);
  const chats = await (await worker.fetch(makeRequest("/api/chats", TOKEN_A), env(db))).json();
  assert.deepEqual(chats.chats[0].messages[1].citations, result.citations);
  const blocked = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { model: "gemini-3.8-flash", thinking: "medium", webSearch: true, content: "Найди новость", files: [] }), env(db));
  assert.equal(blocked.status, 400);
  assert.equal(db.sqlite.prepare("SELECT count FROM usage WHERE user_id = 'user-a'").get().count, 1);
  const plain = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model: "gpt-6-luna", thinking: "medium", webSearch: false, content: "Привет", files: [] }), env(db));
  assert.equal(plain.status, 200);
  assert.equal(seen[1].tools, undefined);
  for (const model of ["gpt-6-sol", "gpt-6-astra"]) {
    const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model, thinking: "low", webSearch: true, content: "Найди источник", files: [] }), env(db));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.citations[0].url, "https://example.org/source");
    assert.equal(result.remaining, 28);
    assert.equal(seen.at(-1).model, model);
    assert.deepEqual(seen.at(-1).tools, [{ type: "web_search" }]);
    assert.equal(seen.at(-1).tool_choice, "required");
  }
});

test("unconfirmed search responses and provider failures return the correct quota", async (context) => {
  const db = database();
  setupUser(db, "search-user", TOKEN_A);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; db.sqlite.close(); });
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
    for (const failure of ["no-search", "no-sources", "provider-error"]) {
      globalThis.fetch = async () => failure === "provider-error" ? Response.json({ error: { message: "Search unavailable" } }, { status: 503 }) : Response.json({ output: [
        ...(failure === "no-sources" ? [{ type: "web_search_call", status: "completed" }] : []),
        { type: "message", content: [{ type: "output_text", text: "Неподтверждённый ответ" }] },
      ] });
      const response = await worker.fetch(makeRequest("/api/chat", TOKEN_A, "POST", { temporary: true, model, thinking: "low", webSearch: true, content: "Найди", files: [] }), env(db));
      assert.equal(response.status, 502);
      const me = await (await worker.fetch(makeRequest("/api/me", TOKEN_A), env(db))).json();
      assert.equal(me.remaining, 30);
      assert.equal(me.smartRemaining, 5);
    }
  }
});
