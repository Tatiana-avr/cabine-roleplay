import { CreateMLCEngine } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm";

const statusEl = document.getElementById("status");
const modelStatusEl = document.getElementById("modelStatus");
const logEl = document.getElementById("log");

const loadBtn = document.getElementById("loadBtn");
function startRec() {
  if (!rec) { alert("Reconnaissance vocale non supportée. Essaie Chrome/Edge."); return; }
  talkBtn.disabled = true;
  stopBtn.disabled = false;
  rec.start();
}

function stopRec() {
  if (!rec) return;
  rec.stop();
  stopBtn.disabled = true;
  talkBtn.disabled = false;
}

// Appui = start, relâche = stop (souris)
talkBtn.onmousedown = startRec;
talkBtn.onmouseup = stopRec;
talkBtn.onmouseleave = stopRec;

// Mobile: toucher = start, relâcher = stop
talkBtn.ontouchstart = (e) => { e.preventDefault(); startRec(); };
talkBtn.ontouchend = (e) => { e.preventDefault(); stopRec(); };

// bouton stop reste possible
stopBtn.onclick = stopRec;
let isListening = false;

function startRec() { isListening = true; /* ... */ }
function stopRec() { isListening = false; /* ... */ }

if (rec) {
  rec.onend = () => {
    // si ça s’arrête tout seul pendant qu’on écoute, on relance
    if (isListening) rec.start();
  };
}

const stopBtn = document.getElementById("stopBtn");
const debriefBtn = document.getElementById("debriefBtn");
const exportBtn = document.getElementById("exportBtn");
const resetBtn = document.getElementById("resetBtn");
const personaSel = document.getElementById("persona");
const levelSel = document.getElementById("level");

let engine = null;
let transcript = [];
let messages = [];

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = SpeechRecognition ? new SpeechRecognition() : null;
if (rec) {
  rec.lang = "fr-FR";
  rec.interimResults = false;
  rec.continuous = false;
}

let bestVoice = null;

function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  // On privilégie les voix FR "naturelles" (Edge/Windows/Mac peuvent en avoir)
  const preferred = voices.filter(v =>
    v.lang.toLowerCase().startsWith("fr") &&
    /natural|neural|siri|microsoft|google/i.test(v.name)
  );
  bestVoice = (preferred[0] || voices.find(v => v.lang.toLowerCase().startsWith("fr")) || null);
}

window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function speak(text) {
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  if (bestVoice) u.voice = bestVoice;
  u.rate = 1.02;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

function setStatus(txt) { statusEl.textContent = `Status: ${txt}`; }
function setModelStatus(txt) { modelStatusEl.textContent = `Modèle: ${txt}`; }

function append(role, text) {
  logEl.textContent += `[${role}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  transcript.push({ ts: new Date().toISOString(), role, text });
}

function personaText() {
  const lvl = levelSel.value;

  const baseRules = `
Tu es STRICTEMENT un client dans un jeu de rôle commercial.
Règles absolues :
- Tu restes client à 100%. Tu ne dis jamais que tu es une IA.
- Style oral, phrases courtes, naturelles.
- Tu poses des objections réalistes.
- Tu ne coaches PAS pendant la scène.
- Si l'utilisateur dit "DEBRIEF", tu sors du rôle et tu produis :
  1) retranscription propre (dialogue)
  2) note /20 (Accroche, Découverte, Valeur, Objections, Closing)
  3) 3 points forts, 3 axes
  4) 5 reformulations prêtes à dire
  5) plan d'entraînement 7 jours
Puis termine par "FIN DEBRIEF".
Niveau: ${lvl}.
`.trim();

  const personas = {
    sophie: `
Persona: Sophie Bernard
- Poste: Directrice des achats
- Personnalité: sceptique, pressée, factuelle
- Objections obligatoires: "gadget", "ROI concret", "risques / conformité"
`.trim(),
    marc: `
Persona: Marc Delcourt
- Poste: Directeur commercial
- Personnalité: poli mais pressé, rationnel
- Objections obligatoires: "on fait déjà", "pas le temps", "prouve-moi le ROI"
`.trim(),
    colere: `
Persona: Nadia Leroy
- Contexte: client en colère (retard/litige)
- Objections obligatoires: "inadmissible", "je veux un responsable", "je résilie"
`.trim()
  };

  return `${baseRules}\n\n${personas[personaSel.value]}`;
}

function buildSystem() {
  return { role: "system", content: personaText() };
}

// Modèle WebLLM (dans le navigateur) en format MLC/WebLLM :contentReference[oaicite:4]{index=4}
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

async function loadModel() {
  setStatus("chargement du modèle… (1ère fois = téléchargement)");
  engine = await CreateMLCEngine(MODEL_ID, {
    initProgressCallback: (p) => { if (p?.text) setModelStatus(p.text); }
  });
  setStatus("modèle prêt");
  setModelStatus(MODEL_ID);

  messages = [buildSystem()];
  talkBtn.disabled = false;
  debriefBtn.disabled = false;
  exportBtn.disabled = false;
  resetBtn.disabled = false;
  append("SYSTEM", "Modèle chargé. Clique 🎤 Parler.");
}

async function askAI(userText) {
  append("COMMERCIAL", userText);
  messages.push({ role: "user", content: userText });

  setStatus("l'IA répond…");
  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.7,
    max_tokens: 350
  });

  const text = (reply?.choices?.[0]?.message?.content || "").trim() || "(pas de réponse)";
  messages.push({ role: "assistant", content: text });

  append("CLIENT", text);
  speak(text);
  setStatus("prêt");
}

loadBtn.onclick = async () => {
  loadBtn.disabled = true;
  try { await loadModel(); }
  catch (e) {
    loadBtn.disabled = false;
    setStatus("erreur chargement modèle");
    append("SYSTEM", "Erreur: " + String(e));
  }
};

talkBtn.onclick = () => {
  if (!rec) { alert("Reconnaissance vocale non supportée. Essaie Chrome."); return; }
  talkBtn.disabled = true;
  stopBtn.disabled = false;
  rec.start();
};

stopBtn.onclick = () => {
  if (!rec) return;
  rec.stop();
  stopBtn.disabled = true;
  talkBtn.disabled = false;
};

if (rec) {
  rec.onresult = async (evt) => {
    stopBtn.disabled = true;
    talkBtn.disabled = false;
    const text = evt.results?.[0]?.[0]?.transcript?.trim() || "";
    if (text) await askAI(text);
  };
  rec.onerror = () => {
    stopBtn.disabled = true;
    talkBtn.disabled = false;
    append("SYSTEM", "Erreur micro / speech recognition. (Chrome recommandé)");
  };
}

debriefBtn.onclick = () => askAI("DEBRIEF");

exportBtn.onclick = () => {
  const lines = transcript.map(x => `${x.ts} [${x.role}] ${x.text}`).join("\n");
  const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `retranscription_roleplay.txt`;
  a.click();
  URL.revokeObjectURL(url);
};

resetBtn.onclick = () => {
  transcript = [];
  logEl.textContent = "";
  messages = [buildSystem()];
  append("SYSTEM", "Session reset. Clique 🎤 Parler.");
};

personaSel.onchange = () => {
  if (!engine) return;
  messages = [buildSystem()];
  transcript = [];
  logEl.textContent = "";
  append("SYSTEM", "Persona changé. Nouvelle session.");
};

levelSel.onchange = () => {
  if (!engine) return;
  messages = [buildSystem()];
  transcript = [];
  logEl.textContent = "";
  append("SYSTEM", "Niveau changé. Nouvelle session.");
};

append("SYSTEM", "Clique ⬇️ Charger le modèle IA pour commencer.");
