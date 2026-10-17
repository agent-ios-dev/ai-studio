const encoder = new TextEncoder();
function tokenUsage(data, provider) {
  const u = provider === "gemini" ? data?.usageMetadata : data?.usage;
  if (!u) return null;
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  const total = provider === "gemini" ? u.totalTokenCount : u.total_tokens;
  const input = provider === "gemini" ? u.promptTokenCount : (u.input_tokens ?? u.prompt_tokens);
  const output = provider === "gemini" ? u.candidatesTokenCount : (u.output_tokens ?? u.completion_tokens);
  const reasoning = provider === "gemini" ? (u.thoughtsTokenCount || 0) : 0;
  // OpenAI/OpenRouter already include reasoning in output/completion tokens.
  if (valid(total) && total > 0) return total;
  if (valid(input) && valid(output) && valid(reasoning) && input + output + reasoning > 0) return input + output + reasoning;
  return null;
}
function inputTokenBound(history, message, files, instructions) {
  if (files.some(file => !file.type?.startsWith("text/") && !/\.(txt|md|json|csv|html|xml|js|ts|py|css)$/i.test(file.name))) return null;
  let bytes = encoder.encode(instructions + message + JSON.stringify(history.slice(-24))).length + 512;
  for (const file of files) bytes += encoder.encode(file.name).length + Math.ceil(file.data.length * 3 / 4) + 128;
  return bytes;
}
async function tokenBalance(db, userId, day, limit) {
  const row = await db.prepare("SELECT used, reserved, estimated FROM token_usage WHERE user_id = ? AND day = ?").bind(userId, day).first();
  const used = Number(row?.used || 0), reserved = Number(row?.reserved || 0);
  return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved), estimated: !!row?.estimated };
}
async function reserveTokens(db, userId, day, limit) {
  const id = crypto.randomUUID(), now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO token_usage (user_id, day) VALUES (?, ?)").bind(userId, day).run();
  // If a process died, settle its reservation conservatively, never grant a refund
  // that could be used to bypass the daily ceiling by disconnecting requests.
  await db.prepare("UPDATE token_usage SET used = used + reserved, reserved = 0, reservation_id = NULL, estimated = 1 WHERE user_id = ? AND day = ? AND reserved > 0 AND reserved_until < ?").bind(userId, day, now).run();
  const row = await db.prepare("UPDATE token_usage SET reserved = ? - used, reservation_id = ?, reserved_until = ? WHERE user_id = ? AND day = ? AND used < ? AND reserved = 0 RETURNING reserved").bind(limit, id, now + 10 * 60_000, userId, day, limit).first();
  if (!row) return null;
  return { id, userId, day, amount: row.reserved };
}
async function settleTokens(db, reservation, count, estimated = false) {
  await db.prepare("UPDATE token_usage SET used = used + ?, reserved = 0, reservation_id = NULL, reserved_until = 0, estimated = MAX(estimated, ?) WHERE user_id = ? AND day = ? AND reservation_id = ?").bind(Math.max(0, Math.ceil(count)), estimated ? 1 : 0, reservation.userId, reservation.day, reservation.id).run();
}
export { tokenUsage, inputTokenBound, tokenBalance, reserveTokens, settleTokens };
