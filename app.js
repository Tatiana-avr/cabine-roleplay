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

const personaSel = document.getElementById("persona");
const levelSel = document.getElementById("level");

const draftEl = document.getElementById("draft");
const micStartBtn = document.getElementById("micStart");
const micStopBtn = document.getElementById("micStop");
const sendBtn = document.getElementById("sendBtn");
const debriefBtn = document.getElementById("debriefBtn");
const resetBtn = document.getElementById("resetBtn");
const exportBtn = document.getElementById("exportBtn");

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

let streamingTextEl = null;

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
  return body; // pour streaming
}

function logToTranscript(role, text) {
  transcript.push({ ts: new Date().toISOString(), role, text });
}

/* =========================
   TTS
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

/* =========================
   STT (dictée)
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
========================= */
const PERSONAS = {
  achats: {
    name: "Claire Martin",
    prompt: `
Identité:
- Tu es Responsable Achats. Tu ne donnes pas ton prénom spontanément.
- Poste: Responsable Achats (B2B).

Contexte:
- Tu compares 2 à 3 prestataires (formation/outils d'entraînement commercial).
- Tu veux du concret, du prix, des preuves.

Comportement:
- Polie, sceptique, factuelle.
- Objections obligatoires: "on a déjà un fournisseur", "c'est cher", "prouvez-moi la valeur".
- Tu ne donnes pas spontanément: budget exact, décideurs, calendrier (sauf bonnes questions).
`.trim()
  },
  ops: {
    name: "Sophia Dupont",
    prompt: `
Identité:
- Tu es directrice des opérations
- Poste: Directrice des opérations (B2B).

Contexte:
- Problème: qualité irrégulière des RDV, discours terrain hétérogène, adoption faible.
- Tu as 10 minutes. Tu veux une démarche simple, déployable.

Comportement:
- Directe, pressée.
- Objections obligatoires: "je n'ai pas le temps", "on a déjà essayé", "ça va être compliqué à déployer".
`.trim()
  },
  daf: {
    name: "Élodie Roux",
    prompt: `
Identité:
- Tu es directrice financière
- Poste: Directrice financière (B2B).

Contexte:
- Tu valides un budget, tu limites le risque.

Comportement:
- Froide, logique, orientée chiffres.
- Objections obligatoires: "retour sur investissement", "coût total", "engagement/clauses", "conformité/RGPD".
`.trim()
  }
};

/* =========================
   SYSTEM PROMPT (client verrouillé + 2026)
========================= */
function buildSystemPrompt() {
  const lvl = levelSel.value;
  const CURRENT_YEAR = 2026;
  const p = PERSONAS[personaSel.value] || PERSONAS.achats;

  return `
Contexte temporel:
- Nous sommes en ${CURRENT_YEAR}.
- Tu ne mentionnes jamais une "date de coupure" (2023) ni des limites techniques.

Rôle (VERROUILLÉ):
- Tu es le CLIENT. Identité fixe: ${p.name}.
- L'autre personne est un COMMERCIAL.
- Tu n'es jamais vendeur, jamais formateur, jamais coach.

Règles strictes de rôle :
- Tu es un CLIENT. Tu n'es jamais vendeur.
- Tu n'utilises JAMAIS les expressions suivantes :
  "je vous propose"
  "nous proposons"
  "nos offres"
  "nos modèles"
  "nos solutions"
- Si tu détectes que tu viens de parler comme un vendeur, tu te corriges immédiatement et reformules comme un client.

Règles de langage :
- Tu n'utilises JAMAIS le prénom de ton interlocuteur.
- Tu n'appelles jamais l'autre personne par un prénom, même si tu le connais.
- Tu dis uniquement : "Bonjour", "Merci", "Très bien", "D'accord".
- Tu ne révèles ton prénom QUE si le commercial te le demande explicitement.

Anti-dérive (IMPORTANT):
- Tu ne vends rien. Tu ne proposes pas "nos produits/modèles".
- Interdit de parler de voitures ou de sujets hors B2B (formation/outil/service commercial).
- Tu ne fais pas de listes à puces pendant la scène (sauf DEBRIEF).
- Français natif, phrases courtes.
- Tu n'utilises pas le prénom de l'autre personne (sauf si le commercial s'est présenté avec son prénom).

Difficulté:
- Niveau: ${lvl}. Plus c'est élevé, plus tu es exigeant et tu poses des objections.

DEBRIEF:
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu produis:
  1) Retranscription COMMERCIAL/CLIENT
  2) Note /20 (Accroche, Découverte, Valeur, Objections, Closing)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
  Puis "FIN DEBRIEF".

Persona client:
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
  setStatus("chargement…");

  if (!hasWebGPU()) {
    setStatus("WebGPU indisponible");
    setModelStatus("Erreur: WebGPU non disponible");
    addBubble("system", "SYSTEM", "WebGPU n'est pas disponible. Essaie Edge/Chrome récent + accélération matérielle.");
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

      setStatus("modèle prêt");
      setModelStatus(modelId);

      messages = [buildSystemMessage()];
      transcript = [];
      chatEl.innerHTML = "";

      addBubble("system", "SYSTEM", `IA chargée (client). Modèle: ${modelId}.`);
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
    setStatus("erreur chargement modèle");
    setModelStatus("échec (tous modèles)");
    addBubble("system", "SYSTEM", "Impossible de charger le modèle. Ouvre F12 → Console et copie la 1ère erreur rouge.");
    addBubble("system", "SYSTEM", String(lastError || "Erreur inconnue"));
  }
}

/* =========================
   Ask AI (streaming, une seule bulle)
========================= */
async function askAI(userText) {
  if (!engine) return;

  window.speechSynthesis.cancel();

  addBubble("user", "COMMERCIAL", userText);
  logToTranscript("COMMERCIAL", userText);
  messages.push({ role: "user", content: userText });

  setStatus("réponse du client…");

  streamingTextEl = addBubble("client", "CLIENT", "");
  let finalText = "";

  try {
    const stream = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 240,
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (!delta) continue;
      finalText += delta;
      streamingTextEl.textContent = finalText;
      scrollChat();
    }
  } catch (e) {
    streamingTextEl.textContent = "Erreur: réponse impossible. Réessaie.";
    setStatus("erreur");
    messages.push({ role: "assistant", content: "(erreur)" });
    logToTranscript("CLIENT", "(erreur)");
    streamingTextEl = null;
    return;
  }

  finalText = (finalText || "").trim() || "(pas de réponse)";
  streamingTextEl.textContent = finalText;
  streamingTextEl = null;

  messages.push({ role: "assistant", content: finalText });
  logToTranscript("CLIENT", finalText);

  speak(finalText);
  setStatus("prêt");
}

/* =========================
   Export
========================= */
function exportTranscript() {
  const lines = transcript.map(x => `${x.ts} [${x.role}] ${x.text}`).join("\n");
  const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `retranscription_inea_roleplay_${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   Events
========================= */
loadBtn.onclick = async () => {
  loadBtn.disabled = true;
  try {
    await loadModel();
  } catch (e) {
    loadBtn.disabled = false;
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

  const p = PERSONAS[personaSel.value] || PERSONAS.achats;
  addBubble("system", "SYSTEM", `Session réinitialisée. Persona actif: ${p.name}.`);
  logToTranscript("SYSTEM", "Session réinitialisée.");
  setStatus("prêt");
};

exportBtn.onclick = exportTranscript;

personaSel.onchange = () => { if (engine) resetBtn.click(); };
levelSel.onchange = () => { if (engine) resetBtn.click(); };

draftEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

/* Init */
setStatus("prêt");
addBubble("system", "SYSTEM", "Cliquez “Charger l’IA”. Puis micro en dictée → “Envoyer au client”.");
logToTranscript("SYSTEM", "Page ouverte.");

