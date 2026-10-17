const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CODE_TTL = 10 * MINUTE;
const SESSION_TTL = 30 * DAY;

function response(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function error(message, status = 400) { return response({ error: message }, status); }
function ready(env) { return env.EMAIL_AUTH_ENABLED === "true" && !!env.RESEND_API_KEY && !!env.RESEND_FROM && !!env.EMAIL_AUTH_SECRET; }
function randomToken() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomCode() {
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= 4_294_000_000);
  return String(value[0] % 1_000_000).padStart(6, "0");
}
function hex(bytes) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(value) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function signature(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || email.split("@")[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) return null;
  return email;
}
async function bodyFor(request, maxBytes = 4096) {
  if (Number(request.headers.get("Content-Length") || 0) > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try { const body = JSON.parse(text); return body && typeof body === "object" && !Array.isArray(body) ? body : null; } catch { return null; }
}
async function reserveRate(db, bucket, limit, expiresAt, now) {
  return db.prepare(`INSERT INTO auth_rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR count < ? RETURNING count`).bind(bucket, expiresAt, now, now, now, limit).first();
}
function bearer(request) { return /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.headers.get("Authorization") || "")?.[1]; }

async function sessionUser(db, tokenHash) {
  return db.prepare(`SELECT u.id, u.role, u.display_name, u.about_text, u.default_model, u.memory_enabled,
    u.reset_balance, u.reset_last_grant_at, a.email, 'email' AS auth_type
    FROM email_sessions s JOIN users u ON u.id = s.user_id JOIN email_accounts a ON a.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first();
}

async function handleEmailAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/auth/")) return null;
  if (request.method === "GET" && path === "/api/auth/status") return response({ enabled: ready(env) });
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = bearer(request);
    if (token) await env.DB.prepare("DELETE FROM email_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return response({ ok: true });
  }
  if (request.method !== "POST" || !["/api/auth/request-code", "/api/auth/verify-code"].includes(path)) return error("Маршрут не найден.", 404);
  if (!ready(env)) return error("Вход по почте пока недоступен. Попробуйте позже.", 503);
  const body = await bodyFor(request);
  if (!body) return error("Неверный формат запроса.");
  const now = Date.now();
  const ip = await signature(env.EMAIL_AUTH_SECRET, `ip:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  if (path === "/api/auth/request-code") {
    const email = normalizeEmail(body.email);
    if (!email) return error("Введите корректный адрес почты.");
    const emailHash = await signature(env.EMAIL_AUTH_SECRET, `email:${email}`);
    const utcDayEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    const utcMonthEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
    const buckets = [
      [`send-ip:${ip}`, 15, now + HOUR],
      [`send-email-minute:${emailHash}`, 1, now + MINUTE],
      [`send-email-hour:${emailHash}`, 5, now + HOUR],
      ["send-global-day", 100, utcDayEnd],
      ["send-global-month", 3000, utcMonthEnd],
    ];
    for (const [bucket, limit, expiry] of buckets) {
      if (!await reserveRate(env.DB, bucket, limit, expiry, now)) return error(bucket.startsWith("send-global") ? "Лимит писем на сегодня исчерпан. Попробуйте позже." : "Слишком много запросов кода. Подождите и попробуйте снова.", 429);
    }
    const challengeId = crypto.randomUUID();
    const code = randomCode();
    const codeHash = await signature(env.EMAIL_AUTH_SECRET, `${challengeId}\0${email}\0${code}`);
    await env.DB.prepare("DELETE FROM email_challenges WHERE expires_at < ?").bind(now - DAY).run();
    await env.DB.prepare("DELETE FROM auth_rate_limits WHERE expires_at < ?").bind(now - DAY).run();
    await env.DB.prepare("INSERT INTO email_challenges (id, email, code_hash, expires_at, attempts, state, created_at) VALUES (?, ?, ?, ?, 0, 'pending', ?)").bind(challengeId, email, codeHash, now + CODE_TTL, now).run();
    try {
      const sent = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `login-${challengeId}` },
        body: JSON.stringify({
          from: env.RESEND_FROM, to: [email], subject: "Ваш код входа в Ai Studio",
          text: `Код входа в Ai Studio: ${code}\n\nКод действует 10 минут и подходит только для одного входа. Никому его не сообщайте. Если вы не запрашивали код, проигнорируйте письмо.`,
          html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:32px auto;color:#222"><h2>Вход в Ai Studio</h2><p>Ваш одноразовый код:</p><div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:20px;background:#f5f5f5;border-radius:12px">${code}</div><p>Код действует 10 минут. Никому его не сообщайте.</p><p style="color:#777;font-size:12px">Если вы не запрашивали вход, просто проигнорируйте это письмо.</p></div>`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await sent.json();
      if (!sent.ok || !result.id) throw new Error("send failed");
      await env.DB.prepare("UPDATE email_challenges SET state = 'expired' WHERE email = ? AND id != ? AND state = 'sent'").bind(email, challengeId).run();
      await env.DB.prepare("UPDATE email_challenges SET state = 'sent' WHERE id = ?").bind(challengeId).run();
      return response({ challengeId, email, expiresAt: now + CODE_TTL, resendAfter: now + MINUTE });
    } catch {
      await env.DB.prepare("UPDATE email_challenges SET state = 'failed' WHERE id = ?").bind(challengeId).run();
      return error("Не удалось отправить письмо. Подождите минуту и попробуйте снова.", 502);
    }
  }
  if (!await reserveRate(env.DB, `verify-ip:${ip}`, 40, now + HOUR, now)) return error("Слишком много попыток входа. Попробуйте позже.", 429);
  if (typeof body.challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.challengeId) || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) return error("Введите шестизначный код из письма.");
  const challenge = await env.DB.prepare("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ? AND state = 'sent' AND expires_at > ? AND attempts < 5 RETURNING email, code_hash").bind(body.challengeId, now).first();
  if (!challenge) return error("Код истёк, уже использован или исчерпаны попытки. Запросите новый.");
  const actual = await signature(env.EMAIL_AUTH_SECRET, `${body.challengeId}\0${challenge.email}\0${body.code}`);
  if (!equal(actual, challenge.code_hash)) return error("Неверный код. Проверьте письмо и попробуйте снова.");
  const consumed = await env.DB.prepare("UPDATE email_challenges SET state = 'consumed' WHERE id = ? AND state = 'sent' AND code_hash = ? AND expires_at > ? RETURNING email").bind(body.challengeId, actual, now).first();
  if (!consumed) return error("Код уже использован. Запросите новый.");
  const userId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const legacyHash = await sha256(randomToken());
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, token_hash, role, default_model, reset_last_grant_at, created_at) SELECT ?, ?, 'user', 'gemini-3.8-flash', ?, ? WHERE NOT EXISTS (SELECT 1 FROM email_accounts WHERE email = ?)").bind(userId, legacyHash, now, now, consumed.email),
    env.DB.prepare("INSERT OR IGNORE INTO email_accounts (email, user_id, created_at) SELECT ?, id, ? FROM users WHERE id = ?").bind(consumed.email, now, userId),
    env.DB.prepare("INSERT INTO email_sessions (token_hash, user_id, expires_at, created_at) SELECT ?, user_id, ?, ? FROM email_accounts WHERE email = ?").bind(tokenHash, now + SESSION_TTL, now, consumed.email),
    env.DB.prepare("DELETE FROM email_sessions WHERE expires_at <= ?").bind(now),
  ]);
  return response({ token, email: consumed.email, expiresAt: now + SESSION_TTL });
}

export { handleEmailAuth, sessionUser, normalizeEmail, randomToken, sha256, signature, reserveRate, bodyFor };
