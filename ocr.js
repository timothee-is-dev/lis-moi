// Lis-moi : lecture de la photo, 100 % hors ligne.
//  1. OpenCV.js : on retrouve la feuille (4 coins), on la redresse et on efface les ombres.
//  2. PaddleOCR (PP-OCR) via ONNX Runtime Web :
//       - un réseau trouve les lignes de texte (détection),
//       - un petit réseau dit si une ligne est à l'envers (orientation),
//       - un réseau lit chaque ligne (reconnaissance, alphabet latin avec accents).
// Résultat : la page redressée + les lignes lues, avec la position de chaque mot.
"use strict";
const OCR = (() => {
  const BASE = new URL("vendor/", document.baseURI).href;
  const SRC_MAX = 3600;      // côté max de la photo traitée (px) : une photo de téléphone fait ~4000
  const PAGE_MAX = 3000;     // côté max de la page redressée (px)
  const MARGIN_MAX = 0.07;  // densité de contours tolérée dans la marge d'une feuille détectée
  const DET_MAX = 1280;      // côté max de l'image donnée au détecteur
  const REC_H = 48;          // hauteur des lignes pour la reconnaissance
  let cv = null, ort = null, S = null, DICT = null, loading = null;

  /* ---------- Chargement ---------- */
  function loadScript(src){
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error("Chargement impossible : " + src));
      document.head.appendChild(s);
    });
  }
  async function loadCv(){
    await loadScript(BASE + "opencv/opencv.js");
    let c = window.cv;
    if (c && !c.Mat && typeof c.then === "function"){
      c = await new Promise(r => c.then(m => { delete m.then; r(m); }));
    }
    if (!c.Mat) await new Promise(r => { c.onRuntimeInitialized = r; });
    return c;
  }
  async function fetchBytes(path){
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error("Fichier manquant : " + path);
    return new Uint8Array(await r.arrayBuffer());
  }
  function load(){
    if (!loading) loading = (async () => {
      const cvP = loadCv();
      await loadScript(BASE + "ort/ort.wasm.min.js");
      ort = window.ort;
      // fichiers du moteur ; en .js (et pas .mjs) pour que tous les hébergeurs le servent comme du JavaScript
      ort.env.wasm.wasmPaths = { mjs: BASE + "ort/ort-wasm-simd-threaded.js", wasm: BASE + "ort/ort-wasm-simd-threaded.wasm" };
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const [det, cls, rec, dictTxt] = await Promise.all([
        fetchBytes("models/det.onnx").then(b => ort.InferenceSession.create(b, opt)),
        fetchBytes("models/cls.onnx").then(b => ort.InferenceSession.create(b, opt)),
        fetchBytes("models/rec_latin.onnx").then(b => ort.InferenceSession.create(b, opt)),
        fetch(BASE + "models/latin_dict.txt").then(r => r.text())
      ]);
      S = { det, cls, rec };
      DICT = dictTxt.replace(/\r/g, "").split("\n");
      if (DICT[DICT.length - 1] === "") DICT.pop();
      DICT.push(" ");                  // la dernière classe du réseau = espace
      cv = await cvP;
    })().catch(e => { loading = null; throw e; });
    return loading;
  }

  /* ---------- Petits outils géométriques ---------- */
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // -> haut-gauche, haut-droit, bas-droit, bas-gauche. On trie par angle autour du centre :
  // l'ancienne méthode (somme/différence des coordonnées) pouvait prendre deux fois le même coin
  // sur une feuille très tournée, et la page redressée se remplissait de traînées.
  function orderCorners(p){
    const cx = p.reduce((a, q) => a + q[0], 0) / 4, cy = p.reduce((a, q) => a + q[1], 0) / 4;
    const o = [...p].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0; o.forEach((q, i) => { if (q[0] + q[1] < o[k][0] + o[k][1]) k = i; });
    return [0, 1, 2, 3].map(i => o[(k + i) % 4]);
  }
  function bboxOf(pts){
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  // ce qui dépasse de la photo (rotation, redressement) est rempli en blanc "papier" : surtout pas en
  // étirant les pixels du bord, qui transformait un mot coupé par le bord de la photo en longue traînée
  const PAPER = () => new cv.Scalar(255, 255, 255, 255);
  function warpQuad(src, quad, w, h, interp){
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(a, b), dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(w, h), interp, cv.BORDER_CONSTANT, PAPER());
    a.delete(); b.delete(); M.delete();
    return dst;
  }

  /* ---------- 1. Retrouver la feuille et la redresser ---------- */
  function quadFromContour(c, minArea){
    const hull = new cv.Mat(); cv.convexHull(c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    let found = null;
    for (const eps of [0.02, 0.03, 0.05, 0.08]){
      const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * peri, true);
      if (ap.rows === 4 && cv.contourArea(ap) >= minArea){
        const d = ap.data32S; found = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
      }
      const pts = ap.rows; ap.delete();
      if (found || pts < 4) break;
    }
    hull.delete();
    return found;
  }
  function findPage(src){
    const L = 500, s = L / Math.max(src.cols, src.rows);
    const small = new cv.Mat(), gray = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(src.cols * s), Math.round(src.rows * s)), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const area = gray.rows * gray.cols, k = cv.Mat.ones(3, 3, cv.CV_8U);
    const masks = [];
    const raw = new cv.Mat(); cv.Canny(gray, raw, 40, 120);
    const edges = raw.clone();
    cv.dilate(edges, edges, k, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    masks.push(edges);
    const bright = new cv.Mat(); cv.threshold(gray, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bright, bright, cv.MORPH_OPEN, k, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    masks.push(bright);
    let best = null, bestA = 0;
    for (const m of masks){
      const cs = new cv.MatVector(), hi = new cv.Mat();
      cv.findContours(m, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < cs.size(); i++){
        const c = cs.get(i);
        if (cv.contourArea(c) > area * 0.2){
          const q = quadFromContour(c, area * 0.2);
          if (q){
            const a = Math.abs(polyArea(q));
            if (a > bestA && a < area * 0.97 && blankMargin(raw, q)){ best = q; bestA = a; }
          }
        }
        c.delete();
      }
      cs.delete(); hi.delete(); m.delete();
    }
    small.delete(); gray.delete(); k.delete(); raw.delete();
    if (!best) return null;
    // on garde une petite marge autour (sans sortir de la photo) pour ne jamais couper une lettre
    const q = orderCorners(best), cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const W = src.cols, H = src.rows;
    return q.map(([x, y]) => [Math.min(W - 1, Math.max(0, (cx + (x - cx) * 1.03) / s)), Math.min(H - 1, Math.max(0, (cy + (y - cy) * 1.03) / s))]);
  }
  // Une vraie feuille a une marge blanche le long de ses bords. Si la bande juste à l'intérieur du contour
  // est pleine de contours (du texte), ce n'est pas la feuille mais le bloc de texte, une image, un cadre…
  function blankMargin(edges, q){
    const W = edges.cols, H = edges.rows, cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const shrink = f => cv.matFromArray(4, 1, cv.CV_32SC2, q.flatMap(([x, y]) => [Math.round(cx + (x - cx) * f), Math.round(cy + (y - cy) * f)]));
    const ring = cv.Mat.zeros(H, W, cv.CV_8U), a = shrink(0.97), b = shrink(0.91);
    const va = new cv.MatVector(), vb = new cv.MatVector(); va.push_back(a); vb.push_back(b);
    cv.fillPoly(ring, va, new cv.Scalar(255)); cv.fillPoly(ring, vb, new cv.Scalar(0));
    const r = ring.data, e = edges.data; let n = 0, on = 0;
    for (let i = 0; i < r.length; i++) if (r[i]){ n++; if (e[i]) on++; }
    ring.delete(); a.delete(); b.delete(); va.delete(); vb.delete();
    const dens = n ? on / n : 1;
    if (self.__lismoiMarges) self.__lismoiMarges.push(+dens.toFixed(4));
    return dens < MARGIN_MAX;
  }
  function polyArea(q){
    let a = 0;
    for (let i = 0; i < q.length; i++){ const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; }
    return a / 2;
  }
  // Ombres et éclairage inégal : on divise par une estimation du fond de la feuille.
  function flatten(src){
    const gray = new cv.Mat(), small = new cv.Mat(), bg = new cv.Mat(), bg4 = new cv.Mat(), out = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const f = 4;
    cv.resize(gray, small, new cv.Size(Math.max(8, Math.round(src.cols / f)), Math.max(8, Math.round(src.rows / f))), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.dilate(small, small, k, new cv.Point(-1, -1), 1, cv.BORDER_REPLICATE, cv.morphologyDefaultBorderValue());
    cv.medianBlur(small, small, 15);
    cv.resize(small, bg, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
    cv.cvtColor(bg, bg4, cv.COLOR_GRAY2RGBA);
    cv.divide(src, bg4, out, 255);
    gray.delete(); small.delete(); bg.delete(); bg4.delete(); k.delete();
    return out;
  }
  function preparePage(img, allowCrop = true){
    const s0 = Math.min(1, SRC_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s0); c.height = Math.round(img.naturalHeight * s0);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const src = cv.imread(c);
    const q = allowCrop ? findPage(src) : null;
    let page;
    if (q){
      let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
      const s = Math.min(1, PAGE_MAX / Math.max(w, h));
      w = Math.round(w * s); h = Math.round(h * s);
      page = warpQuad(src, q, w, h, cv.INTER_LINEAR);
    } else {
      const s = Math.min(1, PAGE_MAX / Math.max(src.cols, src.rows));
      page = new cv.Mat();
      cv.resize(src, page, new cv.Size(Math.round(src.cols * s), Math.round(src.rows * s)), 0, 0, cv.INTER_AREA);
    }
    src.delete();
    const flat = flatten(page); page.delete();
    return { mat: flat, cropped: !!q };
  }

  /* ---------- 2a. Détection des lignes ---------- */
  // Le réseau donne une carte "il y a du texte ici". Chaque tache = une ligne (ou un morceau de ligne).
  // On ne l'enferme pas dans un rectangle droit : on suit sa courbe (page de livre bombée),
  // ce qui permet ensuite de la "déplier" avant de la lire.
  const median = a => { if (!a.length) return 0; const t = [...a].sort((x, y) => x - y); return t[t.length >> 1]; };
  async function detect(page, maxSide = DET_MAX){
    const s = Math.min(1, maxSide / Math.max(page.cols, page.rows));
    const W = Math.max(32, Math.round(page.cols * s / 32) * 32), H = Math.max(32, Math.round(page.rows * s / 32) * 32);
    const r = new cv.Mat(); cv.resize(page, r, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const px = r.data, n = W * H, x = new Float32Array(3 * n);
    // PaddleOCR travaille en BGR, normalisé ImageNet
    for (let i = 0, j = 0; i < n; i++, j += 4){
      x[i]         = (px[j + 2] / 255 - 0.485) / 0.229;
      x[n + i]     = (px[j + 1] / 255 - 0.456) / 0.224;
      x[2 * n + i] = (px[j]     / 255 - 0.406) / 0.225;
    }
    r.delete();
    const out = await S.det.run({ [S.det.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, H, W]) });
    const prob = out[S.det.outputNames[0]].data;
    if (self.__lismoiDebug) self.__lismoiDebug.push({ W, H, prob: Array.from(prob, v => (v * 255) | 0) });
    const mask = new cv.Mat(H, W, cv.CV_8U), md = mask.data;
    for (let i = 0; i < n; i++) md[i] = prob[i] > 0.3 ? 255 : 0;
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const N = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
    const lab = labels.data32S.slice(), st = stats.data32S.slice();
    mask.delete(); labels.delete(); stats.delete(); cents.delete();

    // statistiques par tache : probabilité moyenne, axe principal, centre de chaque colonne
    const off = new Int32Array(N).fill(-1); let tot = 0;
    for (let l = 1; l < N; l++) if (st[l * 5 + 4] >= 10 && st[l * 5 + 2] >= 3){ off[l] = tot; tot += st[l * 5 + 2]; }
    const colN = new Float32Array(tot), colY = new Float32Array(tot);
    const sp = new Float64Array(N), sx = new Float64Array(N), sy = new Float64Array(N);
    const sxx = new Float64Array(N), syy = new Float64Array(N), sxy = new Float64Array(N);
    for (let y = 0, i = 0; y < H; y++) for (let xx = 0; xx < W; xx++, i++){
      const l = lab[i];
      if (l <= 0 || off[l] < 0) continue;
      sp[l] += prob[i]; sx[l] += xx; sy[l] += y; sxx[l] += xx * xx; syy[l] += y * y; sxy[l] += xx * y;
      const k = off[l] + xx - st[l * 5]; colN[k]++; colY[k] += y;
    }
    const kx = page.cols / W, ky = page.rows / H, lines = [];
    for (let l = 1; l < N; l++){
      if (off[l] < 0) continue;
      const cnt = st[l * 5 + 4];
      if (sp[l] / cnt < 0.6) continue;
      const mx = sx[l] / cnt, my = sy[l] / cnt;
      const cxx = sxx[l] / cnt - mx * mx, cyy = syy[l] / cnt - my * my, cxy = sxy[l] / cnt - mx * my;
      const tr = cxx + cyy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - (cxx * cyy - cxy * cxy)));
      const elong = Math.sqrt((tr / 2 + disc) / Math.max(1e-6, tr / 2 - disc));
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI;
      // centre de la ligne colonne par colonne, puis courbe lisse (droite ou parabole)
      const left = st[l * 5], w = st[l * 5 + 2], X = [], Y = [], Wt = [];
      for (let k = 0; k < w; k++){ const c = colN[off[l] + k]; if (c){ X.push(left + k + 0.5); Y.push(colY[off[l] + k] / c + 0.5); Wt.push(c); } }
      const hc = median(Wt);
      const xm = left + w / 2, half = Math.max(1, w / 2);
      const deg = w > 8 * hc ? 2 : w > 2 * hc ? 1 : 0;
      const coef = polyfit(X.map(v => (v - xm) / half), Y, Wt, deg);
      // on agrandit (le réseau ne voit que le "cœur" du texte), comme PaddleOCR
      const d = cnt * 1.6 / (2 * (w + hc));
      const h = (hc + 2 * d) * ky;
      if (h < 6) continue;
      const x0 = Math.max(0, (left - d) * kx), x1 = Math.min(page.cols, (left + w + d) * kx);
      const yAt = xp => { const t = (xp / kx - xm) / half; return (coef[0] + coef[1] * t + coef[2] * t * t) * ky; };
      lines.push(makeLine(x0, x1, h, yAt, { angle, elong, len: w * kx }));
    }
    lines.detSide = maxSide;
    return lines;
  }
  // garde la finesse de détection choisie pour cette page (utile après une rotation)
  function detSide(page, found){ return found.detSide || DET_MAX; }
  function makeLine(x0, x1, h, yAt, extra){
    const ys = []; for (let k = 0; k <= 8; k++) ys.push(yAt(x0 + (x1 - x0) * k / 8));
    const box = { x0, x1, y0: Math.min(...ys) - h / 2, y1: Math.max(...ys) + h / 2 };
    const quad = [[x0, yAt(x0) - h / 2], [x1, yAt(x1) - h / 2], [x1, yAt(x1) + h / 2], [x0, yAt(x0) + h / 2]];
    return { x0, x1, h, w: x1 - x0, yAt, box, quad, ...extra };
  }
  // moindres carrés pondérés, degré 0 à 2 -> [a, b, c]
  function polyfit(t, y, w, deg){
    const m = deg + 1, A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
    for (let i = 0; i < t.length; i++){
      const p = [1, t[i], t[i] * t[i]];
      for (let r = 0; r < m; r++){ for (let c = 0; c < m; c++) A[r][c] += w[i] * p[r] * p[c]; A[r][m] += w[i] * p[r] * y[i]; }
    }
    for (let c = 0; c < m; c++){            // pivot de Gauss
      let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-9) return [y.length ? y.reduce((a, b) => a + b, 0) / y.length : 0, 0, 0];
      for (let r = 0; r < m; r++) if (r !== c){ const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
    }
    const res = [0, 0, 0]; for (let c = 0; c < m; c++) res[c] = A[c][m] / A[c][c];
    return res;
  }
  // angle dominant des lignes (moyenne sur l'angle doublé : -89° et +89° sont la même direction)
  function dominantAngle(lines){
    let c = 0, s = 0, n = 0;
    for (const l of lines) if (l.elong > 4){ const a = 2 * l.angle * Math.PI / 180; c += l.len * Math.cos(a); s += l.len * Math.sin(a); n++; }
    return n >= 3 ? 0.5 * Math.atan2(s, c) * 180 / Math.PI : null;
  }

  /* ---------- 2b. Découpe d'une ligne (dépliée) + mise en tenseur ---------- */
  function cropLine(page, ln){
    const w = Math.max(4, Math.round(ln.x1 - ln.x0)), h = Math.max(4, Math.round(ln.h));
    const mx = new cv.Mat(h, w, cv.CV_32F), my = new cv.Mat(h, w, cv.CV_32F);
    const X = mx.data32F, Y = my.data32F;
    for (let u = 0; u < w; u++){
      const xc = ln.x0 + u + 0.5, yc = ln.yAt(xc), sl = ln.yAt(xc + 1) - yc, nn = Math.hypot(1, sl);
      for (let v = 0; v < h; v++){
        const o = v - h / 2 + 0.5, k = v * w + u;
        X[k] = xc - o * sl / nn; Y[k] = yc + o / nn;      // on échantillonne perpendiculairement à la ligne
      }
    }
    const dst = new cv.Mat();
    cv.remap(page, dst, mx, my, cv.INTER_LINEAR, cv.BORDER_CONSTANT, PAPER());
    mx.delete(); my.delete();
    return dst;
  }
  // remplit le tenseur [3, REC_H, Wt] à partir d'une ligne redimensionnée à la largeur rw
  function fillTensor(crop, rw, hT, x, off, Wt){
    const r = new cv.Mat(); cv.resize(crop, r, new cv.Size(rw, hT), 0, 0, cv.INTER_LINEAR);
    const px = r.data, plane = hT * Wt;
    for (let y = 0; y < hT; y++) for (let xx = 0; xx < rw; xx++){
      const j = (y * rw + xx) * 4, i = off + y * Wt + xx;
      x[i]             = (px[j + 2] / 255 - 0.5) / 0.5;
      x[i + plane]     = (px[j + 1] / 255 - 0.5) / 0.5;
      x[i + 2 * plane] = (px[j]     / 255 - 0.5) / 0.5;
    }
    r.delete();
  }

  /* ---------- 2c. Ligne à l'envers ? ---------- */
  async function upsideDownVotes(crops){
    const pick = crops.map((c, i) => i).sort((a, b) => crops[b].cols - crops[a].cols).slice(0, 16);
    if (!pick.length) return 0;
    const hT = 48, Wt = 192, plane = 3 * hT * Wt, x = new Float32Array(pick.length * plane);
    pick.forEach((ci, k) => {
      const c = crops[ci], rw = Math.min(Wt, Math.max(1, Math.ceil(hT * c.cols / c.rows)));
      fillTensor(c, rw, hT, x, k * plane, Wt);
    });
    const out = await S.cls.run({ [S.cls.inputNames[0]]: new ort.Tensor("float32", x, [pick.length, 3, hT, Wt]) });
    const p = out[S.cls.outputNames[0]].data;
    let up = 0, down = 0;
    for (let k = 0; k < pick.length; k++){ if (p[2 * k + 1] > 0.9) down++; else up++; }
    return down / (up + down);
  }

  /* ---------- 2d. Lecture des lignes ---------- */
  async function recognize(crops, onProgress){
    const order = crops.map((c, i) => i).sort((a, b) => crops[a].cols / crops[a].rows - crops[b].cols / crops[b].rows);
    const res = new Array(crops.length), BATCH = 8;
    for (let s = 0; s < order.length; s += BATCH){
      const ids = order.slice(s, s + BATCH);
      const rws = ids.map(i => Math.max(8, Math.min(REC_H * 60, Math.ceil(REC_H * crops[i].cols / crops[i].rows))));
      const Wt = Math.max(...rws, REC_H * 4), plane = 3 * REC_H * Wt;
      const x = new Float32Array(ids.length * plane);
      ids.forEach((ci, k) => fillTensor(crops[ci], rws[k], REC_H, x, k * plane, Wt));
      const out = await S.rec.run({ [S.rec.inputNames[0]]: new ort.Tensor("float32", x, [ids.length, 3, REC_H, Wt]) });
      const t = out[S.rec.outputNames[0]], [, T, C] = t.dims, d = t.data;
      ids.forEach((ci, k) => { res[ci] = ctcDecode(d, k * T * C, T, C, Wt / T / rws[k]); });
      onProgress && onProgress(Math.min(1, (s + BATCH) / order.length));
    }
    return res;
  }
  // CTC : on garde, pour chaque caractère, l'instant (donc la position) où il est vu
  function ctcDecode(d, off, T, C, step){
    const chars = []; let prev = 0;
    for (let t = 0; t < T; t++){
      let best = 0, bp = -1;
      for (let c = 0, o = off + t * C; c < C; c++) if (d[o + c] > bp){ bp = d[o + c]; best = c; }
      if (best !== 0 && best !== prev){
        const ch = DICT[best - 1];
        if (ch !== undefined) chars.push({ ch, t, p: bp });
      } else if (best !== 0 && chars.length){ chars[chars.length - 1].t1 = t; }
      prev = best;
    }
    const text = chars.map(c => c.ch).join("");
    const score = chars.length ? chars.reduce((a, c) => a + c.p, 0) / chars.length : 0;
    // découpe en mots, position en fraction de la largeur de la ligne
    const words = []; let cur = null;
    for (const c of chars){
      if (c.ch === " "){ cur = null; continue; }
      if (!cur){ cur = { text: "", f0: (c.t - 1.4) * step }; words.push(cur); }
      cur.text += c.ch; cur.f1 = ((c.t1 ?? c.t) + 1.1) * step;
    }
    for (let i = 0; i < words.length; i++){
      const w = words[i];
      w.f0 = Math.max(0, Math.min(1, w.f0)); w.f1 = Math.max(w.f0, Math.min(1, w.f1));
      if (i && w.f0 < words[i - 1].f1) words[i - 1].f1 = w.f0 = (w.f0 + words[i - 1].f1) / 2;
    }
    return { text: text.replace(/\s+/g, " ").trim(), score, words };
  }

  /* ---------- Enchaînement ---------- */
  function rotate(mat, code){ const r = new cv.Mat(); cv.rotate(mat, r, code); mat.delete(); return r; }
  function rotateBy(mat, deg){
    const a = Math.abs(deg * Math.PI / 180), w = mat.cols, h = mat.rows;
    const nw = Math.round(w * Math.cos(a) + h * Math.sin(a)), nh = Math.round(w * Math.sin(a) + h * Math.cos(a));
    const M = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), deg, 1);
    M.data64F[2] += (nw - w) / 2; M.data64F[5] += (nh - h) / 2;
    const r = new cv.Mat();
    cv.warpAffine(mat, r, M, new cv.Size(nw, nh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, PAPER());
    M.delete(); mat.delete();
    return r;
  }

  async function read(img, onStep){
    const step = (msg, p) => onStep && onStep(msg, p);
    step("Chargement du lecteur…", 0.05);
    await load();
    step("Je redresse la feuille…", 0.2);
    await new Promise(r => setTimeout(r, 0));
    let { mat: page, cropped } = preparePage(img);
    try {
      step("Je cherche les lignes…", 0.3);
      let found = await detect(page);
      // Le recadrage coupe des lignes (elles touchent le bord gauche ou droit) : la feuille trouvée
      // n'était pas la bonne -> on reprend la photo entière.
      if (cropped){
        const m = 0.006 * page.cols;
        const cut = found.filter(l => l.elong > 4 && (l.box.x0 <= m || l.box.x1 >= page.cols - m)).length;
        if (cut >= 2 && cut >= 0.1 * found.length){
          page.delete(); ({ mat: page, cropped } = preparePage(img, false));
          found = await detect(page);
        }
      }
      // Petit texte (page vue de loin, photo d'écran) : on regarde avec plus de détails
      const hDet = median(found.filter(l => l.elong > 4).map(l => l.h)) * Math.min(1, DET_MAX / Math.max(page.cols, page.rows));
      if (found.length && hDet > 0 && hDet < 16 && Math.max(page.cols, page.rows) > DET_MAX){
        found = await detect(page, Math.min(2400, Math.round(DET_MAX * 22 / hDet / 32) * 32));
      }
      // Photo prise en travers (lignes verticales) : on tourne d'un quart
      let a = dominantAngle(found);
      if (a !== null && Math.abs(a) > 45){
        page = rotate(page, a > 0 ? cv.ROTATE_90_COUNTERCLOCKWISE : cv.ROTATE_90_CLOCKWISE);
        found = await detect(page, detSide(page, found)); a = dominantAngle(found);
      }
      // Feuille penchée (et pas de bord de feuille pour la redresser) : on remet les lignes à l'horizontale
      if (a !== null && Math.abs(a) > 1.5){
        const side = detSide(page, found);
        page = rotateBy(page, a);
        found = await detect(page, side);
      }
      let crops = found.map(l => cropLine(page, l));
      // Page à l'envers ?
      if (crops.length && await upsideDownVotes(crops) > 0.6){
        crops.forEach(c => c.delete());
        const side = detSide(page, found);
        page = rotate(page, cv.ROTATE_180);
        found = await detect(page, side);
        crops = found.map(l => cropLine(page, l));
      }
      step("Je lis le texte…", 0.45);
      const rec = await recognize(crops, p => step("Je lis le texte…", 0.45 + 0.5 * p));
      crops.forEach(c => c.delete());
      const lines = [], ecartees = [];   // ecartees : pour le banc de test
      found.forEach((ln, i) => {
        const r = rec[i];
        ecartees.push({ text: r && r.text, score: r && +r.score.toFixed(2), w: Math.round(ln.w), h: Math.round(ln.h) });
        if (!r || !r.text || r.score < 0.5 || !/[\p{L}\p{N}]/u.test(r.text)) return;
        // petit bout de texte collé au bord de la photo : morceau de la page voisine, coupé
        const bb = ln.box, m = 0.012 * Math.max(page.cols, page.rows);
        const atEdge = bb.x0 < m || bb.y0 < m || bb.x1 > page.cols - m || bb.y1 > page.rows - m;
        if (atEdge && r.text.length < 15) return;
        const words = r.words.map(w => {
          const xa = ln.x0 + w.f0 * ln.w, xb = ln.x0 + w.f1 * ln.w;
          const ys = [ln.yAt(xa), ln.yAt((xa + xb) / 2), ln.yAt(xb)];
          return { text: w.text, box: { x0: xa, x1: xb, y0: Math.min(...ys) - ln.h / 2, y1: Math.max(...ys) + ln.h / 2 } };
        });
        // point d'ancrage près du début de la ligne : c'est là que les lignes d'un paragraphe se comparent
        const ax = Math.min(ln.x1, ln.x0 + 2 * ln.h);
        if (words.length) lines.push({ text: r.text, score: r.score, quad: ln.quad, box: ln.box, h: ln.h, anchor: [ax, ln.yAt(ax)], words });
      });
      const canvas = document.createElement("canvas");
      cv.imshow(canvas, page);
      return { canvas, width: page.cols, height: page.rows, lines, cropped, debug: ecartees };
    } finally {
      page.delete();
    }
  }

  return { load, read };
})();
