// Lis-moi : la voix.
//  - "naturelle" : voix Piper (réseau de neurones), calculée sur le téléphone, hors ligne une fois installée.
//    Bien plus claire et moins robotique que les voix système. Vitesse réglable sans rendre la voix aiguë.
//  - "systeme"   : voix de synthèse du téléphone (secours, ou si la voix naturelle n'est pas installée).
// API : Voix.speak(mots, {rate, onWord(j), onEnd(), onError(msg), onWait(bool)}), Voix.stop(), Voix.prefetch(mots, rate)
"use strict";
const Voix = (() => {
  const VOICE = "fr_FR-siwis-medium";
  const CACHE = "lis-moi-voix";
  const FILES = [   // [chemin, taille approx. en octets] : ce qu'il faut garder pour la voix naturelle hors ligne
    ["vendor/voix/" + VOICE + ".onnx", 63221984], ["vendor/voix/" + VOICE + ".onnx.json", 5458],
    ["vendor/piper/piper_phonemize.data", 18077249], ["vendor/piper/piper_phonemize.wasm", 635212],
    ["vendor/piper/piper_phonemize.js", 120714], ["voix-worker.js", 5000]
  ];
  const PAUSE = 0.35;      // silence après chaque phrase (s), allongé quand on ralentit
  const synth = window.speechSynthesis;

  /* ---------- Réglages (mémorisés sur l'appareil) ---------- */
  const R = { moteur: "systeme", voixSysteme: "", vitesse: 0.9 };
  try { Object.assign(R, JSON.parse(localStorage.getItem("lismoi-voix") || "{}")); } catch (e) {}
  const save = () => { try { localStorage.setItem("lismoi-voix", JSON.stringify(R)); } catch (e) {} };

  /* ---------- Ce qu'on prononce ---------- */
  // abréviations qu'aucune des voix ne lit bien
  const SPOKEN = { "M.": "monsieur", "MM.": "messieurs", "Mme": "madame", "Mme.": "madame", "Mmes": "mesdames",
    "Mlle": "mademoiselle", "Mlles": "mesdemoiselles", "Dr": "docteur", "Dr.": "docteur", "ex.": "par exemple",
    "etc.": "et cetera", "cf.": "voir", "n°": "numéro", "N°": "numéro", "c.-à-d.": "c'est-à-dire", "&": "et" };
  function spoken(w){
    const m = w.match(/^([«"(]*)(.*?)([»")]*[,;:!?]?)$/u);
    const core = m ? m[2] : w;
    if (SPOKEN[core] !== undefined) return (m[1] || "") + SPOKEN[core] + (m[3] || "");
    return w.replace(/^[—–-]$/, "").replace(/^[—–]\s*/, "");   // tiret de dialogue : on ne le lit pas
  }

  /* ---------- Voix du système ---------- */
  function systemVoices(){
    const vs = synth ? synth.getVoices().filter(v => /^fr/i.test(v.lang)) : [];
    const score = v => (/natural|neural|premium|enhanced|amélior|wavenet|online/i.test(v.name) ? 4 : 0)
      + (/fr[-_]FR/i.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0) + (/google/i.test(v.name) ? 1 : 0);
    return vs.sort((a, b) => score(b) - score(a));
  }
  function systemVoice(){
    const vs = systemVoices();
    return vs.find(v => v.name === R.voixSysteme) || vs[0] || null;
  }

  /* ---------- Voix naturelle : installation ---------- */
  async function installed(){
    try {
      const c = await caches.open(CACHE);
      for (const [f] of FILES) if (!(await c.match(new URL(f, document.baseURI).href))) return false;
      return true;
    } catch (e) { return false; }
  }
  async function install(onProgress){
    const c = await caches.open(CACHE);
    const total = FILES.reduce((a, f) => a + f[1], 0); let done = 0;
    for (const [f, size] of FILES){
      const url = new URL(f, document.baseURI).href;
      if (await c.match(url)){ done += size; onProgress && onProgress(done / total); continue; }
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("Téléchargement impossible (" + f + ")");
      const reader = r.body.getReader(), parts = []; let got = 0;
      for (;;){
        const { done: fin, value } = await reader.read();
        if (fin) break;
        parts.push(value); got += value.length;
        onProgress && onProgress(Math.min(1, (done + got) / total));
      }
      // on garde les en-têtes d'origine (dont ceux d'isolation, sans lesquels le moteur de voix ne démarre pas)
      const h = new Headers(r.headers);
      h.set("Cross-Origin-Embedder-Policy", "require-corp"); h.set("Cross-Origin-Resource-Policy", "same-origin");
      h.delete("Content-Length"); h.delete("Content-Encoding");
      await c.put(url, new Response(new Blob(parts), { headers: h }));
      done += size;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    onProgress && onProgress(1);
  }
  async function uninstall(){ try { await caches.delete(CACHE); } catch (e) {} stopWorker(); }

  /* ---------- Voix naturelle : calcul (dans un fil à part) ---------- */
  let worker = null, ready = null, nextId = 1;
  const pending = new Map(), memo = new Map();
  function getWorker(){
    if (!worker){
      worker = new Worker("voix-worker.js");
      worker.onmessage = e => {
        const m = e.data, p = pending.get(m.type === "ready" ? 0 : m.id);
        if (!p) return;
        pending.delete(m.type === "ready" ? 0 : m.id);
        m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m);
      };
      worker.onerror = e => {
        const msg = e.message || "le moteur de voix n'a pas pu démarrer";
        for (const p of pending.values()) p.reject(new Error(msg)); pending.clear();
      };
      ready = new Promise((resolve, reject) => { pending.set(0, { resolve, reject }); worker.postMessage({ type: "init", voice: VOICE }); });
      ready.catch(() => stopWorker());
    }
    return ready;
  }
  function stopWorker(){ if (worker) worker.terminate(); worker = null; ready = null; pending.clear(); memo.clear(); }
  function warm(){ if (R.moteur === "naturelle") getWorker().catch(() => {}); }

  function synthNatural(words, rate){
    const said = words.map(spoken).filter(Boolean);
    const key = rate + "|" + said.join(" ");
    if (!memo.has(key)){
      const p = getWorker().then(() => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "synth", id, phrases: [said], rate });
      })).then(m => ({ pcm: m.items[0].pcm, weights: m.items[0].weights, sr: m.sampleRate, said }));
      p.catch(() => memo.delete(key));
      memo.set(key, p);
      if (memo.size > 40) memo.delete(memo.keys().next().value);
    }
    return memo.get(key);
  }

  /* ---------- Lecture ---------- */
  let ctx = null, source = null, raf = 0, token = 0, lastError = "";
  function stop(){
    token++;
    if (source){ try { source.onended = null; source.stop(); } catch (e) {} source = null; }
    cancelAnimationFrame(raf);
    if (synth) synth.cancel();
  }
  // à appeler pendant un geste de l'utilisateur (toucher) : sinon le navigateur bloque le son
  function unlock(){
    if (R.moteur !== "naturelle") return;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  async function speakNatural(words, o, my){
    unlock();
    let waitT = setTimeout(() => o.onWait && o.onWait(true), 250);
    let a;
    try { a = await synthNatural(words, o.rate); }
    finally { clearTimeout(waitT); o.onWait && o.onWait(false); }
    if (my !== token) return;
    // on repère où commence et finit vraiment la parole (le modèle laisse un peu de silence autour)
    const pcm = a.pcm, thr = 0.015;
    let s0 = 0, s1 = pcm.length - 1;
    while (s0 < s1 && Math.abs(pcm[s0]) < thr) s0++;
    while (s1 > s0 && Math.abs(pcm[s1]) < thr) s1--;
    const pause = Math.round(a.sr * PAUSE / o.rate);
    const buf = ctx.createBuffer(1, pcm.length + pause, a.sr);
    buf.getChannelData(0).set(pcm);
    source = ctx.createBufferSource(); source.buffer = buf; source.connect(ctx.destination);
    // moment où commence chaque mot : réparti selon le nombre de phonèmes de chaque mot
    const idx = words.map((w, j) => j).filter(j => spoken(words[j]));   // mots réellement prononcés
    const tot = a.weights.reduce((x, y) => x + y, 0) || 1;
    const t0s = [], dur = (s1 - s0) / a.sr; let acc = 0;
    a.weights.forEach(w => { t0s.push(s0 / a.sr + dur * acc / tot); acc += w; });
    const start = ctx.currentTime + 0.05;
    let last = -1;
    const tick = () => {
      if (my !== token) return;
      const t = ctx.currentTime - start;
      let k = 0; while (k + 1 < t0s.length && t0s[k + 1] <= t) k++;
      const j = idx[Math.min(k, idx.length - 1)] ?? 0;
      if (j !== last){ last = j; o.onWord && o.onWord(j); }
      raf = requestAnimationFrame(tick);
    };
    source.onended = () => { if (my !== token) return; cancelAnimationFrame(raf); source = null; o.onEnd && o.onEnd(); };
    source.start(start);
    raf = requestAnimationFrame(tick);
  }

  function speakSystem(words, o, my){
    if (!synth){ o.onError && o.onError("Ce navigateur ne sait pas lire à voix haute."); return; }
    const said = words.map(spoken);
    let text = ""; const starts = said.map(w => { const s = text.length ? text.length + 1 : 0; text += (text ? " " : "") + w; return s; });
    setTimeout(() => {           // petit délai : Chrome Android ignore parfois speak() juste après cancel()
      if (my !== token) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-FR"; const v = systemVoice(); if (v) u.voice = v;
      u.rate = o.rate;
      u.onboundary = ev => {
        if (my !== token || ev.name === "sentence") return;
        let j = 0; starts.forEach((s, k) => { if (s <= ev.charIndex) j = k; });
        o.onWord && o.onWord(j);
      };
      u.onend = () => { if (my === token) setTimeout(() => { if (my === token) o.onEnd && o.onEnd(); }, PAUSE * 1000 / o.rate); };
      u.onerror = ev => {
        if (my !== token || ev.error === "interrupted" || ev.error === "canceled") return;
        o.onError && o.onError("La voix s'est arrêtée (" + ev.error + ").");
      };
      synth.speak(u);
    }, 80);
  }

  function speak(words, o){
    stop();
    const my = token;
    if (R.moteur === "naturelle"){
      speakNatural(words, o, my).catch(err => {
        if (my !== token) return;
        console.error(err);
        // secours : la voix du téléphone
        lastError = String(err && err.message || err);
        o.onError && o.onError("Voix naturelle indisponible (" + lastError + "). J'utilise la voix du téléphone.", true);
        speakSystem(words, o, my);
      });
    } else speakSystem(words, o, my);
  }
  function prefetch(words, rate){ if (R.moteur === "naturelle" && words.length) synthNatural(words, rate).catch(() => {}); }

  return {
    get settings(){ return R; },
    set(k, v){ R[k] = v; save(); if (k === "moteur") warm(); },
    speak, stop, prefetch, unlock, warm,
    systemVoices, systemVoice, installed, install, uninstall,
    downloadSize: FILES.reduce((a, f) => a + f[1], 0),
    get lastError(){ return lastError; }
  };
})();
