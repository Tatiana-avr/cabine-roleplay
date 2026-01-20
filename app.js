import { CreateMLCEngine } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm";

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
let messages = [];     // historique complet (non limité)
let transcript = [];   // export complet

let ttsEnabled = true;
let bestVoice = null;

let isListening = false;
let suppressMicRestart = false;

let streamingBubble = null; // bubble en cours de streaming (pour éviter doublon)

/* =========================
   UI helpers
========================= */
function setStatus(txt){ statusEl.textContent = `Status: ${txt}`; }
function setModelStatus(txt){ modelStatusEl.textContent = `Modèle: ${txt}`; }
function setMicStatus(txt){ micStatusEl.textContent = `Micro: ${txt}`; }
function setVoiceStatus(txt){ voiceStatusEl.textContent = `Voix: ${txt}`; }

function scrollChat(){ chatEl.scrollTop = chatEl.scrollHeight; }

function addBubble({role, text, meta}) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = meta || "";

  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.textContent = text || "";

  bubble.appendChild(metaEl);
  bubble.appendChild(textEl);
  chatEl.appendChild(bubble);
  scrollChat();

  return { bubble, textEl };
}

function nowStamp(){
  return new Date().toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"});
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
   STT (speech recognition) => MODE DICTÉE
   - n’envoie rien automatiquement
   - ajoute au brouillon
   - redémarre si ça coupe
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
  setMicStatus("écoute… (dictée)");
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
    // Ajouter toutes les phrases finalisées au brouillon
    let chunk = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      if (r.isFinal) chunk += (r[0]?.transcript || "");
    }
    chunk = (chunk || "").trim();
    if (!chunk) return;

    // Ajout au brouillon sans envoyer
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
    // Si ça coupe tout seul pendant l’écoute, on relance (mode dictée)
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
========================= */
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

/* =========================
   Load model
========================= */
async function loadModel(){
  setStatus("chargement… (1ère fois = téléchargement)");
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
  chatEl.innerHTML = "";

  addBubble({ role:"system", meta:`${nowStamp()} • SYSTEM`, text:"Modèle chargé. Utilise le micro en mode dictée, puis clique “Envoyer au client” quand tu es prêt." });
  logToTranscript("SYSTEM", "Modèle chargé.");

  // enable UI
  ttsBtn.disabled = false;
  micStartBtn.disabled = false;
  sendBtn.disabled = false;
  debriefBtn.disabled = false;
  resetBtn.disabled = false;
  exportBtn.disabled = false;
}

/* =========================
   Ask AI (streaming sans doublon)
========================= */
async function askAI(userText){
  if (!engine) return;

  // stop TTS (évite écho)
  window.speechSynthesis.cancel();

  // log user
  addBubble({ role:"user", meta:`${nowStamp()} • COMMERCIAL`, text:userText });
  logToTranscript("COMMERCIAL", userText);

  messages.push({ role:"user", content:userText });

  setStatus("réponse du client…");

  // créer UNE SEULE bulle client qui va être remplie en streaming
  const { textEl } = addBubble({ role:"client", meta:`${nowStamp()} • CLIENT`, text:"" });
  streamingBubble = textEl;

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
      // mise à jour DIRECTE de la même bulle => pas de doublon
      streamingBubble.textContent = finalText;
      scrollChat();
    }

  } catch(e){
    streamingBubble.textContent = "Erreur: impossible de répondre. Réessaie.";
    setStatus("erreur IA");
    messages.push({ role:"assistant", content:"(erreur)" });
    logToTranscript("CLIENT", "(erreur)");
    streamingBubble = null;
    return;
  }

  finalText = (finalText || "").trim() || "(pas de réponse)";
  streamingBubble.textContent = finalText;
  streamingBubble = null;

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
    setStatus("erreur chargement");
    addBubble({ role:"system", meta:`${nowStamp()} • SYSTEM`, text:`Erreur chargement: ${String(e)}`});
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
  addBubble({ role:"system", meta:`${nowStamp()} • SYSTEM`, text:"Session réinitialisée. Persona actif. Tu peux redémarrer l’écoute et dicter ton brouillon." });
  logToTranscript("SYSTEM", "Session réinitialisée.");
  setStatus("prêt");
};

exportBtn.onclick = exportTranscript;

personaSel.onchange = () => {
  if (!engine) return;
  resetBtn.click();
};
levelSel.onchange = () => {
  if (!engine) return;
  resetBtn.click();
};

// Raccourci Ctrl+Enter pour envoyer
draftEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

/* Init */
setStatus("prêt");
addBubble({ role:"system", meta:`${nowStamp()} • SYSTEM`, text:"Clique “Charger l’IA”. Ensuite : “Démarrer l’écoute” pour dicter, puis “Envoyer au client”." });
logToTranscript("SYSTEM", "Page ouverte. En attente du chargement IA.");
