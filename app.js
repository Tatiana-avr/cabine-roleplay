// ✅ Version robuste : MLCEngine + prebuiltAppConfig (évite les erreurs "chargement modèle")
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
function setStatus(txt){ statusEl.textContent = `Status: ${txt}`; }
function setModelStatus(txt){ modelStatusEl.textContent = `Modèle: ${txt}`; }
function setMicStatus(txt){ micStatusEl.textContent = `Micro: ${txt}`; }
function setVoiceStatus(txt){ voiceStatusEl.textContent = `Voix: ${txt}`; }

function scrollChat(){ chatEl.scrollTop = chatEl.scrollHeight; }

function nowStamp(){
  return new Date().toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"});
}

function addBubble(role, who, text){
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;

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

  return body; // on renvoie le node texte (utile pour streaming)
}

function logToTranscript(role, text){
  transcript.push({ ts: new Date().toISOString(), role, text });
}

/* =========================
   TTS (speech synthesis)
========================= */
function pickBestVoice(){
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) { setVoiceStatus("pas de voix"); return; }

  const preferred = voices.filter(v =>
    v.lang?.toLowerCase().startsWith("fr") &&
    /natural|neural|siri|microsoft|google/i.test(v.name)
  );

  bestVoice =
    preferred[0] ||
    voices.find(v => v.lang?.toLowerCase().startsWith("fr")) ||
    voices[0] || null;

  setVoiceStatus(bestVoice ? `${bestVoice.name} (${bestVoice.lang})` : "non sélectionnée");
}
window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function speak(text){
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
   STT (speech recognition) => dictée
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

function startListening(){
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

function stopListening(){
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
   Persona prompt
========================= */
function personaText(){
  const lvl = levelSel.value;

  const base = `
Tu es STRICTEMENT un client dans un jeu de rôle commercial.
Règles absolues :
- Tu restes client à 100%. Tu ne dis jamais que tu es une IA.
- Style oral : phrases courtes, naturelles, crédibles.
- Tu poses des questions + objections réalistes.
- Tu ne coaches PAS pendant la scène.
- Tu ne donnes pas toutes les infos d'un coup : attends les bonnes questions.
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu produis EN FRANÇAIS :
  1) Retranscription propre (dialogue COMMERCIAL/CLIENT)
  2) Note /20 : Accroche(0-4), Découverte(0-4), Valeur(0-4), Objections(0-4), Closing(0-4)
  3) 3 points forts + 3 axes d'amélioration
  4) 5 reformulations prêtes à dire
  5) Plan d'entraînement sur 7 jours
Puis termine par "FIN DEBRIEF".
Niveau: ${lvl}.
`.trim();

  const personas = {
    sophie: `
Persona: Sophie Bernard
- Poste: Directrice des achats
- Personnalité: sceptique, factuelle, pressée
- Contexte: déjà un prestataire, tu détestes le jargon IA
- Objections obligatoires: "gadget", "ROI concret", "risques / conformité"
`.trim(),
    marc: `
Persona: Marc Delcourt
- Poste: Directeur commercial (B2B services)
- Personnalité: poli mais pressé, rationnel
- Contexte: tu écoutes par courtoisie, pas par intérêt
- Objections obligatoires: "on fait déjà", "pas le temps", "prouve-moi le ROI"
`.trim(),
    colere: `
Persona: Nadia Leroy
- Contexte: cliente en colère (retard/litige)
- Personnalité: impatiente, coupe parfois la parole
- Objections obligatoires: "inadmissible", "je veux un responsable", "je résilie"
`.trim()
  };

  return `${base}\n\n${personas[personaSel.value]}`;
}

function buildSystem(){
  return { role: "system", content: personaText() };
}

/* =========================
   Model
   ✅ On met un modèle "low resource" et plus rapide.
   Tu peux repasser en 3B si les PC sont puissants.
========================= */
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/* =========================
   Load model (robuste)
========================= */
async function loadModel(){
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
async function askAI(userText){
  if (!engine) return;

  window.speechSynthesis.cancel();

  addBubble("user", "COMMERCIAL", userText);
  logToTranscript("COMMERCIAL", userText);

  messages.push({ role:"user", content:userText });

  setStatus("réponse du client…");

  streamingTextEl = addBubble("client", "CLIENT", "");
  let finalText = "";

  try{
    const stream = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 260,
      stream: true
    });

    for await (const chunk of stream){
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (!delta) continue;
      finalText += delta;
      streamingTextEl.textContent = finalText;
      scrollChat();
    }

  } catch(e){
    streamingTextEl.textContent = "Erreur: chargement/réponse impossible. Réessaie.";
    setStatus("erreur");
    messages.push({ role:"assistant", content:"(erreur)" });
    logToTranscript("CLIENT", "(erreur)");
    streamingTextEl = null;
    return;
  }

  finalText = (finalText || "").trim() || "(pas de réponse)";
  streamingTextEl.textContent = finalText;
  streamingTextEl = null;

  messages.push({ role:"assistant", content: finalText });
  logToTranscript("CLIENT", finalText);

  speak(finalText);
  setStatus("prêt");
}

/* =========================
   Export
========================= */
function exportTranscript(){
  const lines = transcript.map(x => `${x.ts} [${x.role}] ${x.text}`).join("\n");
  const blob = new Blob([lines], { type:"text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `retranscription_roleplay_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   Events
========================= */
loadBtn.onclick = async () => {
  loadBtn.disabled = true;
  try { await loadModel(); }
  catch(e){
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
  addBubble("system", "SYSTEM", "Session réinitialisée. Persona actif. Dicte puis envoie.");
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
addBubble("system", "SYSTEM", "Clique “Charger l’IA”. Puis micro en dictée → “Envoyer au client”.");
logToTranscript("SYSTEM", "Page ouverte.");
