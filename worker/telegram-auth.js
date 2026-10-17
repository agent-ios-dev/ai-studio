import { randomToken, sha256, signature, reserveRate, bodyFor } from "./email-auth.js";

const ISSUER = "https://oauth.telegram.org";
const TTL = 10 * 60_000;
const SESSION_TTL = 30 * 86_400_000;
let keyCache = { keys: [], expiresAt: 0 };
const response = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const error = (message, status = 400) => response({ error: message }, status);
const ready = (env) => env.TELEGRAM_AUTH_ENABLED === "true" && /^[1-9]\d{0,15}$/.test(env.TELEGRAM_CLIENT_ID || "") && Number.isSafeInteger(Number(env.TELEGRAM_CLIENT_ID));
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));
}
async function telegramClaims(token, clientId, nonce) {
  if (typeof token !== "string" || token.length > 16_384) throw new Error("Invalid token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");
  const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit || claims.iss !== ISSUER || String(claims.aud) !== clientId || Array.isArray(claims.aud)
      || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 30 || claims.iat < now - TTL / 1000
      || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 30))
      || claims.nonce !== nonce || typeof claims.sub !== "string" || !/^\d{1,32}$/.test(claims.sub)) throw new Error("Invalid claims");
  if (keyCache.expiresAt <= Date.now()) {
    const fetched = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
    if (!fetched.ok) throw new Error("Telegram unavailable");
    const jwks = await fetched.json();
    if (!Array.isArray(jwks.keys)) throw new Error("Invalid keys");
    keyCache = { keys: jwks.keys, expiresAt: Date.now() + 5 * 60_000 };
  }
  const jwk = keyCache.keys.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
  if (!jwk) throw new Error("Unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error("Invalid signature");
  return claims;
}
async function telegramSessionUser(db, tokenHash) {
  return db.prepare(`SELECT u.id, u.role, u.display_name, u.about_text, u.default_model, u.memory_enabled,
    u.reset_balance, u.reset_last_grant_at, NULL AS email, 'telegram' AS auth_type,
    a.username AS telegram_username, a.name AS telegram_name
    FROM telegram_sessions s JOIN users u ON u.id = s.user_id JOIN telegram_accounts a ON a.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first();
}
async function handleTelegramAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/auth/status") return response({
    enabled: env.EMAIL_AUTH_ENABLED === "true" && !!env.RESEND_API_KEY && !!env.RESEND_FROM && !!env.EMAIL_AUTH_SECRET,
    telegram: { enabled: ready(env), clientId: ready(env) ? env.TELEGRAM_CLIENT_ID : null },
  });
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.headers.get("Authorization") || "")?.[1];
    if (token) await env.DB.prepare("DELETE FROM telegram_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return null; // The existing handler also revokes email sessions.
  }
  if (!["/api/auth/telegram/challenge", "/api/auth/telegram/verify"].includes(path)) return null;
  if (request.method !== "POST") return error("Метод не поддерживается.", 405);
  if (!ready(env)) return error("Вход через Telegram пока настраивается. Используйте личную ссылку.", 503);
  const now = Date.now();
  const ip = await signature(env.EMAIL_AUTH_SECRET || env.TELEGRAM_CLIENT_ID, request.headers.get("CF-Connecting-IP") || "unknown");
  const bucket = path.endsWith("/challenge") ? "tg-start" : "tg-verify";
  if (!await reserveRate(env.DB, `${bucket}:${ip}`, bucket === "tg-start" ? 20 : 40, now + 15 * 60_000, now)) return error("Слишком много попыток входа. Попробуйте позже.", 429);
  if (path.endsWith("/challenge")) {
    const challengeId = crypto.randomUUID(), nonce = randomToken(), verifier = randomToken();
    await env.DB.prepare("DELETE FROM telegram_challenges WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO telegram_challenges (id, nonce, verifier_hash, expires_at) VALUES (?, ?, ?, ?)").bind(challengeId, nonce, await sha256(verifier), now + TTL).run();
    return response({ challengeId, nonce, verifier, expiresAt: now + TTL });
  }
  const body = await bodyFor(request, 18_432);
  if (!body || typeof body.challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.challengeId) || typeof body.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.verifier)) return error("Неверные данные входа.");
  const verifierHash = await sha256(body.verifier);
  const challenge = await env.DB.prepare("SELECT nonce FROM telegram_challenges WHERE id = ? AND verifier_hash = ? AND expires_at > ?").bind(body.challengeId, verifierHash, now).first();
  if (!challenge) return error("Попытка входа истекла или уже использована. Нажмите «Войти через Telegram» ещё раз.");
  let claims;
  try { claims = await telegramClaims(body.idToken, env.TELEGRAM_CLIENT_ID, challenge.nonce); }
  catch { return error("Не удалось подтвердить вход через Telegram. Попробуйте ещё раз.", 401); }
  const consumed = await env.DB.prepare("DELETE FROM telegram_challenges WHERE id = ? AND verifier_hash = ? AND expires_at > ? RETURNING id").bind(body.challengeId, verifierHash, Date.now()).first();
  if (!consumed) return error("Попытка входа уже использована.");
  const userId = crypto.randomUUID(), token = randomToken();
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
  const username = typeof claims.preferred_username === "string" ? claims.preferred_username.slice(0, 64) : "";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, token_hash, role, display_name, default_model, reset_last_grant_at, created_at) SELECT ?, ?, 'user', ?, 'gemini-3.8-flash', ?, ? WHERE NOT EXISTS (SELECT 1 FROM telegram_accounts WHERE subject = ?)").bind(userId, await sha256(randomToken()), name, now, now, claims.sub),
    env.DB.prepare("INSERT OR IGNORE INTO telegram_accounts (subject, user_id, username, name, created_at) SELECT ?, id, ?, ?, ? FROM users WHERE id = ?").bind(claims.sub, username, name, now, userId),
    env.DB.prepare("UPDATE telegram_accounts SET username = ?, name = ? WHERE subject = ?").bind(username, name, claims.sub),
    env.DB.prepare("INSERT INTO telegram_sessions (token_hash, user_id, expires_at, created_at) SELECT ?, user_id, ?, ? FROM telegram_accounts WHERE subject = ?").bind(await sha256(token), now + SESSION_TTL, now, claims.sub),
    env.DB.prepare("DELETE FROM telegram_sessions WHERE expires_at <= ?").bind(now),
  ]);
  return response({ token, expiresAt: now + SESSION_TTL });
}

export { handleTelegramAuth, telegramSessionUser, telegramClaims };
