// Lis-moi : voix naturelle (Piper, réseau de neurones VITS), calculée dans un fil à part, hors ligne.
//   texte -> phonèmes (espeak-ng compilé en WebAssembly) -> audio (modèle ONNX de la voix)
// Messages reçus : {type:"init", voice}  puis  {type:"synth", id, phrases:[[mot, mot, …], …], rate}
// Messages envoyés : {type:"ready"} / {type:"audio", id, items:[{pcm, weights}], sampleRate} / {type:"error", id, message}
"use strict";
const BASE = new URL("./vendor/", self.location.href).href;
importScripts(BASE + "ort/ort.wasm.min.js", BASE + "piper/piper_phonemize.js");
ort.env.wasm.wasmPaths = { mjs: BASE + "ort/ort-wasm-simd-threaded.js", wasm: BASE + "ort/ort-wasm-simd-threaded.wasm" };
// plusieurs cœurs si la page est "isolée" (en-têtes COOP/COEP, voir _headers) : synthèse 2 à 3 fois plus rapide
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const CACHE = "lis-moi-voix";
let session = null, config = null;

async function getBytes(url){
  // d'abord le cache de la voix (téléchargée une fois), sinon le réseau
  try {
    const c = await caches.open(CACHE), hit = await c.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch (e) {}
  const r = await fetch(url);
  if (!r.ok) throw new Error("Voix introuvable : " + url);
  return new Uint8Array(await r.arrayBuffer());
}

// Texte -> identifiants de phonèmes, pour plusieurs phrases d'un coup
function phonemize(texts){
  return new Promise((resolve, reject) => {
    const out = [];
    createPiperPhonemize({
      print: line => {
        try { out.push(JSON.parse(line).phoneme_ids); } catch (e) { return; }
        if (out.length === texts.length) resolve(out);
      },
      printErr: () => {},
      locateFile: f => BASE + "piper/" + (f.endsWith(".wasm") ? "piper_phonemize.wasm" : "piper_phonemize.data")
    }).then(mod => {
      for (const t of texts){
        mod.callMain(["-l", config.espeak.voice, "--input", JSON.stringify([{ text: t }]), "--espeak_data", "/espeak-ng-data"]);
      }
    }).catch(reject);
  });
}

// Poids de chaque mot dans la durée de la phrase = son nombre de phonèmes (+ une pause après la ponctuation).
// Sert à surligner le mot prononcé au bon moment.
function weightOf(ids, word){
  const skip = new Set([config.phoneme_id_map["_"][0], config.phoneme_id_map["^"][0], config.phoneme_id_map["$"][0]]);
  let n = 0; for (const id of ids) if (!skip.has(id)) n++;
  if (/[.!?…]["»)]*$/.test(word)) n += 6; else if (/[,;:]["»)]*$/.test(word)) n += 4;
  return Math.max(1, n);
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === "init"){
      if (!session){
        const v = BASE + "voix/" + m.voice;
        config = JSON.parse(new TextDecoder().decode(await getBytes(v + ".onnx.json")));
        session = await ort.InferenceSession.create(await getBytes(v + ".onnx"), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      }
      postMessage({ type: "ready", sampleRate: config.audio.sample_rate });
      return;
    }
    if (m.type === "synth"){
      const texts = m.phrases.map(ws => ws.join(" "));
      const words = m.phrases.flat();
      const all = await phonemize(texts.concat(words));          // les phrases, puis chaque mot seul
      const wordIds = all.slice(texts.length);
      const inf = config.inference, items = [];
      let w0 = 0;
      for (let k = 0; k < texts.length; k++){
        const ids = all[k], n = m.phrases[k].length;
        const weights = m.phrases[k].map((wd, j) => weightOf(wordIds[w0 + j], wd)); w0 += n;
        const feeds = {
          input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
          input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
          // bruit un peu réduit = articulation plus nette ; longueur = vitesse (plus grand = plus lent)
          scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale * 0.8, 1 / m.rate, inf.noise_w * 0.8]), [3])
        };
        if (config.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
        const out = await session.run(feeds);
        const pcm = new Float32Array(out[session.outputNames[0]].data);
        items.push({ pcm, weights });
      }
      postMessage({ type: "audio", id: m.id, items, sampleRate: config.audio.sample_rate }, items.map(i => i.pcm.buffer));
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
