// app.js — INEA Conseil — Simulation d’appel client IA (vocal d’abord, texte ensuite)
// ✅ Mode appel : le client PARLE d’abord, la retranscription s’affiche APRÈS
// ✅ Verrou CLIENT (anti “je suis vendeur” / anti hors-sujet)
// ✅ Anti-prénoms (ne t’appelle jamais “Claire” + nettoyage automatique)
// ✅ Année actuelle (automatique) + règle “nous sommes en 2026” si tu veux la fixer
// ✅ Micro dictée (tu peux parler, réfléchir, reprendre, puis envoyer)
// ✅ Export retranscription
// ✅ Fallback modèles : 3B puis 1B si la machine ne tient pas

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

const personaSel = document.getElementById("persona"); // values: achats / ops / daf
const levelSel = document.getElementById("level");     // facile / moyen / expert

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

/* =========================
   Time (current year)
   - Si tu veux FORCER 2026, remplace la ligne par: const CURRENT_YEAR = 2026;
========================= */
const CURRENT_YEAR = new Date().getFullYear();

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
   IMPORTANT: on NE DONNE PAS de prénom au modèle => anti “Bonjour Claire”
========================= */
const PERSONAS = {
  achats: {
    label: "Responsable Achats",
    prompt: `
Identité:
- Tu es Responsable Achats (B2B).
- Tu ne donnes pas ton prénom.
Contexte:
- Tu compares 2 à 3 prestataires (formation, accompagnement, outils d'entraînement commercial).
Comportement:
- Polie, sceptique, factuelle, orientée contrat et conditions.
- Objections obligatoires: "on a déjà un fournisseur", "c'est cher", "prouvez-moi la valeur".
- Tu révèles budget / décideurs / calendrier uniquement si on te questionne correctement.
`.trim()
  },

  ops: {
    label: "Directrice des opérations",
    prompt: `
Identité:
- Tu es Directrice des opérations (B2B).
- Tu ne donnes pas ton prénom.
Contexte:
- Problème terrain: qualité irrégulière des rendez-vous, discours hétérogène, adoption faible des pratiques.
Comportement:
- Directe, pressée, pragmatique.
- Objections obligatoires: "je n'ai pas le temps", "on a déjà essayé", "ça va être compliqué à déployer".
- Tu veux: démarche simple, déploiement léger, résultats observables.
`.trim()
  },

  daf: {
    label: "Directrice financière",
    prompt: `
Identité:
- Tu es Directrice financière (B2B).
- Tu ne donnes pas ton prénom.
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
   1) Anti-prénoms (supprime “Bonjour Claire”, etc.)
   2) Anti-vendeur (si ça ressemble à un vendeur, on recadre)
========================= */
function sanitizeClientText(text) {
  let t = (text || "").trim();

  // Supprime un "Bonjour + Prénom" au début (Bonjour Claire / Bonsoir Paul / Salut Sophie, etc.)
  // => "Bonjour. ..."
  t = t.replace(
    /^(bonjour|bonsoir|salut)\s*,?\s*[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ-]+(\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ-]+)?\s*!?\s*/i,
    "$1. "
  );

  // Supprime occurrences "Claire" (au cas où)
  t = t.replace(/\bClaire\b/gi, "");

  // Nettoyage espaces
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function looksLikeSeller(text) {
  // Indices fréquents de dérive vendeur/catalogue
  return /(je vous propose|nous proposons|nos (offres|modèles|solutions)|je peux vous vendre|prix de vente|modèle de\s+\d{4}|voiture|mercedes)/i.test(text);
}

function forceClientRecovery() {
  return [
    "Pardon, je reformule en tant que cliente.",
    "Je cherche surtout à comprendre ce que vous pouvez m’apporter concrètement.",
    "Pouvez-vous m’expliquer votre approche, ce qui vous différencie, et comment on déploie ça sans complexifier le quotidien ?"
  ].join(" ");
}

/* =========================
   SYSTEM PROMPT (verrou CLIENT + année actuelle + mode appel)
========================= */
function buildSystemPrompt() {
  const lvl = levelSel.value;
  const p = PERSONAS[personaSel.value] || PERSONAS.achats;

  return `
Contexte temporel:
- Nous sommes en ${CURRENT_YEAR}.
- Tu raisonnes comme un professionnel en ${CURRENT_YEAR}.
- Tu ne mentionnes jamais de "date de coupure", "bloqué en 2023", ni des limites techniques.

Rôle (VERROUILLÉ):
- Tu es STRICTEMENT un CLIENT B2B dans une simulation d'appel téléphonique.
- Ton interlocuteur est un COMMERCIAL (ou manager en entraînement).
- Tu n'es jamais vendeur, jamais formateur, jamais coach, jamais assistant.

Règles strictes (IMPORTANT):
- Tu ne vends rien. Tu n'essaies pas de convaincre.
- Interdit d'utiliser des formulations de vendeur: "je vous propose", "nous proposons", "nos offres", "nos modèles", "nos solutions".
- Interdit de partir hors contexte (pas de voitures, pas de catalogue produits).
- Tu n'utilises aucun prénom (ni le tien, ni celui du commercial). Tu dis "Bonjour", "Merci", "D'accord".
- Réponses courtes: 2 à 5 phrases maximum (sauf DEBRIEF).
- Français naturel (France), style oral. Pas de listes à puces pendant l'appel.

Difficulté:
- ${lvl}
  * facile: coopératif, peu d'objections
  * moyen: objections réalistes, demande de preuves
  * expert: très exigeant, challenge prix/risque/déploiement

DEBRIEF (commande spéciale):
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu fournis EN FRANÇAIS:
  1) Retranscription propre (COMMERCIAL / CLIENT)
  2) Note /20 : Accroche(0-4), Découverte(0-4), Valeur(0-4), Objections(0-4), Closing(0-4)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
  Termine par "FIN DEBRIEF".

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
  setStatus("chargement…");

  if (!hasWebGPU()) {
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

      setStatus("appel prêt");
      setModelStatus(modelId);

      messages = [buildSystemMessage()];
      transcript = [];
      chatEl.innerHTML = "";

      addBubble("system", "SYSTEM", `✅ IA chargée. Mode appel activé (voix d’abord, texte ensuite). Persona: ${PERSONAS[personaSel.value]?.label || "Achats"}.`);
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
   Ask AI — MODE APPEL
   ✅ Génère la réponse sans l’afficher
   ✅ L’IA PARLE
   ✅ Puis affiche la retranscription
========================= */
async function askAI(userText) {
  if (!engine) return;

  // Stop voix en cours pour éviter chevauchement
  window.speechSynthesis.cancel();

  // Retranscription COMMERCIAL (immédiate)
  addBubble("user", "COMMERCIAL (retranscription)", userText);
  logToTranscript("COMMERCIAL", userText);
  messages.push({ role: "user", content: userText });

  setStatus("le client réfléchit…");

  // Génération (sans streaming affiché)
  let finalText = "";
  try {
    const completion = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 280
    });
    finalText = (completion?.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    addBubble("system", "SYSTEM", "Erreur IA pendant la réponse.");
    setStatus("erreur");
    console.error(e);
    return;
  }

  if (!finalText) finalText = "(pas de réponse)";

  // Verrous post-traitement
  finalText = sanitizeClientText(finalText);
  if (looksLikeSeller(finalText)) finalText = forceClientRecovery();

  // Ajouter au contexte conversation
  messages.push({ role: "assistant", content: finalText });
  logToTranscript("CLIENT", finalText);

  // VOIX D’ABORD
  setStatus("le client parle…");
  speak(finalText);

  // Attendre fin voix
  await waitForSpeechEnd();

  // Puis affichage retranscription CLIENT
  addBubble("client", "CLIENT (retranscription)", finalText);

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
  addBubble("system", "SYSTEM", `Session réinitialisée. Persona actif: ${p.label}. Mode appel prêt.`);
  logToTranscript("SYSTEM", "Session réinitialisée.");
  setStatus("appel prêt");
};

exportBtn.onclick = exportTranscript;

// Changement persona / niveau => reset (nouveau prompt)
personaSel.onchange = () => { if (engine) resetBtn.click(); };
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
setStatus("prêt");
addBubble(
  "system",
  "SYSTEM",
  "Clique “Charger l’IA”. Puis dicte dans le brouillon → “Envoyer”. Mode appel: le client parle d’abord, la retranscription s’affiche ensuite."
);
logToTranscript("SYSTEM", "Page ouverte.");


