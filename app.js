// app.js — Version complète avec contexte temporel 2026 (et anti “bloqué en 2023”)
// + dictée micro (rien n’est envoyé automatiquement)
// + streaming dans une seule bulle (pas de doublon)
// + export retranscription
// + TTS améliorée (nettoyage texte avant lecture)

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
   TTS (speech synthesis) + amélioration lecture
========================= */
function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) { setVoiceStatus("pas de voix"); return; }

  // Priorité : voix FR, et si possible voix Microsoft/Siri/Google
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

  // retours ligne => pauses
  t = t.replace(/\n+/g, ". ");

  // acronymes & termes fréquents (prononciation)
  t = t.replace(/\bIA\b/g, "i a");
  t = t.replace(/\bB2B\b/g, "bé to bé");
  t = t.replace(/\bCPF\b/g, "cé pé èf");
  t = t.replace(/\bKPI\b/g, "ké pi aï");
  t = t.replace(/\bROI\b/g, "retour sur investissement");

  // monnaies / %
  t = t.replace(/(\d+)\s*€/g, "$1 euros");
  t = t.replace(/(\d+)\s*%/g, "$1 pour cent");

  // parenthèses et crochets perturbants
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
   STT (speech recognition) => dictée (n’envoie rien automatiquement)
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

  try { rec.start(); } catch (_) { /* déjà démarré */ }
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

    // Ajout au brouillon (dictée), sans envoi auto
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
    // relance automatique si coupure pendant dictée
    if (isListening && !suppressMicRestart) {
      try { rec.start(); } catch (_) {}
    } else {
      setMicStatus("prêt");
    }
  };
}

/* =========================
   Prompt SYSTEM (avec contexte 2026)
========================= */
function personaText() {
  const lvl = levelSel.value;
  const CURRENT_YEAR = 2026;

  // ⚠️ Contexte: l'IA est un CLIENT dans un jeu de rôle de vente B2B (pas vendeur)
  const baseContext = `
Contexte temporel :
- Nous sommes en ${CURRENT_YEAR}. Tu parles et raisonnes comme un professionnel en ${CURRENT_YEAR}.
- Tu ne mentionnes jamais des limites type "bloqué en 2023" ou "date de coupure".

Rôle (VERROUILLÉ) :
- Tu ES le CLIENT. Tu n'es jamais vendeur, jamais formateur, jamais coach.
- L'autre interlocuteur est le COMMERCIAL (ou manager en entraînement).
- Tu n'essaies pas de "vendre" quoi que ce soit. Tu évalues, tu questionnes, tu compares, tu résistes si besoin.

Règles de dialogue (anti-bug de rôle) :
- Tu ne proposes pas de produits/services à vendre. Tu peux demander des infos, challenger, refuser, négocier, demander un devis.
- Tu ne dis jamais "je peux vous proposer..." (sauf "je peux vous proposer un créneau" ou "je peux vous proposer d'envoyer un email", côté client).
- Tu ne donnes pas de liste à puces pendant la scène (sauf DEBRIEF).
- Tu ne tutoies pas. Tu utilises un français natif (France), simple, naturel.
- Tu ne utilises pas le prénom de l'autre personne. Tu dis "Bonjour" ou "Bonjour, merci" (sauf si le commercial se présente avec son prénom, alors tu peux le reprendre).
- Si tu détectes que tu parles comme un vendeur, tu te corriges immédiatement et tu reviens au rôle client.

Difficulté :
- Niveau: ${lvl}. Plus le niveau est élevé, plus tu poses d'objections et tu es exigeant.

Commande spéciale :
- Si le commercial dit "DEBRIEF", tu sors du rôle et tu produis :
  1) Retranscription propre (COMMERCIAL/CLIENT)
  2) Note /20 : Accroche, Découverte, Valeur, Objections, Closing (0-4 chacun)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
  Puis termine par "FIN DEBRIEF".
`.trim();

  // 👇 Personas: clients B2B réalistes
  const personas = {
    // IMPORTANT: ces clés doivent matcher ton <select> dans index.html
    // Si ton select a encore sophie/marc/colere, tu peux garder ces clés.
    claire: `
Identité:
- Tu t'appelles Claire Martin.
- Tu es Responsable Achats (B2B).

Contexte:
- Tu compares 2 à 3 prestataires.
- Tu cherches une solution pour améliorer la montée en compétence commerciale (formation/outil d'entraînement/jeu de rôle).

Comportement:
- Polie, factuelle, sceptique, pressée.
- Objections obligatoires: "on a déjà un fournisseur", "c'est cher", "prouvez-moi la valeur".
- Tu ne donnes pas le budget ni les décideurs si on ne te questionne pas correctement.
`.trim(),

    sophia: `
Identité:
- Tu t'appelles Sophia Dupont.
- Tu es Directeur des opérations / exploitation (B2B).

Contexte:
- Tu as un problème opérationnel lié à la performance commerciale (désalignement discours terrain, qualité des rendez-vous, adoption faible, hétérogénéité).
- Tu as peu de temps, tu veux du concret et une démarche simple.

Comportement:
- Direct, pressé, parfois impatient.
- Objections obligatoires: "je n'ai pas le temps", "on a déjà essayé", "ça va être compliqué à déployer".
- Tu poses des questions sur: effort de déploiement, temps par semaine, résultats observables, contraintes internes.
`.trim(),

    elodie: `
Identité:
- Tu t'appelles Élodie Roux.
- Tu es Directrice financière (B2B).

Contexte:
- Tu dois valider un budget. Tu n'as pas demandé l'échange mais tu dois challenger la dépense.

Comportement:
- Froide, logique, orientée chiffres.
- Objections obligatoires: "retour sur investissement", "coût total", "engagement/clauses", "conformité/RGPD".
- Tu demandes: coûts cachés, durée d'engagement, réversibilité, preuves, conditions de paiement.
`.trim()
  };

  const personaKey = personaSel.value;
  const personaBlock = personas[personaKey] || personas.marc;

  return `${baseContext}\n\n${personaBlock}`;
}


  const personaKey = personaSel.value;
  const personaBlock = personas[personaKey] || Object.values(personas)[0];

  return `${baseContext}\n\n${rules}\n\n${personaBlock}`;
}

function buildSystem() {
  return { role: "system", content: personaText() };
}

/* =========================
   Model
========================= */
// Si tu veux meilleure qualité FR : "Llama-3.2-3B-Instruct-q4f16_1-MLC" (plus lent)
// Ici on garde le modèle rapide. Tu peux changer en 3B si besoin.
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/* =========================
   Load model (robuste)
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

  messages = [buildSystem()];
  transcript = [];
  chatEl.innerHTML = "";

  addBubble("system", "SYSTEM", "IA chargée. Dicte dans le brouillon, puis clique “Envoyer au client”.");
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

  // Stop TTS pour éviter écho
  window.speechSynthesis.cancel();

  // Afficher la phrase du commercial
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
   Export transcript
========================= */
function exportTranscript() {
  const lines = transcript.map(x => `${x.ts} [${x.role}] ${x.text}`).join("\n");
  const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `retranscription_roleplay_${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.txt`;
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

  messages = [buildSystem()];
  transcript = [];
  chatEl.innerHTML = "";

  addBubble("system", "SYSTEM", "Session réinitialisée. Persona actif (contexte 2026). Dicte puis envoie.");
  logToTranscript("SYSTEM", "Session réinitialisée.");

  setStatus("prêt");
};

exportBtn.onclick = exportTranscript;

// Si persona/niveau change => reset (et donc prompt avec 2026 + nouvelles règles)
personaSel.onchange = () => { if (engine) resetBtn.click(); };
levelSel.onchange = () => { if (engine) resetBtn.click(); };

// Raccourci Ctrl+Entrée = envoyer
draftEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

/* Init */
setStatus("prêt");
addBubble("system", "SYSTEM", "Clique “Charger l’IA”. Puis micro en dictée → “Envoyer au client”.");
logToTranscript("SYSTEM", "Page ouverte.");
