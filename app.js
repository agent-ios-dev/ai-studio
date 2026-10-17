import "./liquid-glass.js";
import { renderMarkdown } from "./markdown.js";

const MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "OpenAI", description: "Быстрые ответы" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "OpenAI", description: "Задачи и работа с кодом" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "OpenAI", description: "Сложные задачи и рассуждения" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "Google", description: "Быстрые ответы" },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", provider: "NVIDIA", description: "Сложные задачи и рассуждения" },
];

const $ = (id) => document.getElementById(id);
const initialApi = String(window.CHAT_API_URL || "").replace(/\/$/, "");
const initialModel = MODELS.find((model) => model.id === localStorage.getItem("chat_default_model") && !model.disabled)?.id || "gemini-3.8-flash";
const state = {
  apiUrl: initialApi,
  token: localStorage.getItem("chat_access_token") || "",
  model: initialModel,
  defaultModel: initialModel,
  thinking: JSON.parse(localStorage.getItem("chat_thinking") || "{}"),
  webSearch: localStorage.getItem("chat_web_search") === "true",
  chats: [],
  currentId: null,
  tempChat: null,
  busy: false,
  files: [],
  remaining: 30,
  limit: 30,
  smartRemaining: 5,
  smartLimit: 5,
  resetBalance: 0,
  resetCap: 3,
  resetIntervalDays: 7,
  resetGrantAmount: 1,
  nextResetAt: null,
  nextDailyResetAt: null,
  role: "user",
  authType: "link",
  email: null,
  telegramName: null,
  profile: { displayName: "", aboutText: "", memoryEnabled: true },
  connected: false,
};

function id() { return crypto.randomUUID(); }
function currentChat() { return state.currentId === "temporary" ? state.tempChat : state.chats.find((chat) => chat.id === state.currentId) || null; }
function selectedModel() { return MODELS.find((model) => model.id === state.model) || { id: state.model, name: `${currentChat()?.modelName || "Модель"} · недоступна` }; }
function modelAvailable(id) { return MODELS.some((model) => model.id === id && !model.disabled); }
function selectedThinking() { return state.thinking[state.model] || "medium"; }
function isSmartModel(model) { return model === "gpt-6-astra" || model === "gpt-6-sol"; }
function supportsWebSearch(model) { return ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].includes(model); }
function apiUrl(path) { return `${state.apiUrl}${path}`; }
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3300);
}
function tokenFromUrl() {
  const match = location.hash.match(/(?:^#|&)invite=([^&]+)/);
  if (!match) return;
  state.token = decodeURIComponent(match[1]);
  localStorage.setItem("chat_access_token", state.token);
  history.replaceState(null, "", location.pathname + location.search);
}
function extractToken(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const match = url.hash.match(/(?:^#|&)invite=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : trimmed;
  } catch { return trimmed; }
}
async function api(path, options = {}) {
  if (!state.apiUrl || !state.token) throw new Error("Войдите в аккаунт, чтобы продолжить.");
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "Authorization": `Bearer ${state.token}`, ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("Сервер вернул неожиданный ответ."); }
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status}).`);
  return data;
}
function promptForName() {
  const dialog = $("nameDialog");
  if (!state.connected || state.profile.displayName?.trim()) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!dialog.open) {
    $("firstNameInput").value = "";
    dialog.showModal();
    $("firstNameInput").focus();
  }
}
async function connect(askForName = true) {
  if (!state.apiUrl || !state.token) { state.connected = false; state.chats = []; clearTimeout(dailyResetTimer); renderAll(); return; }
  try {
    const [profile, chats, personalization] = await Promise.all([api("/api/me"), api("/api/chats"), api("/api/profile")]);
    state.connected = true;
    state.remaining = profile.remaining;
    state.limit = profile.limit;
    state.smartRemaining = profile.smartRemaining;
    state.smartLimit = profile.smartLimit;
    state.resetBalance = profile.resetBalance;
    state.resetCap = profile.resetCap;
    state.resetIntervalDays = profile.resetIntervalDays;
    state.resetGrantAmount = profile.resetGrantAmount;
    state.nextResetAt = profile.nextResetAt;
    state.nextDailyResetAt = profile.nextDailyResetAt;
    state.role = profile.role || "user";
    state.authType = profile.authType || "link";
    state.email = profile.email || null;
    state.telegramName = profile.telegramUsername ? `@${profile.telegramUsername}` : profile.telegramName || null;
    state.profile = personalization;
    state.defaultModel = modelAvailable(personalization.defaultModel) ? personalization.defaultModel : "gemini-3.8-flash";
    localStorage.setItem("chat_default_model", state.defaultModel);
    state.chats = chats.chats;
    state.currentId = state.chats[0]?.id || null;
    state.model = state.chats[0]?.model || state.defaultModel;
    renderAll();
    scheduleDailyReset();
    if (askForName) promptForName();
  } catch (error) {
    state.connected = false;
    state.chats = [];
    clearTimeout(dailyResetTimer);
    renderAll();
    showToast(error.message);
  }
}
let dailyResetTimer;
async function refreshDailyLimit() {
  if (!state.connected) return;
  try {
    const profile = await api("/api/me");
    state.remaining = profile.remaining;
    state.limit = profile.limit;
    state.smartRemaining = profile.smartRemaining;
    state.smartLimit = profile.smartLimit;
    state.resetBalance = profile.resetBalance;
    state.nextResetAt = profile.nextResetAt;
    state.nextDailyResetAt = profile.nextDailyResetAt;
    renderQuota();
    scheduleDailyReset();
  } catch {
    dailyResetTimer = setTimeout(refreshDailyLimit, 30_000);
  }
}
function scheduleDailyReset() {
  clearTimeout(dailyResetTimer);
  if (!state.connected || !state.nextDailyResetAt) return;
  dailyResetTimer = setTimeout(refreshDailyLimit, Math.max(1000, Math.min(2_147_483_647, state.nextDailyResetAt - Date.now() + 1000)));
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.connected && state.nextDailyResetAt && Date.now() >= state.nextDailyResetAt) refreshDailyLimit();
});
function renderQuota() {
  const percent = Math.max(0, Math.min(100, Math.round((state.remaining / Math.max(1, state.limit)) * 100)));
  const smartPercent = Math.max(0, Math.min(100, Math.round((state.smartRemaining / Math.max(1, state.smartLimit)) * 100)));
  const smart = isSmartModel(state.model);
  $("quotaLabel").textContent = smart ? "Лимит Astra и Sol" : "Дневной лимит";
  $("quotaPercent").textContent = state.connected ? `${smart ? smartPercent : percent}%` : "—";
  $("quotaFill").style.width = state.connected ? `${smart ? smartPercent : percent}%` : "0%";
  $("quotaText").textContent = state.connected ? `${smart ? smartPercent : percent}% лимита осталось` : "Войдите в аккаунт";
  $("modePill").textContent = state.connected ? "Бета" : "Вход через Telegram";
  if (state.currentId === "temporary") $("modePill").textContent = "Временный чат";
  $("planLabel").textContent = state.connected ? (state.telegramName || state.email || "Бета · личный доступ") : "Требуется вход";
  $("connectionDescription").textContent = state.connected ? (state.authType === "telegram" ? `Вход через Telegram${state.telegramName ? ` · ${state.telegramName}` : ""}. История и лимиты сохраняются в аккаунте.` : state.email ? `Вы вошли как ${state.email}. История и лимиты сохраняются в аккаунте.` : "Сервер подключён. История и лимит привязаны к личной ссылке.") : "Войдите через Telegram или по личной ссылке.";
  $("loginButton").classList.toggle("hidden", state.connected);
  $("legacyAccessSection").classList.toggle("hidden", state.authType !== "link");
  $("connectionDot").classList.toggle("connected", state.connected);
  $("welcomeText").textContent = state.connected ? "Выберите модель и напишите сообщение. История синхронизируется с вашим профилем." : "Войдите через Telegram, чтобы начать чат, или используйте личную ссылку.";
  $("limitsNumber").textContent = state.connected ? `${percent}%` : "—";
  $("limitsFill").style.width = state.connected ? `${percent}%` : "0%";
  $("limitsCaption").textContent = state.connected ? `осталось ${state.remaining} из ${state.limit} запросов сегодня` : "лимита осталось сегодня";
  $("smartLimitsNumber").textContent = state.connected ? `${smartPercent}%` : "—";
  $("smartLimitsFill").style.width = state.connected ? `${smartPercent}%` : "0%";
  $("smartLimitsCaption").textContent = state.connected ? `осталось ${state.smartRemaining} из ${state.smartLimit} запросов сегодня` : "5 запросов в сутки на две модели вместе";
  $("resetBalance").textContent = state.connected ? `${state.resetBalance} из ${state.resetCap}` : "—";
  $("nextResetText").textContent = state.connected ? (state.nextResetAt ? `Начисление: +${state.resetGrantAmount} каждые ${state.resetIntervalDays} дн. Следующее — ${new Date(state.nextResetAt).toLocaleString("ru-RU")}.` : "Запас сбросов заполнен.") : "Войдите, чтобы увидеть сбросы.";
  $("useResetButton").disabled = !state.connected || state.resetBalance < 1 || state.remaining >= state.limit;
  $("adminLink").classList.toggle("hidden", state.role !== "admin");
  if (state.role === "admin" && state.token) $("adminLink").href = `./admin.html#invite=${encodeURIComponent(state.token)}`;
}
function renderModels() {
  $("selectedModelName").textContent = state.connected ? `${selectedModel().name}${selectedModel().disabled ? " · технические работы" : ""}` : "Войти для выбора модели";
  const menu = $("modelMenu");
  menu.replaceChildren();
  if (!state.connected) { menu.classList.add("hidden"); $("modelTrigger").setAttribute("aria-expanded", "false"); return; }
  for (const provider of ["OpenAI", "Google", "NVIDIA"]) {
    const title = document.createElement("div");
    title.className = "model-group-label";
    title.textContent = provider;
    menu.append(title);
    for (const model of MODELS.filter((entry) => entry.provider === provider)) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `model-option ${model.id === state.model ? "selected" : ""}`;
      option.disabled = !!model.disabled;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(model.id === state.model));
      option.innerHTML = `<span class="model-option-icon ${provider === "Google" ? "gemini" : ""}">${provider === "Google" ? "✦" : "◎"}</span><span class="model-option-copy"><strong></strong><small></small></span>${model.id === state.model ? '<svg class="check"><use href="#i-check"/></svg>' : ""}`;
      option.querySelector("strong").textContent = model.name;
      option.querySelector("small").textContent = model.description;
      option.addEventListener("click", () => {
        if (currentChat() && currentChat().model !== model.id) {
          state.currentId = null;
          showToast("Для другой модели открыт новый чат");
        }
        state.model = model.id;
        menu.classList.add("hidden");
        $("modelTrigger").setAttribute("aria-expanded", "false");
        renderAll();
      });
      menu.append(option);
    }
  }
}
function renderThinking() {
  const select = $("thinkingSelect");
  const choices = state.model === "gpt-6-luna" ? [["none", "Без размышления"], ["low", "Быстро"], ["medium", "Стандартно"], ["high", "Глубоко"], ["xhigh", "Очень глубоко"], ["max", "Максимально"]] : [["low", "Быстро"], ["medium", "Стандартно"], ["high", "Глубоко"]];
  select.replaceChildren();
  for (const [value, label] of choices) { const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); }
  select.value = selectedThinking();
  select.disabled = !modelAvailable(state.model);
}
function renderWebSearch() {
  const button = $("webSearchToggle");
  const available = state.connected && supportsWebSearch(state.model) && modelAvailable(state.model);
  button.disabled = !available;
  button.setAttribute("aria-pressed", String(available && state.webSearch));
  button.title = !state.connected ? "Войдите в аккаунт" : available ? (state.webSearch ? "Выключить поиск в интернете" : "Включить поиск в интернете") : "Поиск пока недоступен для этой модели";
}
function renderList() {
  const list = $("chatList");
  list.replaceChildren();
  const chats = [...state.chats].sort((a,b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.pinnedAt || 0) - (a.pinnedAt || 0) || b.updatedAt - a.updatedAt);
  let group = "";
  for (const chat of chats) {
    const nextGroup = chat.pinned ? "Закреплённые" : "Все чаты";
    if (nextGroup !== group) {
      group = nextGroup;
      const heading = document.createElement("div");
      heading.className = "chat-group-heading";
      heading.textContent = group;
      list.append(heading);
    }
    const item = document.createElement("div");
    item.className = `chat-item ${chat.id === state.currentId ? "active" : ""}`;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title || "Новый чат";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chat-delete";
    remove.title = "Удалить чат";
    remove.setAttribute("aria-label", `Удалить чат ${chat.title || "Новый чат"}`);
    remove.innerHTML = '<svg><use href="#i-trash"/></svg>';
    remove.addEventListener("click", (event) => { event.stopPropagation(); deleteChat(chat.id); });
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `chat-pin${chat.pinned ? " pinned" : ""}`;
    pin.title = chat.pinned ? "Открепить чат" : "Закрепить чат";
    pin.setAttribute("aria-label", `${pin.title} ${chat.title || "Новый чат"}`);
    pin.setAttribute("aria-pressed", String(!!chat.pinned));
    pin.innerHTML = '<svg><use href="#i-pin"/></svg>';
    pin.addEventListener("click", async event => {
      event.stopPropagation();
      pin.disabled = true;
      const token = state.token;
      try {
        const result = await api(`/api/chats/${encodeURIComponent(chat.id)}/pin`, { method: "PUT", body: JSON.stringify({ pinned: !chat.pinned }) });
        if (state.token !== token) return;
        Object.assign(chat, result);
        renderList();
      } catch (error) { showToast(error.message); pin.disabled = false; }
    });
    item.append(title, pin, remove);
    const open = () => { state.currentId = chat.id; state.model = chat.model; renderAll(); closeMobile(); };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => { if (event.target === item && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } });
    list.append(item);
  }
}
function citationUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}
function renderAssistantAnswer(bubble, message) {
  const characters = Array.from(String(message.content || ""));
  const citations = (Array.isArray(message.citations) ? message.citations : [])
    .map((item) => ({ ...item, safeUrl: citationUrl(item.url) }))
    .filter((item) => item.safeUrl);
  for (const item of [...citations].sort((a, b) => b.endIndex - a.endIndex)) {
    if (!Number.isInteger(item.startIndex) || !Number.isInteger(item.endIndex) || item.startIndex < 0 || item.endIndex > characters.length || item.endIndex <= item.startIndex) continue;
    const citedText = characters.slice(item.startIndex, item.endIndex).join("");
    if (/\]\(https?:\/\/[^)]+\)/i.test(citedText)) continue;
    const safeUrl = item.safeUrl.replace(/\(/g, "%28").replace(/\)/g, "%29");
    characters.splice(item.endIndex, 0, ...Array.from(` [источник](${safeUrl})`));
  }
  bubble.innerHTML = renderMarkdown(characters.join(""));
  for (const link of bubble.querySelectorAll("a")) {
    const safeUrl = citationUrl(link.getAttribute("href"));
    if (!safeUrl) { link.replaceWith(document.createTextNode(link.textContent)); continue; }
    link.href = safeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  if (citations.length) {
    const sources = document.createElement("div");
    sources.className = "answer-sources";
    sources.append(document.createTextNode("Источники: "));
    for (const [index, item] of [...new Map(citations.map((entry) => [entry.safeUrl, entry])).values()].entries()) {
      const link = document.createElement("a");
      link.href = item.safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.title || `Источник ${index + 1}`;
      sources.append(link);
    }
    bubble.append(sources);
  }
}
function messageElement(message, modelName) {
  const row = document.createElement("article");
  row.className = `message ${message.role}`;
  if (message.role === "assistant") {
    const header = document.createElement("div");
    header.className = "message-header";
    header.innerHTML = '<span class="assistant-mark"><svg><use href="#i-spark"/></svg></span><span></span>';
    header.lastElementChild.textContent = modelName || selectedModel().name;
    row.append(header);
  }
  if (message.files?.length) {
    for (const file of message.files) {
      const chip = document.createElement("div");
      chip.className = "file-chip";
      const extension = file.name.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE";
      chip.innerHTML = '<span class="file-chip-icon"></span><span></span>';
      chip.children[0].textContent = extension;
      chip.children[1].textContent = file.name;
      if (file.id && state.connected) {
        chip.classList.add("downloadable");
        chip.title = "Скачать файл";
        chip.tabIndex = 0;
        chip.setAttribute("role", "button");
        const download = () => downloadFile(file);
        chip.addEventListener("click", download);
        chip.addEventListener("keydown", (event) => { if (event.key === "Enter") download(); });
      }
      row.append(chip);
    }
  }
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (message.role === "assistant") renderAssistantAnswer(bubble, message);
  else bubble.textContent = message.content;
  row.append(bubble);
  if (message.role === "assistant" && message.content) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.title = "Копировать ответ";
    copy.setAttribute("aria-label", "Копировать ответ");
    copy.innerHTML = '<svg><use href="#i-copy"/></svg>';
    copy.addEventListener("click", async () => { await navigator.clipboard.writeText(message.content); showToast("Ответ скопирован"); });
    actions.append(copy);
    row.append(actions);
  }
  return row;
}
function renderMessages() {
  const chat = currentChat();
  const hasMessages = !!chat?.messages?.length;
  $("welcome").classList.toggle("hidden", hasMessages);
  $("messages").classList.toggle("hidden", !hasMessages);
  const container = $("messages");
  container.replaceChildren();
  if (!hasMessages) return;
  for (const message of chat.messages) container.append(messageElement(message, chat.modelName));
  if (state.busy) {
    const pending = document.createElement("article");
    pending.className = "message assistant";
    pending.innerHTML = '<div class="message-header"><span class="assistant-mark"><svg><use href="#i-spark"/></svg></span><span>Готовлю ответ</span></div><div class="thinking"><span></span><span></span><span></span></div>';
    container.append(pending);
  }
  requestAnimationFrame(() => { $("conversation").scrollTop = $("conversation").scrollHeight; });
}
function renderAttachments() {
  const holder = $("attachments");
  holder.replaceChildren();
  state.files.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attached-file";
    chip.innerHTML = '<span></span><button type="button" aria-label="Удалить вложение"><svg><use href="#i-close"/></svg></button>';
    chip.firstElementChild.textContent = file.name;
    chip.lastElementChild.addEventListener("click", () => { state.files.splice(index, 1); renderAttachments(); updateSend(); });
    holder.append(chip);
  });
}
function renderAll() { renderModels(); renderThinking(); renderWebSearch(); renderList(); renderMessages(); renderQuota(); renderAttachments(); updateSend(); renderVoice(); }
function updateSend() {
  const ready = !!$("promptInput").value.trim() || state.files.length > 0;
  const maintenance = selectedModel().disabled === true;
  $("sendButton").disabled = maintenance;
  $("promptInput").disabled = maintenance;
  $("attachButton").disabled = maintenance;
  $("sendButton").classList.toggle("ready", !maintenance && (ready || state.busy));
  $("sendButton").setAttribute("aria-label", state.busy ? "Ожидание ответа" : "Отправить сообщение");
  $("sendButton").innerHTML = state.busy ? '<svg><use href="#i-stop"/></svg>' : '<svg><use href="#i-arrow"/></svg>';
}
let voiceRecorder = null;
let voiceProcessing = false;
let voiceTimeout = null;
function renderVoice() {
  const button = $("voiceButton");
  const recording = voiceRecorder?.state === "recording";
  button.classList.toggle("recording", recording);
  button.disabled = selectedModel().disabled === true || voiceProcessing || (state.busy && !recording);
  button.setAttribute("aria-label", recording ? "Остановить запись" : voiceProcessing ? "Распознаём речь" : "Говорить");
  button.title = button.getAttribute("aria-label");
  button.innerHTML = recording ? '<svg><use href="#i-stop"/></svg>' : '<svg><use href="#i-mic"/></svg>';
  $("promptInput").placeholder = selectedModel().disabled ? "GPT-6 Luna: технические работы" : recording ? "Говорите… Нажмите на микрофон, чтобы отправить" : voiceProcessing ? "Распознаём речь…" : "Спросите что-нибудь";
}
async function toggleVoice() {
  if (voiceRecorder?.state === "recording") { voiceRecorder.stop(); return; }
  if (voiceProcessing || state.busy) return;
  if (!state.connected) { openAuth(); return; }
  if (selectedModel().disabled) { showToast("GPT-6 Luna: технические работы."); return; }
  if ((isSmartModel(state.model) ? state.smartRemaining : state.remaining) <= 0) { showToast(isSmartModel(state.model) ? "Лимит Astra и Sol исчерпан. Попробуйте завтра." : "Дневной лимит исчерпан. Попробуйте завтра."); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showToast("Этот браузер не поддерживает запись с микрофона."); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : { audioBitsPerSecond: 64_000 });
    const chunks = [];
    voiceRecorder = recorder;
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("error", () => { showToast("Не удалось записать звук."); if (recorder.state === "recording") recorder.stop(); });
    recorder.addEventListener("stop", async () => {
      clearTimeout(voiceTimeout);
      stream.getTracks().forEach((track) => track.stop());
      voiceRecorder = null;
      voiceProcessing = true;
      renderVoice();
      let transcribed = false;
      try {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const audio = new Blob(chunks, { type });
        if (audio.size < 100) throw new Error("Запись пуста. Попробуйте ещё раз.");
        if (audio.size > 3 * 1024 * 1024) throw new Error("Запись слишком длинная. Говорите не дольше минуты.");
        const form = new FormData();
        form.set("audio", audio, type.includes("mp4") ? "speech.mp4" : "speech.webm");
        form.set("model", state.model);
        const result = await api("/api/transcribe", { method: "POST", body: form });
        $("promptInput").value = [$("promptInput").value.trim(), result.text].filter(Boolean).join(" ");
        $("promptInput").dispatchEvent(new Event("input"));
        transcribed = true;
      } catch (error) { showToast(error.message); }
      finally { voiceProcessing = false; renderVoice(); }
      if (transcribed) await sendMessage();
    });
    recorder.start();
    voiceTimeout = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60_000);
    renderVoice();
    showToast("Говорите. Нажмите микрофон ещё раз, чтобы отправить.");
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    showToast(error.name === "NotAllowedError" ? "Разрешите доступ к микрофону в браузере." : "Не удалось включить микрофон.");
  }
}
function newChat() {
  state.currentId = null;
  state.model = state.defaultModel;
  $("promptInput").value = "";
  state.files = [];
  renderAll();
  closeMobile();
  $("promptInput").focus();
}
function temporaryChat() {
  if (!state.tempChat) state.tempChat = { id: "temporary", title: "Временный чат", model: state.defaultModel, modelName: MODELS.find((model) => model.id === state.defaultModel).name, messages: [], updatedAt: Date.now() };
  state.currentId = "temporary";
  state.model = state.tempChat.model;
  renderAll();
  closeMobile();
  $("promptInput").focus();
}
async function deleteChat(chatId) {
  if (state.connected) {
    try { await api(`/api/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" }); }
    catch (error) { showToast(error.message); return; }
  }
  state.chats = state.chats.filter((chat) => chat.id !== chatId);
  if (state.currentId === chatId) state.currentId = state.chats[0]?.id || null;
  renderAll();
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function sendMessage() {
  if (state.busy || voiceRecorder?.state === "recording" || voiceProcessing) return;
  if (!state.connected) { openAuth(); return; }
  if (selectedModel().disabled) { showToast("GPT-6 Luna: технические работы."); return; }
  if (currentChat() && !MODELS.some((model) => model.id === currentChat().model)) { showToast("Модель этого чата удалена. Начните новый чат."); return; }
  const content = $("promptInput").value.trim();
  const attached = [...state.files];
  if (!content && attached.length === 0) return;
  if (state.connected && (isSmartModel(state.model) ? state.smartRemaining : state.remaining) <= 0) { showToast(isSmartModel(state.model) ? "Лимит Astra и Sol исчерпан. Попробуйте завтра." : "Дневной лимит исчерпан. Попробуйте завтра."); return; }
  const chat = currentChat() || { id: id(), title: content.slice(0, 46) || attached[0].name, model: state.model, modelName: selectedModel().name, messages: [], updatedAt: Date.now() };
  if (!currentChat()) { state.chats.unshift(chat); state.currentId = chat.id; }
  const temporary = chat.id === "temporary";
  const userMessage = { role: "user", content, files: attached.map(({ name, size, type }) => ({ name, size, type })) };
  if (temporary && attached.length) userMessage._uploads = attached;
  chat.messages.push(userMessage);
  chat.updatedAt = Date.now();
  $("promptInput").value = "";
  state.files = [];
  state.busy = true;
  renderAll();
  try {
    let answer;
    let citations = [];
    {
      const previousUploads = temporary && !attached.length ? [...chat.messages].reverse().find((message) => message._uploads)?._uploads || [] : [];
      const modelAttachments = attached.length ? attached : previousUploads;
      const files = await Promise.all(modelAttachments.map(async (file) => ({ name: file.name, type: file.type || "application/octet-stream", size: file.size, data: await readFile(file) })));
      const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ chatId: temporary ? null : chat.id, temporary, history: temporary ? chat.messages.slice(0, -1).map(({ role, content }) => ({ role, content })) : undefined, model: chat.model, thinking: selectedThinking(), webSearch: supportsWebSearch(chat.model) && state.webSearch, content, files }) });
      answer = result.answer;
      citations = result.citations || [];
      state.remaining = result.remaining;
      state.smartRemaining = result.smartRemaining;
      chat.id = result.chatId;
      state.currentId = result.chatId;
      userMessage.files = result.files || userMessage.files;
      if (result.memoryUpdated) showToast("Память обновлена");
    }
    chat.messages.push({ role: "assistant", content: answer, citations });
    chat.updatedAt = Date.now();
  } catch (error) {
    chat.messages.pop();
    $("promptInput").value = content;
    state.files = attached;
    if (chat.messages.length === 0) { state.chats = state.chats.filter((entry) => entry !== chat); state.currentId = null; }
    showToast(error.message);
  } finally {
    state.busy = false;
    renderAll();
    if (state.nextDailyResetAt && Date.now() >= state.nextDailyResetAt) refreshDailyLimit();
    $("promptInput").focus();
  }
}
function closeMobile() { $("appShell").classList.remove("mobile-open"); }
async function downloadFile(file) {
  try {
    const response = await fetch(apiUrl(`/api/files/${encodeURIComponent(file.id)}`), { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Не удалось скачать файл."); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { showToast(error.message); }
}
function renderSearch() {
  const query = $("searchInput").value.trim().toLocaleLowerCase();
  const results = $("searchResults");
  results.replaceChildren();
  const chats = state.chats.filter((chat) => !query || chat.title.toLocaleLowerCase().includes(query) || chat.messages.some((message) => message.content.toLocaleLowerCase().includes(query)));
  if (!chats.length) { const empty = document.createElement("div"); empty.className = "search-empty"; empty.textContent = "Ничего не найдено"; results.append(empty); return; }
  chats.forEach((chat) => { const result = document.createElement("button"); result.className = "search-result"; result.textContent = chat.title; result.addEventListener("click", () => { state.currentId = chat.id; state.model = chat.model; $("searchDialog").close(); renderAll(); closeMobile(); }); results.append(result); });
}

const telegramLogin = { busy: false, enabled: false, clientId: null, challenge: null };
let telegramSdkPromise;
let telegramLoginTimer;
let telegramAttempt = 0;
function cancelTelegramLogin() {
  telegramAttempt++;
  clearTimeout(telegramLoginTimer);
  window.Telegram?.Login?.close();
  telegramLogin.busy = false;
  renderTelegramLogin();
}
async function authApi(path, body) {
  const response = await fetch(apiUrl(path), { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let result;
  try { result = await response.json(); } catch { throw new Error("Сервер вернул неожиданный ответ."); }
  if (!response.ok) throw new Error(result.error || "Не удалось войти. Попробуйте позже.");
  return result;
}
function authError(message = "") { $("authError").textContent = message; $("authError").classList.toggle("hidden", !message); }
function renderTelegramLogin() {
  $("telegramLoginButton").disabled = telegramLogin.busy || !telegramLogin.enabled;
  $("telegramLoginButton").textContent = telegramLogin.busy ? "Проверяем вход…" : "Войти через Telegram";
  $("legacyLoginButton").disabled = telegramLogin.busy;
  $("cancelTelegramLogin").classList.toggle("hidden", !telegramLogin.busy);
}
function loadTelegramSdk() {
  if (window.Telegram?.Login) return Promise.resolve();
  if (!telegramSdkPromise) telegramSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://oauth.telegram.org/js/telegram-login.js?6";
    script.async = true;
    const timer = setTimeout(() => { script.remove(); telegramSdkPromise = null; reject(new Error("Telegram не загрузился. Попробуйте ещё раз или войдите по ссылке.")); }, 15000);
    script.onload = () => { clearTimeout(timer); if (window.Telegram?.Login) resolve(); else { telegramSdkPromise = null; reject(new Error("Не удалось загрузить Telegram.")); } };
    script.onerror = () => { clearTimeout(timer); script.remove(); telegramSdkPromise = null; reject(new Error("Не удалось загрузить Telegram. Используйте личную ссылку или попробуйте позже.")); };
    document.head.append(script);
  });
  return telegramSdkPromise;
}
async function openAuth() {
  if (state.connected) return;
  if (telegramLogin.busy) return;
  authError();
  if (!$("authDialog").open) $("authDialog").showModal();
  closeMobile();
  telegramLogin.enabled = false;
  renderTelegramLogin();
  $("telegramLoginNote").textContent = "Подключаем Telegram…";
  try {
    const status = await authApi("/api/auth/status");
    if (!status.telegram?.enabled) {
      $("telegramLoginNote").textContent = "Вход через Telegram пока настраивается. Личная ссылка уже работает.";
      return;
    }
    telegramLogin.clientId = status.telegram.clientId;
    await loadTelegramSdk();
    telegramLogin.challenge = await authApi("/api/auth/telegram/challenge", {});
    telegramLogin.enabled = true;
    $("telegramLoginNote").textContent = "Подтвердите вход в окне Telegram. Доступ к номеру телефона и сообщениям не запрашивается.";
  } catch (error) { authError(error.message); $("telegramLoginNote").textContent = "Можно войти по личной ссылке ниже."; }
  finally { renderTelegramLogin(); }
}
$("telegramLoginButton").addEventListener("click", () => {
  if (!telegramLogin.enabled || telegramLogin.busy) return;
  const challenge = telegramLogin.challenge;
  if (!challenge || challenge.expiresAt <= Date.now()) { openAuth(); authError("Подготовлен новый вход. Нажмите кнопку Telegram ещё раз."); return; }
  telegramLogin.busy = true;
  const attempt = ++telegramAttempt;
  telegramLoginTimer = setTimeout(() => {
    cancelTelegramLogin();
    authError("Вход не завершён. Разрешите всплывающие окна и попробуйте ещё раз или используйте личную ссылку.");
  }, 120_000);
  renderTelegramLogin();
  authError();
  try {
    window.Telegram.Login.auth({ client_id: Number(telegramLogin.clientId), scope: ["profile"], lang: "ru", nonce: challenge.nonce }, async (data) => {
      if (attempt !== telegramAttempt) return;
      try {
        if (!data?.id_token) throw new Error(data?.error ? "Telegram не подтвердил вход. Попробуйте ещё раз." : "Вход отменён. Можно попробовать снова.");
        const result = await authApi("/api/auth/telegram/verify", { challengeId: challenge.challengeId, verifier: challenge.verifier, idToken: data.id_token });
        if (attempt !== telegramAttempt) return;
        clearTimeout(telegramLoginTimer);
        await finishLogin(result.token);
      } catch (error) {
        authError(error.message);
        telegramLogin.challenge = null;
        if (!state.connected) {
          try { telegramLogin.challenge = await authApi("/api/auth/telegram/challenge", {}); } catch { telegramLogin.enabled = false; }
        }
      } finally { clearTimeout(telegramLoginTimer); telegramLogin.busy = false; renderTelegramLogin(); }
    });
  } catch { cancelTelegramLogin(); authError("Не удалось открыть окно Telegram. Проверьте, разрешены ли всплывающие окна."); }
});
$("cancelTelegramLogin").addEventListener("click", cancelTelegramLogin);
$("authDialog").addEventListener("close", cancelTelegramLogin);
async function finishLogin(token) {
  state.token = token;
  localStorage.setItem("chat_access_token", token);
  state.chats = [];
  state.currentId = null;
  state.tempChat = null;
  state.files = [];
  state.profile = { displayName: "", aboutText: "", memoryEnabled: true };
  $("promptInput").value = "";
  $("authDialog").close();
  await connect();
  if (state.connected) { telegramLogin.challenge = null; showToast("Вы вошли в аккаунт"); }
}
$("loginButton").addEventListener("click", openAuth);
$("legacyLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (telegramLogin.busy) return;
  const token = extractToken($("legacyLoginInput").value);
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) { authError("Вставьте корректную личную ссылку."); return; }
  telegramLogin.busy = true;
  renderTelegramLogin();
  try { await finishLogin(token); $("legacyLoginInput").value = ""; }
  finally { telegramLogin.busy = false; renderTelegramLogin(); }
});
$("logoutButton").addEventListener("click", async () => {
  if (state.busy || voiceProcessing || voiceRecorder?.state === "recording") { showToast("Дождитесь завершения запроса."); return; }
  try {
    if (settingsSaveTimer) queueSettingsSave();
    await settingsSaveChain;
    if (state.authType !== "link") await api("/api/auth/logout", { method: "POST", body: "{}" });
    localStorage.removeItem("chat_access_token");
    state.token = "";
    state.connected = false;
    state.chats = [];
    state.tempChat = null;
    state.currentId = null;
    state.files = [];
    state.email = null;
    state.telegramName = null;
    state.authType = "link";
    state.role = "user";
    state.profile = { displayName: "", aboutText: "", memoryEnabled: true };
    $("promptInput").value = "";
    $("settingsDialog").close();
    clearTimeout(dailyResetTimer);
    renderAll();
    showToast("Вы вышли из аккаунта");
  } catch (error) { showToast(error.message); }
});

tokenFromUrl();
renderAll();
connect();
$("newChatButton").addEventListener("click", newChat);
$("newChatIcon").addEventListener("click", newChat);
$("temporaryChatButton").addEventListener("click", temporaryChat);
$("sidebarToggle").addEventListener("click", () => $("appShell").classList.add("sidebar-hidden"));
$("desktopOpen").addEventListener("click", () => $("appShell").classList.remove("sidebar-hidden"));
$("mobileMenu").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 760px)").matches) $("appShell").classList.add("mobile-open");
  else $("appShell").classList.toggle("sidebar-hidden");
});
$("mobileScrim").addEventListener("click", closeMobile);
$("modelTrigger").addEventListener("click", () => { if (!state.connected) { openSettings(); return; } const open = $("modelMenu").classList.toggle("hidden"); $("modelTrigger").setAttribute("aria-expanded", String(!open)); });
$("thinkingSelect").addEventListener("change", () => { state.thinking[state.model] = $("thinkingSelect").value; localStorage.setItem("chat_thinking", JSON.stringify(state.thinking)); });
$("webSearchToggle").addEventListener("click", () => { if (!supportsWebSearch(state.model)) return; state.webSearch = !state.webSearch; localStorage.setItem("chat_web_search", String(state.webSearch)); renderWebSearch(); });
document.addEventListener("click", (event) => { if (!event.target.closest(".model-control")) { $("modelMenu").classList.add("hidden"); $("modelTrigger").setAttribute("aria-expanded", "false"); } });
let memoryBusy = false;
let memoryData = null;
let memoryToggleBusy = false;
let memoryReturnToSettings = false;
function memoryError(text = "") { $("memoryError").textContent = text; $("memoryError").classList.toggle("hidden", !text); $("refreshMemoryButton").classList.toggle("hidden", !text); }
function renderMemory() {
  $("memorySummary").textContent = memoryData?.summary || (memoryData ? "Сводка появится автоматически, когда вы расскажете о себе в обычном чате. Здесь можно уточнить или удалить сведения." : "Загружаем…");
  $("memoryQuota").textContent = memoryData ? `Ручных обновлений осталось: ${memoryData.remaining} из ${memoryData.limit}. Автоматическая память обновляется вместе с обычным ответом без дополнительного запроса. Сброс ручного лимита в 00:00 по Москве.` : "";
  $("memoryEnabledNote").textContent = memoryData && !memoryData.memoryEnabled ? "Использование памяти отключено в настройках. Сводка сохраняется, но не передаётся в чаты." : "Сводка учитывается в обычных чатах при включённой памяти. Временные чаты её не используют.";
  $("updateMemoryButton").disabled = memoryBusy || memoryToggleBusy || !memoryData || memoryData.remaining <= 0;
  $("memoryCommandInput").disabled = memoryBusy || memoryToggleBusy;
  $("refreshMemoryButton").disabled = memoryBusy || memoryToggleBusy;
  $("updateMemoryButton").classList.toggle("memory-updating", memoryBusy);
  $("updateMemoryButton").setAttribute("aria-label", memoryBusy ? "Обновляем память" : "Обновить память");
  $("updateMemoryButton").title = memoryData ? `Обновить память · осталось ${memoryData.remaining} из ${memoryData.limit}` : "Обновить память";
  $("memoryPageEnabledInput").disabled = memoryBusy || memoryToggleBusy || !memoryData;
  $("memoryPageEnabledInput").checked = memoryData?.memoryEnabled ?? state.profile.memoryEnabled;
}
async function loadMemory() {
  if (memoryBusy || memoryToggleBusy) return;
  memoryBusy = true;
  memoryData = null;
  memoryError();
  renderMemory();
  const token = state.token;
  try { const result = await api("/api/memory"); if (state.token === token) memoryData = result; }
  catch (error) { memoryError(error.message); }
  finally { memoryBusy = false; renderMemory(); }
}
async function openMemory() {
  if (!state.connected) { openAuth(); return; }
  if (memoryBusy || memoryToggleBusy) { showToast("Дождитесь обновления памяти"); return; }
  memoryReturnToSettings = $("settingsDialog").open;
  if (memoryReturnToSettings) { $("settingsDialog").close(); await settingsSaveChain; }
  $("memoryCommandInput").value = "";
  $("memoryStatus").textContent = "";
  if (!$("memoryDialog").open) $("memoryDialog").showModal();
  closeMobile();
  await loadMemory();
}
$("memoryButton").addEventListener("click", openMemory);
$("settingsMemoryButton").addEventListener("click", openMemory);
$("refreshMemoryButton").addEventListener("click", loadMemory);
$("memoryDialog").addEventListener("close", () => {
  if (memoryReturnToSettings && state.connected) { memoryReturnToSettings = false; openSettings(); }
});
$("memoryPageEnabledInput").addEventListener("change", async () => {
  if (memoryToggleBusy || !memoryData) return;
  memoryToggleBusy = true;
  const enabled = $("memoryPageEnabledInput").checked;
  const previousEnabled = memoryData.memoryEnabled;
  memoryData.memoryEnabled = enabled;
  const token = state.token;
  renderMemory();
  memoryError();
  try {
    const result = await api("/api/memory/settings", { method: "PUT", body: JSON.stringify({ memoryEnabled: enabled }) });
    if (state.token !== token) return;
    memoryData.memoryEnabled = result.memoryEnabled;
    state.profile.memoryEnabled = result.memoryEnabled;
    $("memoryEnabledInput").checked = result.memoryEnabled;
    $("memoryStatus").textContent = result.memoryEnabled ? "Память включена" : "Память выключена";
  } catch (error) { memoryData.memoryEnabled = previousEnabled; memoryError(error.message); }
  finally { memoryToggleBusy = false; renderMemory(); }
});
$("memoryCommandInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("memoryCommandForm").requestSubmit(); }
});
$("memoryCommandForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (memoryBusy || memoryToggleBusy || !memoryData) return;
  const command = $("memoryCommandInput").value.trim();
  if (!command) return;
  memoryBusy = true;
  const token = state.token;
  memoryError();
  $("memoryStatus").textContent = "Нейросеть обновляет сводку…";
  renderMemory();
  try {
    const result = await api("/api/memory", { method: "POST", body: JSON.stringify({ command, version: memoryData.version }) });
    if (state.token !== token) return;
    memoryData = result;
    $("memoryCommandInput").value = "";
    $("memoryStatus").textContent = "Сводка памяти обновлена";
  } catch (error) { memoryError(error.message); $("memoryStatus").textContent = ""; }
  finally { memoryBusy = false; renderMemory(); }
});

$("settingsButton").addEventListener("click", openSettings);
$("topNewChat").addEventListener("click", newChat);
let settingsSaveTimer;
let settingsSaveChain = Promise.resolve();
let settingsLastQueued = "";
let settingsSaveVersion = 0;
function settingsSnapshot() {
  return { displayName: $("displayNameInput").value.trim(), aboutText: $("aboutTextInput").value.trim(), defaultModel: $("defaultModelSelect").value, memoryEnabled: $("memoryEnabledInput").checked };
}
function settingsStatus(text, error = false) {
  $("settingsSaveStatus").textContent = text;
  $("settingsSaveStatus").classList.toggle("error", error);
}
function queueSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  if (!state.connected) return;
  const profile = settingsSnapshot();
  const serialized = JSON.stringify(profile);
  if (serialized === settingsLastQueued) return;
  settingsLastQueued = serialized;
  const version = ++settingsSaveVersion;
  const token = state.token;
  settingsStatus("Сохраняем…");
  settingsSaveChain = settingsSaveChain.then(async () => {
    if (state.token !== token) return;
    try {
      const result = await api("/api/profile", { method: "PUT", body: JSON.stringify(profile) });
      if (state.token !== token) return;
      state.profile = result;
      state.defaultModel = result.defaultModel;
      localStorage.setItem("chat_default_model", state.defaultModel);
      if (!currentChat()) state.model = state.defaultModel;
      renderAll();
      if (version === settingsSaveVersion) settingsStatus("Сохранено");
    } catch (error) {
      if (version === settingsSaveVersion) { settingsLastQueued = ""; settingsStatus("Не удалось сохранить. Измените поле, чтобы повторить.", true); }
      showToast(error.message);
    }
  });
}
for (const field of ["displayNameInput", "aboutTextInput"]) {
  $(field).addEventListener("input", () => { clearTimeout(settingsSaveTimer); settingsStatus("Сохраняем…"); settingsSaveTimer = setTimeout(queueSettingsSave, 650); });
}
for (const field of ["displayNameInput", "aboutTextInput", "defaultModelSelect", "memoryEnabledInput"]) $(field).addEventListener("change", queueSettingsSave);
$("settingsDialog").addEventListener("close", () => { if (settingsSaveTimer) queueSettingsSave(); });
function openSettings() { if (!state.connected) { openAuth(); return; } $("defaultModelSelect").value = state.defaultModel; $("displayNameInput").value = state.profile.displayName; $("aboutTextInput").value = state.profile.aboutText; $("memoryEnabledInput").checked = state.profile.memoryEnabled; $("accessCodeInput").value = ""; $("accessCodeInput").placeholder = state.token ? "Личная ссылка уже сохранена" : "Вставьте личную ссылку"; settingsLastQueued = JSON.stringify(settingsSnapshot()); settingsStatus("Изменения сохраняются автоматически"); $("settingsDialog").showModal(); closeMobile(); }
$("saveSettings").addEventListener("click", async () => {
  if (state.busy || voiceProcessing || voiceRecorder?.state === "recording") { showToast("Дождитесь завершения запроса."); return; }
  const personalization = { displayName: $("displayNameInput").value.trim(), aboutText: $("aboutTextInput").value.trim(), defaultModel: $("defaultModelSelect").value, memoryEnabled: $("memoryEnabledInput").checked };
  state.defaultModel = $("defaultModelSelect").value;
  localStorage.setItem("chat_default_model", state.defaultModel);
  if (!currentChat()) state.model = state.defaultModel;
  const token = extractToken($("accessCodeInput").value);
  if (token) state.token = token;
  if (state.token) localStorage.setItem("chat_access_token", state.token);
  $("settingsDialog").close();
  if (!state.apiUrl) { showToast("Адрес Worker ещё не настроен владельцем сайта."); renderAll(); return; }
  await connect(false);
  if (state.connected) {
    try { state.profile = await api("/api/profile", { method: "PUT", body: JSON.stringify(personalization) }); state.defaultModel = state.profile.defaultModel; localStorage.setItem("chat_default_model", state.defaultModel); if (!currentChat()) state.model = state.defaultModel; renderAll(); promptForName(); showToast("Настройки сохранены"); }
    catch (error) { showToast(error.message); }
  }
});
$("nameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = $("firstNameInput").value.trim();
  if (!displayName) { $("firstNameInput").value = ""; $("firstNameInput").reportValidity(); return; }
  const button = $("nameForm").querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    state.profile = await api("/api/profile", { method: "PUT", body: JSON.stringify({ ...state.profile, displayName, defaultModel: state.defaultModel }) });
    $("nameDialog").close();
    showToast("Имя сохранено");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
$("nameLaterButton").addEventListener("click", () => $("nameDialog").close());
$("quotaCard").addEventListener("click", () => { $("limitsDialog").showModal(); closeMobile(); });
$("useResetButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/reset", { method: "POST", body: "{}" });
    state.remaining = result.remaining;
    state.resetBalance = result.resetBalance;
    state.nextResetAt = result.nextResetAt;
    renderQuota();
    showToast("Дневной лимит восстановлен");
  } catch (error) { showToast(error.message); }
});
$("clearChats").addEventListener("click", async () => {
  if (!confirm("Удалить все чаты? Это действие нельзя отменить.")) return;
  if (state.connected) {
    try { await api("/api/chats", { method: "DELETE" }); }
    catch (error) { showToast(error.message); return; }
  }
  state.chats = [];
  state.currentId = null;
  $("settingsDialog").close();
  renderAll();
});
$("searchButton").addEventListener("click", () => { $("searchInput").value = ""; renderSearch(); $("searchDialog").showModal(); $("searchInput").focus(); });
$("closeSearch").addEventListener("click", () => $("searchDialog").close());
$("searchInput").addEventListener("input", renderSearch);
$("promptInput").addEventListener("input", () => { const input = $("promptInput"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 190)}px`; updateSend(); });
$("promptInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
$("composerForm").addEventListener("submit", (event) => { event.preventDefault(); sendMessage(); });
$("voiceButton").addEventListener("click", toggleVoice);
$("attachButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (event) => {
  for (const file of event.target.files) {
    if (state.files.length >= 3) { showToast("Можно прикрепить до 3 файлов."); break; }
    if (file.size > 5 * 1024 * 1024) { showToast(`Файл «${file.name}» больше 5 МБ.`); continue; }
    state.files.push(file);
  }
  event.target.value = "";
  renderAttachments();
  updateSend();
});
$("suggestions").addEventListener("click", (event) => { const button = event.target.closest("[data-prompt]"); if (!button) return; $("promptInput").value = button.dataset.prompt; updateSend(); $("promptInput").focus(); });
