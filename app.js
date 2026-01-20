// app.js — INEA Conseil — Simulation d’appel client IA (vocal d’abord, texte ensuite)
// ✅ Mode appel : le client PARLE d’abord, la retranscription s’affiche APRÈS
// ✅ DEBRIEF : écrit uniquement (jamais lu à voix haute)
// ✅ Verrou CLIENT + anti “vendeur” + anti hors-sujet + année 2026
// ✅ Anti-prénoms : ne t’appelle pas “Claire” (nettoyage automatique)
// ✅ Timer d’appel + sonnerie (sans fichier externe) + états visuels (réfléchit / parle / prêt)
// ✅ Micro dictée + Export retranscription
// ✅ Fallback modèles : 3B puis 1B si besoin

import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm";

/* =========================
   DOM
========================= */
const chatEl = document.getElementById("chat");

const statusEl = document.getElementById("status");
const modelStatusEl = document.getElementById("modelStatus");
const micStatusEl = document.getElementById("micStatus");
const voiceStatusEl = document.getElementById("voiceStatus");

const loadBtn = document.getElementById("loadBtn");
const ttsBtn = document.getElementById("ttsBtn");

const personaSel = document.getElementById("persona"); // achats / ops / daf
const levelSel = document.getElementById("level");     // facile / moyen / expert

const draftEl = document.getElementById("draft");
const micStartBtn = document.getElementById("micStart");
const micStopBtn = document.getElementById("micStop");
const sendBtn = document.getElementById("sendBtn");
const debriefBtn = document.getElementById("debriefBtn");
const resetBtn = document.getElementById("resetBtn");
const exportBtn = document.getElementById("exportBtn");

// Optional UI elements (from your “call-style” HTML)
// If not present, we create a timer pill automatically.
const calleeNameEl = document.querySelector(".calleeName");   // optional
const callDotEl = document.querySelector(".dot");             // optional
const callBadgeEl = document.querySelector(".callBadge");     // optional

/* =========================
   State
========================= */
let engine = null;
let messages = [];
let transcript = [];

let ttsEnabled = true;
let bestVoice = null;

let isListening = false;
let suppressMicRestart = false;

// Call timer
let callStartMs = null;
let callTimerInterval = null;
let callTimerEl = document.getElementById("callTimer");

// Audio (ringtone / beeps)
let audioCtx = null;

/* =========================
   Time
========================= */
// Tu as demandé explicitement 2026.
const CURRENT_YEAR = 2026;

/* =========================
   UI helpers
========================= */
function setStatus(txt) { statusEl.textContent = `Status: ${txt}`; }
function setModelStatus(txt) { modelStatusEl.textContent = `Modèle: ${txt}`; }
function setMicStatus(txt) { micStatusEl.textContent = `Micro: ${txt}`; }
function setVoiceStatus(txt) { voiceStatusEl.textContent = `Voix: ${txt}`; }

function scrollChat() { chatEl.scrollTop = chatEl.scrollHeight; }
function nowStamp() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function addBubble(roleClass, who, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${roleClass}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${nowStamp()} • ${who}`;

  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text || "";

  bubble.appendChild(meta);
  bubble.appendChild(body);
  chatEl.appendChild(bubble);
  scrollChat();
  return body;
}

function logToTranscript(role, text) {
  transcript.push({ ts: new Date().toISOString(), role, text });
}

/* =========================
   Call UI state (visual)
========================= */
function setCallState(state) {
  // state: "idle" | "ready" | "thinking" | "speaking" | "debrief" | "error"
  document.body.dataset.callState = state;

  // little visual cue on the red dot (if exists)
  if (callDotEl) {
    if (state === "speaking") {
      callDotEl.style.boxShadow = "0 0 0 8px rgba(227,6,19,.22)";
    } else if (state === "thinking") {
      callDotEl.style.boxShadow = "0 0 0 8px rgba(17,24,39,.12)";
    } else {
      callDotEl.style.boxShadow = "0 0 0 6px rgba(227,6,19,.12)";
    }
  }

  // optional badge text
  if (callBadgeEl) {
    const strong = callBadgeEl.querySelector("strong");
    const span = callBadgeEl.querySelector("span:nth-child(2)");
    // keep it safe if structure differs
    if (span) {
      if (state === "speaking") span.textContent = "Client IA • parle";
      else if (state === "thinking") span.textContent = "Client IA • réfléchit";
      else if (state === "debrief") span.textContent = "Client IA • debrief";
      else if (state === "error") span.textContent = "Client IA • erreur";
      else span.textContent = "Client IA • simulation";
      if (strong) strong.textContent = "Client IA";
    }
  }
}

function updateCalleeTitle() {
  const p = PERSONAS[personaSel.value] || PERSONAS.achats;
  if (calleeNameEl) {
    calleeNameEl.textContent = `Client — ${p.label}`;
  }
}

/* =========================
   Timer
========================= */
function ensureTimerEl() {
  if (callTimerEl) return;

  // create a pill in header status row if possible
  const statusRow = statusEl?.parentElement; // .statusRow or .statusBar
  if (statusRow) {
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.id = "callTimer";
    pill.innerHTML = "<strong>Appel</strong>: 00:00";
    statusRow.appendChild(pill);
    callTimerEl = pill;
  }
}

function fmtMMSS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function startCallTimer() {
  ensureTimerEl();
  stopCallTimer();
  callStartMs = Date.now();
  if (callTimerEl) callTimerEl.innerHTML = `<strong>Appel</strong>: 00:00`;
  callTimerInterval = setInterval(() => {
    if (!callStartMs) return;
    const elapsed = Date.now() - callStartMs;
    if (callTimerEl) callTimerEl.innerHTML = `<strong>Appel</strong>: ${fmtMMSS(elapsed)}`;
  }, 250);
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
}

function resetCallTimer() {
  stopCallTimer();
  callStartMs = null;
  ensureTimerEl();
  if (callTimerEl) callTimerEl.innerHTML = `<strong>Appel</strong>: 00:00`;
}

/* =========================
   WebAudio (sonnerie / beep)
   - Sans fichier externe, 100% gratuit
========================= */
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playTone(freq, durationMs, gain = 0.06, type = "sine") {
  const ctx = getAudioCtx();
  const o = ctx.createOscillator();
  const g = ctx.createGain();

  o.type = type;
  o.frequency.value = freq;
  g.gain.value = gain;

  o.connect(g);
  g.connect(ctx.destination);

  const now = ctx.currentTime;
  o.start(now);
  o.stop(now + durationMs / 1000);

  // quick fade-out to avoid clicks
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

  return new Promise((res) => setTimeout(res, durationMs));
}

async function playRingtone() {
  // A short “ring ring” effect (two-tone), avoids being too loud
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();

    // ring pattern
    await playTone(440, 180, 0.05, "sine");
    await playTone(660, 180, 0.05, "sine");
    await new Promise(r => setTimeout(r, 120));
    await playTone(440, 180, 0.05, "sine");
    await playTone(660, 180, 0.05, "sine");
  } catch (_) {
    // ignore if blocked
  }
}

async function playBeep() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    await playTone(880, 90, 0.04, "square");
  } catch (_) {}
}

/* =========================
   TTS (speech synthesis)
========================= */
function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) { setVoiceStatus("pas de voix"); return; }

  const preferred = voices.filter(v =>
    v.lang?.toLowerCase().startsWith("fr") &&
    /microsoft|siri|google|denise|henri|paul|julie|natural|neural/i.test(v.name)
  );

  bestVoice =
    preferred[0] ||
    voices.find(v => v.lang?.toLowerCase().startsWith("fr")) ||
    voices[0] || null;

  setVoiceStatus(bestVoice ? `${bestVoice.name} (${bestVoice.lang})` : "non sélectionnée");
}
window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function normalizeForTTS(text) {
  let t = text || "";
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/\bIA\b/g, "i a");
  t = t.replace(/\bB2B\b/g, "bé to bé");
  t = t.replace(/\bCPF\b/g, "cé pé èf");
  t = t.replace(/\bKPI\b/g, "ké pi aï");
  t = t.replace(/\bROI\b/g, "retour sur investissement");
  t = t.replace(/(\d+)\s*€/g, "$1 euros");
  t = t.replace(/(\d+)\s*%/g, "$1 pour cent");
  t = t.replace(/[()[\]{}]/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function speak(text) {
  if (!ttsEnabled) return;
  const cleaned = normalizeForTTS(text);
  window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(cleaned);
  u.lang = "fr-FR";
  if (bestVoice) u.voice = bestVoice;
  u.rate = 1.02;
  u.pitch = 1.0;

  window.speechSynthesis.speak(u);
}

function waitForSpeechEnd() {
  return new Promise((resolve) => {
    const check = () => {
      if (!speechSynthesis.speaking) resolve();
      else setTimeout(check, 120);
    };
    check();
  });
}

/* =========================
   STT (dictée) — rien n’est envoyé automatiquement
========================= */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = SpeechRecognition ? new SpeechRecognition() : null;

if (rec) {
  rec.lang = "fr-FR";
  rec.interimResults = false;
  rec.continuous = true;
  setMicStatus("prêt");
} else {
  setMicStatus("non supporté (Chrome/Edge)");
}

function startListening() {
  if (!rec) return alert("Reconnaissance vocale non supportée. Essaie Chrome ou Edge.");
  suppressMicRestart = false;
  isListening = true;
  setMicStatus("écoute…");
  micStartBtn.disabled = true;
  micStopBtn.disabled = false;
  try { rec.start(); } catch (_) {}
}

function stopListening() {
  if (!rec) return;
  suppressMicRestart = true;
  isListening = false;
  setMicStatus("arrêt");
  micStartBtn.disabled = false;
  micStopBtn.disabled = true;
  try { rec.stop(); } catch (_) {}
}

if (rec) {
  rec.onresult = (evt) => {
    let chunk = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) chunk += (r[0]?.transcript || "");
    }
    chunk = (chunk || "").trim();
    if (!chunk) return;
    draftEl.value = (draftEl.value ? (draftEl.value + " ") : "") + chunk;
    draftEl.focus();
  };

  rec.onerror = () => {
    setMicStatus("erreur micro/STT");
    isListening = false;
    micStartBtn.disabled = false;
    micStopBtn.disabled = true;
  };

  rec.onend = () => {
    if (isListening && !suppressMicRestart) {
      try { rec.start(); } catch (_) {}
    } else {
      setMicStatus("prêt");
    }
  };
}

/* =========================
   PERSONAS (match index.html: achats / ops / daf)
   IMPORTANT: aucun prénom => anti “Bonjour Claire”
========================= */
const PERSONAS = {
  achats: {
    label: "Achats (comparaison fournisseurs)",
    prompt: `
Identité:
- Tu es Responsable Achats (B2B). Tu ne donnes pas ton prénom.
Contexte:
- Tu compares 2 à 3 prestataires (formation, accompagnement, outils d'entraînement commercial).
Comportement:
- Polie, sceptique, factuelle, orientée contrat et conditions.
- Objections obligatoires: "on a déjà un fournisseur", "c'est cher", "prouvez-moi la valeur".
- Tu révèles budget / décideurs / calendrier uniquement si on te questionne correctement.
`.trim()
  },

  ops: {
    label: "Ops (problème terrain urgent)",
    prompt: `
Identité:
- Tu es Directrice des opérations (B2B). Tu ne donnes pas ton prénom.
Contexte:
- Problème terrain: qualité irrégulière des rendez-vous, discours hétérogène, adoption faible des pratiques.
Comportement:
- Directe, pressée, pragmatique.
- Objections obligatoires: "je n'ai pas le temps", "on a déjà essayé", "ça va être compliqué à déployer".
- Tu veux: démarche simple, déploiement léger, résultats observables.
`.trim()
  },

  daf: {
    label: "DAF (validation / négociation)",
    prompt: `
Identité:
- Tu es Directrice financière (B2B). Tu ne donnes pas ton prénom.
Contexte:
- Tu valides un budget et limites le risque.
Comportement:
- Froide, logique, orientée chiffres et conformité.
- Objections obligatoires: "retour sur investissement", "coût total", "engagement/clauses", "conformité/RGPD".
`.trim()
  }
};

/* =========================
   HARD VERROUS (post-traitement)
========================= */
function sanitizeClientText(text) {
  let t = (text || "").trim();

  // Supprime un "Bonjour + Prénom" au début => "Bonjour. ..."
  t = t.replace(
    /^(bonjour|bonsoir|salut)\s*,?\s*[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ-]+(\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ-]+)?\s*!?\s*/i,
    "$1. "
  );

  // Neutralise certains prénoms si jamais le modèle insiste
  t = t.replace(/\bClaire\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function looksLikeSeller(text) {
  return /(je vous propose|nous proposons|nos (offres|modèles|solutions)|catalogue|voici nos|je peux vous vendre|mercedes|voiture)/i.test(text);
}

function forceClientRecovery() {
  return [
    "Pardon, je reformule en tant que cliente.",
    "Je cherche surtout à comprendre ce que vous pouvez m’apporter concrètement.",
    "Pouvez-vous m’expliquer votre approche, vos preuves de valeur, et comment on déploie ça simplement ?"
  ].join(" ");
}

/* =========================
   SYSTEM PROMPT (verrou CLIENT + année + style oral)
========================= */
function buildSystemPrompt() {
  const lvl = levelSel.value;
  const p = PERSONAS[personaSel.value] || PERSONAS.achats;

  return `
Contexte temporel:
- Nous sommes en ${CURRENT_YEAR}.
- Tu raisonnes comme un professionnel en ${CURRENT_YEAR}.
- Tu ne mentionnes jamais "bloqué en 2023" ni des limites techniques.

Rôle (VERROUILLÉ):
- Tu es STRICTEMENT un CLIENT B2B dans une simulation d'appel téléphonique.
- Ton interlocuteur est un COMMERCIAL (ou manager en entraînement).
- Tu n'es jamais vendeur, jamais formateur, jamais coach, jamais assistant.

Règles strictes:
- Tu ne vends rien. Tu ne proposes pas d'offres.
- Interdit: "je vous propose", "nous proposons", "nos offres", "nos modèles", "nos solutions".
- Interdit hors contexte (pas de voitures, pas de sujets non liés à un échange B2B).
- Tu n'utilises aucun prénom (ni le tien, ni celui du commercial).
- Style oral, français naturel (France).
- 2 à 5 phrases maximum par réponse (sauf DEBRIEF).
- Pas de listes à puces pendant l'appel (sauf DEBRIEF).

Difficulté:
- ${lvl}
  * facile: coopératif, peu d'objections
  * moyen: objections réalistes, demande de preuves
  * expert: très exigeant, challenge prix/risque/déploiement

DEBRIEF:
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu fournis EN FRANÇAIS:
  1) Retranscription propre (COMMERCIAL / CLIENT)
  2) Note /20 : Accroche(0-4), Découverte(0-4), Valeur(0-4), Objections(0-4), Closing(0-4)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
  Termine par "FIN DEBRIEF".
  IMPORTANT: le DEBRIEF doit être écrit et structuré.

Persona actif:
- ${p.label}

Détails persona:
${p.prompt}
`.trim();
}

function buildSystemMessage() {
  return { role: "system", content: buildSystemPrompt() };
}

/* =========================
   Model (fallback)
========================= */
const MODEL_CANDIDATES = [
  "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC"
];

function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/* =========================
   Load model
========================= */
async function loadModel() {
  setCallState("thinking");
  setStatus("chargement…");

  if (!hasWebGPU()) {
    setCallState("error");
    setStatus("WebGPU indisponible");
    setModelStatus("Erreur: WebGPU non disponible");
    addBubble("system", "SYSTEM", "WebGPU indisponible. Essaie Edge/Chrome récent + accélération matérielle.");
    return;
  }

  engine = new webllm.MLCEngine();
  const config = {
    ...webllm.prebuiltAppConfig,
    initProgressCallback: (p) => { if (p?.text) setModelStatus(p.text); }
  };

  let loaded = false;
  let lastError = null;

  for (const modelId of MODEL_CANDIDATES) {
    try {
      setModelStatus(`tentative: ${modelId}`);
      await engine.reload(modelId, config);
      loaded = true;

      setCallState("ready");
      setStatus("appel prêt");
      setModelStatus(modelId);

      messages = [buildSystemMessage()];
      transcript = [];
      chatEl.innerHTML = "";

      updateCalleeTitle();
      startCallTimer();

      addBubble("system", "SYSTEM", `✅ IA chargée. Mode appel activé. Persona: ${PERSONAS[personaSel.value]?.label || "Achats"}.`);
      logToTranscript("SYSTEM", `IA chargée: ${modelId}`);

      ttsBtn.disabled = false;
      micStartBtn.disabled = false;
      sendBtn.disabled = false;
      debriefBtn.disabled = false;
      resetBtn.disabled = false;
      exportBtn.disabled = false;

      break;
    } catch (e) {
      lastError = e;
      console.error("Erreur chargement modèle:", modelId, e);
    }
  }

  if (!loaded) {
    setCallState("error");
    setStatus("erreur chargement modèle");
    setModelStatus("échec (tous modèles)");
    addBubble("system", "SYSTEM", "Impossible de charger le modèle. Ouvre F12 → Console et copie la 1ère erreur rouge.");
    addBubble("system", "SYSTEM", String(lastError || "Erreur inconnue"));
  }
}

/* =========================
   Ask AI — MODE APPEL
   ✅ Génère la réponse sans l’afficher
   ✅ (si pas DEBRIEF) L’IA PARLE
   ✅ Puis affiche la retranscription
   ✅ (si DEBRIEF) écrit uniquement (pas de voix)
========================= */
async function askAI(userText) {
  if (!engine) return;

  const raw = (userText || "").trim();
  if (!raw) return;

  const isDebrief = raw.toUpperCase() === "DEBRIEF";

  // Stop voix en cours pour éviter chevauchement
  window.speechSynthesis.cancel();

  // Beep à l'envoi (effet “appel”)
  await playBeep();

  // Retranscription COMMERCIAL (immédiate)
  addBubble("user", "COMMERCIAL (retranscription)", raw);
  logToTranscript("COMMERCIAL", raw);
  messages.push({ role: "user", content: raw });

  setCallState("thinking");
  setStatus(isDebrief ? "debrief (écrit)…" : "le client réfléchit…");

  // Génération (sans streaming affiché)
  let finalText = "";
  try {
    const completion = await engine.chat.completions.create({
      messages,
      temperature: isDebrief ? 0.4 : 0.7,
      max_tokens: isDebrief ? 520 : 260
    });
    finalText = (completion?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    setCallState("error");
    addBubble("system", "SYSTEM", "Erreur IA pendant la réponse.");
    setStatus("erreur");
    console.error(e);
    return;
  }

  if (!finalText) finalText = "(pas de réponse)";

  // Verrous post-traitement
  finalText = sanitizeClientText(finalText);
  if (!isDebrief && looksLikeSeller(finalText)) finalText = forceClientRecovery();

  // Ajouter au contexte conversation
  messages.push({ role: "assistant", content: finalText });
  logToTranscript(isDebrief ? "DEBRIEF" : "CLIENT", finalText);

  // MODE APPEL
  if (!isDebrief) {
    setCallState("speaking");
    setStatus("le client parle…");
    speak(finalText);
    await waitForSpeechEnd();

    // Puis affichage retranscription CLIENT
    addBubble("client", "CLIENT (retranscription)", finalText);
  } else {
    // DEBRIEF : écrit uniquement (pas de voix)
    setCallState("debrief");
    setStatus("debrief (écrit) prêt");
    addBubble("system", "DEBRIEF (écrit)", finalText);
  }

  setCallState("ready");
  setStatus("appel prêt");
}

/* =========================
   Export retranscription
========================= */
function exportTranscript() {
  const lines = transcript.map(x => `${x.ts} [${x.role}] ${x.text}`).join("\n");
  const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `retranscription_inea_appel_${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.txt`;
  a.click();

  URL.revokeObjectURL(url);
}

/* =========================
   Events
========================= */
loadBtn.onclick = async () => {
  loadBtn.disabled = true;

  // Sonnerie au clic (effet “décrocher”)
  await playRingtone();

  try {
    await loadModel();
  } catch (e) {
    loadBtn.disabled = false;
    setCallState("error");
    setStatus("erreur chargement modèle");
    addBubble("system", "SYSTEM", "Erreur chargement modèle : ouvre F12 → Console et copie la 1ère erreur rouge.");
    addBubble("system", "SYSTEM", String(e));
    console.error(e);
  }
};

ttsBtn.onclick = () => {
  ttsEnabled = !ttsEnabled;
  ttsBtn.textContent = ttsEnabled ? "🔊 Voix ON" : "🔇 Voix OFF";
  if (!ttsEnabled) window.speechSynthesis.cancel();
};

micStartBtn.onclick = startListening;
micStopBtn.onclick = stopListening;

sendBtn.onclick = async () => {
  const text = (draftEl.value || "").trim();
  if (!text) return;
  draftEl.value = "";
  await askAI(text);
};

debriefBtn.onclick = async () => {
  draftEl.value = "";
  await askAI("DEBRIEF");
};

resetBtn.onclick = () => {
  window.speechSynthesis.cancel();
  stopListening();

  messages = [buildSystemMessage()];
  transcript = [];
  chatEl.innerHTML = "";

  updateCalleeTitle();
  resetCallTimer();

  addBubble("system", "SYSTEM", `Session réinitialisée. Persona actif: ${PERSONAS[personaSel.value]?.label || "Achats"}.`);
  logToTranscript("SYSTEM", "Session réinitialisée.");

  setCallState("ready");
  setStatus("appel prêt");
};

exportBtn.onclick = exportTranscript;

// Changement persona / niveau => reset (nouveau prompt)
personaSel.onchange = () => {
  updateCalleeTitle();
  if (engine) resetBtn.click();
};
levelSel.onchange = () => { if (engine) resetBtn.click(); };

// Ctrl + Entrée = envoyer
draftEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

/* =========================
   Init
========================= */
ensureTimerEl();
updateCalleeTitle();
setCallState("idle");
setStatus("prêt");
addBubble(
  "system",
  "SYSTEM",
  "Clique “Charger l’IA” (sonnerie + démarrage appel). Puis dicte dans le brouillon → “Envoyer”. Mode appel: voix d’abord, texte après. DEBRIEF: écrit uniquement."
);
logToTranscript("SYSTEM", "Page ouverte.");


