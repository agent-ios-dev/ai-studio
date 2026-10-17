import { reserveTokens, settleTokens, inputTokenBound } from './token-quota.js';
const MODEL = 'gemini-3.8-live';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
const reservationFor = row => ({ id: row.reservation_id, userId: row.user_id, day: row.day, amount: row.reserved });
async function readMessage(data) {
  return JSON.parse(typeof data === 'string' ? data : typeof data?.text === 'function' ? await data.text() : new TextDecoder().decode(data));
}
export class LiveMeter {
  constructor(contextCost = 0) { this.used = 0; this.turnUsage = 0; this.input = 0; this.output = 0; this.text = 0; this.contextCost = contextCost; this.reported = false; }
  acceptAudio(bytes) { this.input += bytes; }
  acceptText(text) { this.text += new TextEncoder().encode(text).length; }
  acceptServer(data) {
    const total = data.usageMetadata?.totalTokenCount;
    if (Number.isSafeInteger(total) && total > 0) { this.turnUsage = Math.max(this.turnUsage, total); this.reported = true; }
    for (const part of data.serverContent?.modelTurn?.parts || []) if (part.inlineData?.data) this.output += Math.floor(part.inlineData.data.length * 3 / 4);
    if (data.serverContent?.turnComplete && this.turnUsage) { this.used += this.turnUsage; this.turnUsage = 0; this.input = this.output = this.text = 0; }
  }
  balance() {
    const pending = this.input + this.output + this.text > 0;
    // Conservative bound for unfinished audio when a caller disconnects before usage arrives.
    const estimate = pending && !this.turnUsage ? Math.ceil(this.input / 160 + this.output / 240 + this.text + this.contextCost) : 0;
    return { used: this.used + (this.turnUsage || estimate), estimated: estimate > 0 };
  }
}
export async function recoverLiveSessions(env, userId) {
  // Unused tickets are free; only a genuinely lost active session is settled conservatively.
  const expired = await env.DB.prepare("SELECT * FROM live_sessions WHERE user_id=? AND ((status='issued' AND ticket_expires_at<?) OR (status='active' AND expires_at<?))").bind(userId, Date.now(), Date.now() - 60_000).all();
  for (const row of expired.results) {
    const claim = await env.DB.prepare("UPDATE live_sessions SET status='closed', context_json='[]', instructions='' WHERE id=? AND status=? RETURNING id").bind(row.id, row.status).first();
    if (claim) await settleTokens(env.DB, reservationFor(row), row.status === 'issued' ? 0 : row.reserved, row.status !== 'issued');
  }
}
export async function createLiveSession(request, env, user, settings, day, resetAt, instructions) {
  const raw = await request.text();
  if (raw.length > 1000) return json({ error: 'Слишком большой запрос.' }, 413);
  let body; try { body = JSON.parse(raw || '{}'); } catch { return json({ error: 'Неверный формат запроса.' }, 400); }
  await recoverLiveSessions(env, user.id);
  let context = [], chatId = crypto.randomUUID();
  if (typeof body.chatId === 'string' && /^[\w-]{1,64}$/.test(body.chatId)) {
    const chat = await env.DB.prepare('SELECT id, model, messages_json FROM chats WHERE id=? AND user_id=?').bind(body.chatId, user.id).first();
    if (chat?.model === MODEL) { chatId = chat.id; try { context = JSON.parse(chat.messages_json); } catch { /* Empty history. */ } }
  }
  context = context.filter(x => ['user', 'assistant'].includes(x.role) && typeof x.content === 'string').slice(-200).map(x => ({ role: x.role, content: x.content.slice(0, 6000) }));
  if (user.memory_enabled) {
    const memory = await env.DB.prepare('SELECT summary FROM memory_summaries WHERE user_id=?').bind(user.id).first();
    if (memory?.summary) instructions += '\nЛичная сводка памяти пользователя:\n' + memory.summary;
  }
  instructions += '\nЭто живой голосовой разговор. Отвечай естественно и кратко на языке пользователя. Не произноси разметку Markdown. Не добавляй служебные блоки памяти.';
  const reservation = await reserveTokens(env.DB, user.id, day, settings.daily_limit);
  if (!reservation) return json({ error: 'Лимит исчерпан или уже выполняется запрос. Дождитесь его завершения.' }, 429);
  if (reservation.amount < inputTokenBound(context, '', [], instructions) + 2048) {
    await settleTokens(env.DB, reservation, 0);
    return json({ error: 'Недостаточно токенов для голосового разговора. Используйте сброс или дождитесь полуночи по Москве.' }, 429);
  }
  const id = crypto.randomUUID(), ticket = crypto.randomUUID() + crypto.randomUUID(), now = Date.now();
  const expiresAt = Math.min(now + 5 * 60_000, resetAt);
  try {
    await env.DB.prepare("INSERT INTO live_sessions(id,user_id,ticket_hash,day,reservation_id,reserved,expires_at,ticket_expires_at,chat_id,context_json,instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, user.id, await hash(ticket), day, reservation.id, reservation.amount, expiresAt, now + 60_000, chatId, JSON.stringify(context), instructions, now).run();
  } catch (error) { await settleTokens(env.DB, reservation, 0); throw error; }
  return json({ sessionId: id, ticket, expiresAt, budget: reservation.amount, limit: settings.daily_limit, model: MODEL });
}
export async function cancelLiveSession(request, env, user) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Неверный запрос.' }, 400); }
  const row = await env.DB.prepare("UPDATE live_sessions SET status='closed', context_json='[]', instructions='' WHERE id=? AND user_id=? AND status='issued' RETURNING *").bind(String(body.sessionId || ''), user.id).first();
  if (row) await settleTokens(env.DB, reservationFor(row), 0);
  return json({ ok: true });
}
async function connectGoogle(env, row) {
  const keys = [...new Set([env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP_1, env.GEMINI_API_KEY_BACKUP_2, env.GEMINI_API_KEY_BACKUP_3].map(x => String(x || '').trim()).filter(Boolean))];
  for (const key of keys) {
    let socket;
    try {
      const controller = new AbortController();
      const dialTimer = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch('https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(key), { headers: { Upgrade: 'websocket' }, signal: controller.signal });
      } finally { clearTimeout(dialTimer); }
      socket = response.webSocket;
      if (!socket) continue;
      socket.accept();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(new Error('Setup timeout')), 8000);
        const done = error => { clearTimeout(timer); socket.removeEventListener('message', message); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed); error ? reject(error) : resolve(); };
        const closed = () => done(new Error('Setup failed'));
        const message = async event => { try { const data = await readMessage(event.data); if (data.setupComplete) done(); else if (data.error) done(new Error('Provider rejected setup')); } catch { done(new Error('Invalid setup')); } };
        socket.addEventListener('message', message); socket.addEventListener('close', closed); socket.addEventListener('error', closed);
        socket.send(JSON.stringify({ setup: { model: 'models/' + MODEL, generationConfig: { responseModalities: ['AUDIO'], maxOutputTokens: Math.min(1024, row.reserved) }, systemInstruction: { parts: [{ text: row.instructions + (row.context_json !== '[]' ? '\nПредыдущая переписка (контекст разговора):\n' + JSON.stringify(JSON.parse(row.context_json).slice(-24)) : '') }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } }));
      });
      return socket;
    } catch { try { socket?.close(1000, 'Retry'); } catch { /* Retry another key. */ } }
  }
  throw new Error('Не удалось подключить Gemini Live. Попробуйте ещё раз позже.');
}
export async function openLiveSocket(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'Метод не поддерживается.' }, 405);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Нужно WebSocket-подключение.' }, 426);
  const ticket = new URL(request.url).searchParams.get('ticket') || '';
  if (!/^[a-f0-9-]{72}$/i.test(ticket)) return json({ error: 'Недействительный билет подключения.' }, 401);
  const row = await env.DB.prepare("UPDATE live_sessions SET status='active' WHERE ticket_hash=? AND status='issued' AND ticket_expires_at>? AND expires_at>? RETURNING *").bind(await hash(ticket), Date.now(), Date.now()).first();
  if (!row) return json({ error: 'Подключение устарело. Начните разговор ещё раз.' }, 401);
  let upstream;
  try { upstream = await connectGoogle(env, row); }
  catch (error) {
    await settleTokens(env.DB, reservationFor(row), 0);
    await env.DB.prepare("UPDATE live_sessions SET status='closed', context_json='[]', instructions='' WHERE id=?").bind(row.id).run();
    return json({ error: error.message }, 502);
  }
  const pair = new WebSocketPair(), [client, server] = Object.values(pair);
  server.accept();
  const meter = new LiveMeter(inputTokenBound(JSON.parse(row.context_json), '', [], row.instructions));
  const messages = JSON.parse(row.context_json);
  let inputText = '', outputText = '', ended = false, lastActivity = Date.now(), totalInputBytes = 0, textRequests = 0;
  const safeSend = data => { try { server.send(JSON.stringify(data)); } catch { /* Client closed. */ } };
  const flushTranscript = () => {
    if (inputText.trim()) messages.push({ role: 'user', content: inputText.trim() });
    if (outputText.trim()) messages.push({ role: 'assistant', content: outputText.trim() });
    inputText = outputText = '';
  };
  let finishing;
  const finish = (reason = 'Разговор завершён') => {
    if (finishing) return finishing;
    ended = true; clearInterval(watchdog);
    finishing = (async () => {
      flushTranscript();
      const bill = meter.balance();
      try { upstream.close(1000, 'Session ended'); } catch { /* Already closed. */ }
      try {
        await settleTokens(env.DB, reservationFor(row), bill.used, bill.estimated);
        await env.DB.prepare("UPDATE live_sessions SET status='closed', context_json='[]', instructions='' WHERE id=?").bind(row.id).run();
        if (messages.length) {
          const title = messages.find(x => x.role === 'user')?.content.slice(0, 46) || 'Голосовой разговор';
          await env.DB.prepare('INSERT INTO chats(id,user_id,title,model,messages_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET messages_json=excluded.messages_json,updated_at=excluded.updated_at').bind(row.chat_id, row.user_id, title, MODEL, JSON.stringify(messages.slice(-200)), Date.now()).run();
        }
        safeSend({ type: 'ended', reason, used: bill.used, estimated: bill.estimated, chatId: messages.length ? row.chat_id : null });
      } finally { try { server.close(1000, 'Session ended'); } catch { /* Already closed. */ } }
    })().catch(() => { try { server.close(1011, 'Session save failed'); } catch { /* Gone. */ } });
    ctx?.waitUntil(finishing);
    return finishing;
  };
  const watchdog = setInterval(() => {
    if (Date.now() >= row.expires_at) void finish('Время сеанса закончилось. Можно начать новый разговор.');
    else if (Date.now() - lastActivity > 30_000) void finish('Связь прервалась. Начните разговор ещё раз.');
    else if (meter.balance().used >= row.reserved) void finish('Токенный лимит исчерпан.');
  }, 2000);
  upstream.addEventListener('message', async event => {
    if (ended) return;
    try {
      const data = await readMessage(event.data);
      if (ended) return;
      if (data.error) { void finish('Gemini Live завершила сеанс с ошибкой.'); return; }
      meter.acceptServer(data);
      const content = data.serverContent;
      if (content) {
        if (content.inputTranscription?.text) inputText = (inputText + content.inputTranscription.text).slice(-12000);
        if (content.outputTranscription?.text) outputText = (outputText + content.outputTranscription.text).slice(-12000);
        safeSend({ type: 'content', content: { modelTurn: content.modelTurn, inputTranscription: content.inputTranscription, outputTranscription: content.outputTranscription, interrupted: content.interrupted, turnComplete: content.turnComplete } });
        if (content.turnComplete) flushTranscript();
      }
      const balance = meter.balance();
      if (data.usageMetadata) safeSend({ type: 'usage', used: balance.used, remaining: Math.max(0, row.reserved - balance.used) });
      if (balance.used >= row.reserved) void finish('Токенный лимит исчерпан.');
    } catch { void finish('Не удалось обработать ответ Gemini Live.'); }
  });
  upstream.addEventListener('close', event => {
    if (ended) return;
    let detail = String(event.reason || '').slice(0, 400);
    for (const key of [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP_1, env.GEMINI_API_KEY_BACKUP_2, env.GEMINI_API_KEY_BACKUP_3]) if (key) detail = detail.replaceAll(String(key), '[ключ скрыт]');
    detail = detail.replace(/key=[^\s&]+/gi, 'key=[скрыт]');
    void finish(event.code === 1000 ? 'Соединение с Gemini Live завершено.' : `Gemini Live (${event.code}): ${detail || 'Соединение прервано. Попробуйте ещё раз.'}`);
  });
  upstream.addEventListener('error', () => { if (!ended) void finish('Ошибка связи с Gemini Live.'); });
  server.addEventListener('message', event => {
    if (ended) return;
    lastActivity = Date.now();
    try {
      if (typeof event.data !== 'string' || event.data.length > 26000) { void finish('Недопустимый размер аудио.'); return; }
      const data = JSON.parse(event.data);
      if (data.type === 'ping') { safeSend({ type: 'pong' }); return; }
      if (data.type === 'stop') { void finish(); return; }
      if (data.type === 'mute') { upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); return; }
      if (data.type === 'text') {
        if (typeof data.text !== 'string' || data.text.length > 2000 || ++textRequests > 30) { void finish('Слишком много запросов.'); return; }
        meter.acceptText(data.text);
        inputText = (inputText + data.text).slice(-12000);
        if (meter.balance().used >= row.reserved) { void finish('Токенный лимит исчерпан.'); return; }
        upstream.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: data.text }] }], turnComplete: true } }));
      } else if (data.type === 'audio') {
        if (typeof data.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data) || data.data.length > 22000 || data.data.length % 4 !== 0) { void finish('Повреждённый звук.'); return; }
        const bytes = Math.floor(data.data.length * 3 / 4); totalInputBytes += bytes;
        // Reject accelerated uploads: at most real-time 16kHz mono PCM plus a small burst.
        if (totalInputBytes > ((Date.now() - row.created_at) / 1000 + 3) * 36000) { void finish('Слишком быстрый поток звука.'); return; }
        meter.acceptAudio(bytes);
        if (meter.balance().used >= row.reserved) { void finish('Токенный лимит исчерпан.'); return; }
        upstream.send(JSON.stringify({ realtimeInput: { audio: { data: data.data, mimeType: 'audio/pcm;rate=16000' } } }));
      } else { void finish('Неизвестная команда голосового режима.'); }
    } catch { void finish('Не удалось передать звук.'); }
  });
  server.addEventListener('close', () => { if (!ended) void finish(); });
  server.addEventListener('error', () => { if (!ended) void finish('Связь прервалась.'); });
  safeSend({ type: 'ready', model: MODEL, expiresAt: row.expires_at, budget: row.reserved });
  return new Response(null, { status: 101, webSocket: client });
}
