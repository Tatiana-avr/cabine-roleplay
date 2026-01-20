// app.js — INEA Conseil (2026) — Jeu de rôle vocal client IA
// - WebLLM (gratuit, local navigateur)
// - Micro dictée (rien n'est envoyé automatiquement)
// - Streaming (pas de doublon)
// - Persona verrouillé CLIENT (anti "je suis vendeur")
// - Contexte temporel 2026 (anti "bloqué en 2023")
// - Export retranscription

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
   TTS (speech synthesis) + nettoyage lecture
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
    voices[0] ||
    null;

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
   STT (speech recognition) => dictée
   - rien n'est envoyé automatiquement
   - le brouillon accumule
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
  if (!rec) {
    alert("Reconnaissance vocale non supportée. Essaie Chrome ou Edge.");
    return;
  }
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
   PERSONAS (⚠️ clés = values du <select> HTML)
   Ici: achats / ops / daf
========================= */
const PERSONAS = {
  achats: {
    name: "Claire Martin",
    who: "CLIENT (Achats)",
    prompt: `
Identité:
- Tu t'appelles Claire Martin.
- Poste: Responsable Achats (B2B).

Contexte:
- Tu compares 2 à 3 prestataires pour un besoin lié à la performance commerciale (formation, coaching, outil d'entraînement).
- Tu n'as pas encore choisi. Tu veux du concret, du prix, et des preuves.

Comportement:
- Polie, sceptique, factuelle, pressée.
- Tu challengeras la valeur, les conditions, et le risque.
- Objections obligatoires: "on a déjà un fournisseur", "c'est cher", "prouvez-moi la valeur".
- Tu ne donnes pas spontanément: budget exact, décideurs, calendrier — sauf si le commercial pose les bonnes questions.
`.trim()
  },

  ops: {
    name: "Sophia Dupont",
    who: "CLIENT (Ops)",
    prompt: `
Identité:
- Tu t'appelles Sophia Dupont.
- Poste: Directrice des opérations / exploitation (B2B).

Contexte:
- Tu constates un problème opérationnel lié à la vente: qualité irrégulière des rendez-vous, discours terrain hétérogène, adoption faible d'une méthode, perte de temps en appels improductifs.
- Tu as 10 minutes. Tu veux une démarche simple, déployable, et pas une usine à gaz.

Comportement:
- Directe, pressée, parfois impatiente.
- Tu poses des questions sur: effort de déploiement, temps par semaine, résultats observables, contraintes terrain.
- Objections obligatoires: "je n'ai pas le temps", "on a déjà essayé", "ça va être compliqué à déployer".
`.trim()
  },

  daf: {
    name: "Élodie Roux",
    who: "CLIENT (DAF)",
    prompt: `
Identité:
- Tu t'appelles Élodie Roux.
- Poste: Directrice Financière (B2B).

Contexte:
- Tu dois valider un budget. Tu n'as pas demandé l'échange mais tu dois challenger la dépense.
- Tu veux limiter le risque, vérifier la conformité, et obtenir des conditions claires.

Comportement:
- Froide, logique, orientée chiffres.
- Tu demandes: coût total, engagement, clauses, réversibilité, preuves, conditions de paiement.
- Objections obligatoires: "retour sur investissement", "coût total", "engagement/clauses", "conformité/RGPD".
`.trim()
  }
};

/* =========================
   SYSTEM PROMPT (verrouillage client + 2026)
========================= */
function buildSystemPrompt() {
  const lvl = levelSel.value;
  const CURRENT_YEAR = 2026;

  const personaKey = personaSel.value;
  const p = PERSONAS[personaKey] || PERSONAS.achats;

  return `
Contexte temporel:
- Nous sommes en ${CURRENT_YEAR}. Tu parles et raisonnes comme un professionnel en ${CURRENT_YEAR}.
- Tu ne mentionnes jamais une "date de coupure" (2023) ni des limites techniques.

Rôle (VERROUILLÉ):
- Tu es le CLIENT. Identité fixe: ${p.name}.
- L'autre personne est un COMMERCIAL (ou manager en entraînement).
- Tu n'es jamais vendeur, jamais formateur, jamais coach.

Règles anti-dérive (IMPORTANT):
- Tu ne vends rien. Tu n'essaies pas de convaincre. Tu poses des questions, tu compares, tu résistes, tu négocies si besoin.
- Interdit de proposer des produits comme un vendeur (ex: "je peux vous vendre", "je vous propose une voiture", "nos modèles", etc.).
- Si tu commences à parler comme un vendeur, tu te corriges immédiatement et tu reviens au rôle CLIENT.
- Tu ne fais pas de listes à puces pendant la scène (sauf DEBRIEF).
- Tu ne tutoies pas. Français natif, phrases courtes, naturelles.
- Tu n'utilises pas le prénom de l'autre personne (ex: "Bonjour Claire") sauf si le commercial s'est présenté avec son prénom.
- Tu restes dans un contexte B2B de solution/service/formation/outil lié à la performance commerciale (pas de voitures, pas de sujets hors vente).

Difficulté:
- Niveau: ${lvl}. Plus c'est élevé, plus tu es exigeant et tu poses des objections.

Commande spéciale:
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu produis EN FRANÇAIS :
  1) Retranscription propre (COMMERCIAL/CLIENT)
  2) Note /20 : Accroche(0-4), Découverte(0-4), Valeur(0-4), Objections(0-4), Closing(0-4)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
  Puis termine par "FIN DEBRIEF".

Persona client:
${p.prompt}
`.trim();
}

function buildSystemMessage() {
  return { role: "system", content: buildSystemPrompt() };
}

/* =========================
   Model
========================= */
// Si tu veux meilleur français: passe en 3B (plus lent)
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";
// Alternative rapide:
// const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/* =========================
   Load model
========================= */
async function loadModel() {
  setStatus("chargement…");
  setModelStatus(`chargement: ${MODEL_ID}`);

  engine = new webllm.MLCEngine();

  const config = {
    ...webllm.prebuiltAppConfig,
    initProgressCallback: (p) => {
      if (p?.text) setModelStatus(p.text);
    }
  };

  await engine.reload(MODEL_ID, config);

  setStatus("modèle prêt");
  setModelStatus(MODEL_ID);

  messages = [buildSystemMessage()];
  transcript = [];
  chatEl.innerHTML = "";

  addBubble("system", "SYSTEM", "IA chargée (client). Dictez dans le brouillon, puis cliquez “Envoyer au client”.");
  logToTranscript("SYSTEM", "IA chargée.");

  ttsBtn.disabled = false;
  micStartBtn.disabled = false;
  sendBtn.disabled = false;
  debriefBtn.disabled = false;
  resetBtn.disabled = false;
  exportBtn.disabled = false;
}

/* =========================
   Ask AI (streaming dans UNE SEULE bulle)
========================= */
async function askAI(userText) {
  if (!engine) return;

  window.speechSynthesis.cancel();

  addBubble("user", "COMMERCIAL", userText);
  logToTranscript("COMMERCIAL", userText);

  messages.push({ role: "user", content: userText });

  setStatus("réponse du client…");

  // Une seule bulle client, remplie en streaming => pas de doublon
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
    addBubble("system", "SYSTEM", "Erreur chargement modèle : ouvre la console (F12) et copie le message d’erreur.");
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

  const key = personaSel.value;
  const p = PERSONAS[key] || PERSONAS.achats;

  addBubble("system", "SYSTEM", `Session réinitialisée. Persona actif: ${p.name}. Dictez puis envoyez.`);
  logToTranscript("SYSTEM", "Session réinitialisée.");

  setStatus("prêt");
};

exportBtn.onclick = exportTranscript;

// Changement persona/niveau => reset (nouveau prompt)
personaSel.onchange = () => { if (engine) resetBtn.click(); };
levelSel.onchange = () => { if (engine) resetBtn.click(); };

// Ctrl+Entrée = envoyer
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

