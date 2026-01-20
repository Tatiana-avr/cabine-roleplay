import { CreateMLCEngine } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm";

/* =========================
   DOM
========================= */
const statusEl = document.getElementById("status");
const modelStatusEl = document.getElementById("modelStatus");
const voiceStatusEl = document.getElementById("voiceStatus");
const micStatusEl = document.getElementById("micStatus");
const logEl = document.getElementById("log");

const loadBtn = document.getElementById("loadBtn");
const resetBtn = document.getElementById("resetBtn");
const debriefBtn = document.getElementById("debriefBtn");
const exportBtn = document.getElementById("exportBtn");
const talkBtn = document.getElementById("talkBtn");
const stopBtn = document.getElementById("stopBtn");
const ttsToggleBtn = document.getElementById("ttsToggleBtn");

const personaSel = document.getElementById("persona");
const levelSel = document.getElementById("level");

/* =========================
   State
========================= */
let engine = null;
let messages = [];        // historique complet envoyé à l'IA (non limité, comme demandé)
let transcript = [];      // retranscription complète (export)
let ttsEnabled = true;

let bestVoice = null;

let isListening = false;  // push-to-talk + relance auto
let currentPartialClientLine = null; // streaming affiche en direct

/* =========================
   Helpers UI
========================= */
function setStatus(txt) { statusEl.textContent = `Status: ${txt}`; }
function setModelStatus(txt) { modelStatusEl.textContent = `Modèle: ${txt}`; }
function setVoiceStatus(txt) { voiceStatusEl.textContent = `Voix: ${txt}`; }
function setMicStatus(txt) { micStatusEl.textContent = `Micro: ${txt}`; }

function scrollLog() { logEl.scrollTop = logEl.scrollHeight; }

function appendLine(role, text) {
  logEl.textContent += `[${role}] ${text}\n`;
  scrollLog();
  transcript.push({ ts: new Date().toISOString(), role, text });
}

function appendSystem(text) { appendLine("SYSTEM", text); }

function appendCommercial(text) {
  appendLine("COMMERCIAL", text);
}

function appendClientFinal(text) {
  // remplace la ligne streaming si elle existe
  if (currentPartialClientLine !== null) {
    // on supprime la dernière ligne partielle du log et on met la finale
    // méthode simple : on réécrit tout (ok pour des logs raisonnables)
    // mais pour éviter de casser l'export, on ne met PAS la partielle dans transcript
    // => donc ici, on ajoute la finale normalement
    currentPartialClientLine = null;
  }
  appendLine("CLIENT", text);
}

function renderClientStreamingStart() {
  // on affiche une ligne CLIENT vide dans le log (visual only)
  // IMPORTANT: on ne l'ajoute pas à transcript (sinon export plein de bouts)
  logEl.textContent += `[CLIENT] `;
  scrollLog();
  currentPartialClientLine = "";
}

function renderClientStreamingDelta(delta) {
  if (currentPartialClientLine === null) return;
  currentPartialClientLine += delta;
  // on met à jour la toute fin du log (visual only)
  // technique: retirer tout après le dernier "[CLIENT] " puis réécrire
  // plus simple et robuste: reconstruire la dernière ligne uniquement
  const all = logEl.textContent;
  const idx = all.lastIndexOf("[CLIENT] ");
  if (idx >= 0) {
    logEl.textContent = all.slice(0, idx) + "[CLIENT] " + currentPartialClientLine;
    scrollLog();
  }
}

function renderClientStreamingEnd(finalText) {
  // ajoute un saut de ligne à l'affichage (si pas déjà)
  if (currentPartialClientLine !== null) {
    const all = logEl.textContent;
    if (!all.endsWith("\n")) logEl.textContent += "\n";
    currentPartialClientLine = null;
  }
  appendClientFinal(finalText);
}

/* =========================
   Speech synthesis (TTS)
========================= */
function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) {
    setVoiceStatus("pas de voix détectée");
    return;
  }

  // préféré : FR + "natural/neural/siri/microsoft/google"
  const preferred = voices.filter(v =>
    v.lang?.toLowerCase().startsWith("fr") &&
    /natural|neural|siri|microsoft|google/i.test(v.name)
  );

  bestVoice =
    preferred[0] ||
    voices.find(v => v.lang?.toLowerCase().startsWith("fr")) ||
    voices[0] ||
    null;

  if (bestVoice) setVoiceStatus(`${bestVoice.name} (${bestVoice.lang})`);
  else setVoiceStatus("non sélectionnée");
}

window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function speak(text) {
  if (!ttsEnabled) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  if (bestVoice) u.voice = bestVoice;
  u.rate = 1.02;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

/* =========================
   Speech Recognition (STT)
========================= */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = SpeechRecognition ? new SpeechRecognition() : null;

if (rec) {
  rec.lang = "fr-FR";
  rec.interimResults = false;
  rec.continuous = true; // on tente de garder l'écoute (selon navigateur)
  setMicStatus("prêt");
} else {
  setMicStatus("non supporté (essaie Chrome/Edge)");
}

function startRec() {
  if (!rec) {
    alert("Reconnaissance vocale non supportée. Essaie Chrome/Edge.");
    return;
  }
  isListening = true;
  setMicStatus("écoute…");
  talkBtn.disabled = true;
  stopBtn.disabled = false;

  try { rec.start(); } catch (_) {
    // rec.start peut throw si déjà démarré
  }
}

function stopRec() {
  if (!rec) return;
  isListening = false;
  setMicStatus("arrêt");
  stopBtn.disabled = true;
  talkBtn.disabled = false;

  try { rec.stop(); } catch (_) {}
}

if (rec) {
  rec.onresult = async (evt) => {
    // récupère le dernier résultat final
    let text = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) text += (r[0]?.transcript || "");
    }
    text = (text || "").trim();
    if (!text) return;

    // on stop l'écoute automatiquement dès qu'on a une phrase finalisée
    // (sinon le micro ré-attrape la voix TTS du client)
    stopRec();

    await askAI(text);
  };

  rec.onerror = () => {
    // en cas d'erreur : on repasse prêt
    setMicStatus("erreur micro/STT");
    stopBtn.disabled = true;
    talkBtn.disabled = false;
    isListening = false;
  };

  rec.onend = () => {
    // si ça coupe tout seul alors qu’on est censé écouter : on relance
    if (isListening) {
      try { rec.start(); } catch (_) {}
    } else {
      setMicStatus("prêt");
    }
  };
}

/* =========================
   Persona + System prompt
========================= */
function personaText() {
  const lvl = levelSel.value;

  const baseRules = `
Tu es STRICTEMENT un client dans un jeu de rôle commercial.
Règles absolues :
- Tu restes client à 100%. Tu ne dis jamais que tu es une IA.
- Style oral : phrases courtes, naturelles, crédibles.
- Tu poses des questions + objections réalistes.
- Tu ne coaches PAS pendant la scène.
- Tu ne donnes pas toutes les infos d'un coup : attends les bonnes questions.
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu produis EN FRANÇAIS :
  1) Retranscription propre (dialogue COMMERCIAL/CLIENT)
  2) Note /20 avec 5 critères: Accroche(0-4), Découverte(0-4), Valeur(0-4), Objections(0-4), Closing(0-4)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours (micro-exercices)
Puis tu termines par "FIN DEBRIEF".
Niveau: ${lvl}.
`.trim();

  const personas = {
    sophie: `
Persona: Sophie Bernard
- Poste: Directrice des achats (industrie/services techniques)
- Personnalité: sceptique, factuelle, pressée
- Contexte: déjà un prestataire, tu détestes le jargon IA
- Objections obligatoires à placer: "gadget", "ROI concret", "risques / conformité"
`.trim(),
    marc: `
Persona: Marc Delcourt
- Poste: Directeur commercial (B2B services)
- Personnalité: poli mais pressé, rationnel
- Contexte: tu écoutes par courtoisie, pas par intérêt
- Objections obligatoires à placer: "on fait déjà", "pas le temps", "prouve-moi le ROI"
`.trim(),
    colere: `
Persona: Nadia Leroy
- Contexte: client en colère (retard / litige)
- Personnalité: impatiente, coupe parfois la parole
- Objections obligatoires: "inadmissible", "je veux un responsable", "je résilie"
`.trim()
  };

  return `${baseRules}\n\n${personas[personaSel.value]}`;
}

function buildSystem() {
  return { role: "system", content: personaText() };
}

/* =========================
   Model
========================= */
// Tu peux changer ici si tu veux tester un autre modèle WebLLM.
// Celui-ci est un compromis, mais si c’est trop lent sur certains PC,
// on pourra le basculer vers un modèle plus léger.
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

/* =========================
   Load model
========================= */
async function loadModel() {
  setStatus("chargement… (1ère fois = téléchargement du modèle)");
  setModelStatus("téléchargement…");

  engine = await CreateMLCEngine(MODEL_ID, {
    initProgressCallback: (p) => {
      if (p?.text) setModelStatus(p.text);
    }
  });

  setStatus("modèle prêt");
  setModelStatus(MODEL_ID);

  messages = [buildSystem()];
  transcript = [];
  logEl.textContent = "";
  appendSystem("Modèle chargé. Maintiens 🎤 pour parler.");
  appendSystem("Astuce: clique Voix ON/OFF si tu veux couper la voix.");

  // active UI
  resetBtn.disabled = false;
  debriefBtn.disabled = false;
  exportBtn.disabled = false;
  talkBtn.disabled = false;
  ttsToggleBtn.disabled = false;
}

/* =========================
   Ask AI (Streaming)
========================= */
async function askAI(userText) {
  if (!engine) return;

  // Important : stop TTS en cours (évite que le micro récupère la voix)
  window.speechSynthesis.cancel();

  appendCommercial(userText);
  messages.push({ role: "user", content: userText });

  setStatus("réponse du client…");
  renderClientStreamingStart();

  let finalText = "";

  try {
    // Streaming: on itère sur les chunks
    const stream = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 220,
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        finalText += delta;
        renderClientStreamingDelta(delta);
      }
    }
  } catch (e) {
    setStatus("erreur IA");
    renderClientStreamingEnd("(Erreur: impossible de répondre. Réessaie.)");
    messages.push({ role: "assistant", content: "(Erreur de réponse)" });
    return;
  }

  finalText = (finalText || "").trim() || "(pas de réponse)";
  // fin streaming visuel + ajout à la retranscription
  renderClientStreamingEnd(finalText);

  // stocke dans l’historique complet
  messages.push({ role: "assistant", content: finalText });

  // parler après avoir fini (plus naturel que parler pendant le streaming)
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
  a.download = `retranscription_roleplay_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   UI bindings
========================= */
loadBtn.onclick = async () => {
  loadBtn.disabled = true;
  try {
    await loadModel();
  } catch (e) {
    loadBtn.disabled = false;
    setStatus("erreur chargement modèle");
    appendSystem("Erreur chargement: " + String(e));
  }
};

resetBtn.onclick = () => {
  if (!engine) return;
  window.speechSynthesis.cancel();
  transcript = [];
  logEl.textContent = "";
  messages = [buildSystem()];
  appendSystem("Session réinitialisée. Maintiens 🎤 pour parler.");
};

debriefBtn.onclick = () => askAI("DEBRIEF");

exportBtn.onclick = exportTranscript;

ttsToggleBtn.onclick = () => {
  ttsEnabled = !ttsEnabled;
  ttsToggleBtn.textContent = ttsEnabled ? "🔊 Voix ON" : "🔇 Voix OFF";
  if (!ttsEnabled) window.speechSynthesis.cancel();
};

/* Push-to-talk events */
function bindPushToTalk() {
  // Souris
  talkBtn.onmousedown = (e) => { e.preventDefault(); startRec(); };
  talkBtn.onmouseup = (e) => { e.preventDefault(); stopRec(); };
  talkBtn.onmouseleave = (e) => { e.preventDefault(); stopRec(); };

  // Mobile
  talkBtn.ontouchstart = (e) => { e.preventDefault(); startRec(); };
  talkBtn.ontouchend = (e) => { e.preventDefault(); stopRec(); };
  talkBtn.ontouchcancel = (e) => { e.preventDefault(); stopRec(); };

  stopBtn.onclick = (e) => { e.preventDefault(); stopRec(); };
}
bindPushToTalk();

/* Persona/level change => nouvelle session (on garde transcript séparé) */
personaSel.onchange = () => {
  if (!engine) return;
  window.speechSynthesis.cancel();
  transcript = [];
  logEl.textContent = "";
  messages = [buildSystem()];
  appendSystem("Persona changé. Nouvelle session.");
};

levelSel.onchange = () => {
  if (!engine) return;
  window.speechSynthesis.cancel();
  transcript = [];
  logEl.textContent = "";
  messages = [buildSystem()];
  appendSystem("Niveau changé. Nouvelle session.");
};

/* Init */
appendSystem("Clique ⬇️ Charger le modèle IA pour commencer.");
appendSystem("Ensuite: maintiens 🎤 pour parler. Clique DEBRIEF à la fin.");
