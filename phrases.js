// Lis-moi : des lignes lues sur la photo aux phrases à dire.
//  1. Ordre de lecture (découpe récursive de la page selon les espaces blancs : colonnes, tableaux, cadres).
//  2. Regroupement des lignes en blocs (paragraphe, titre, élément de liste). Un titre reste toujours seul.
//  3. Dans un bloc : on recolle les lignes (et les mots coupés « ver- / bes »),
//     puis on coupe en phrases avec Intl.Segmenter("fr"). Jamais de phrase à cheval sur deux blocs.
"use strict";
const Phrases = (() => {
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  /* ---------- 0. Repère des lignes ---------- */
  // Sur une photo, les lignes ne sont jamais parfaitement horizontales (feuille un peu tournée, page de
  // livre bombée) : leurs boîtes droites se chevauchent et l'ordre devient faux. On fait donc toute la mise
  // en page dans le repère des lignes (angle médian) avec la hauteur réelle de chaque ligne.
  function layoutFrame(lines){
    const ang = lines.filter(l => Math.hypot(l.quad[1][0] - l.quad[0][0], l.quad[1][1] - l.quad[0][1]) > 3 * l.h)
      .map(l => Math.atan2(l.quad[1][1] - l.quad[0][1], l.quad[1][0] - l.quad[0][0]));
    const a = median(ang) || 0, c = Math.cos(a), s = Math.sin(a);
    return lines.map(l => {
      const q = l.quad.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
      const xs = q.map(p => p[0]);
      const cy = l.anchor ? -l.anchor[0] * s + l.anchor[1] * c : q.reduce((t, p) => t + p[1], 0) / 4;
      return { ...l, box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: cy - l.h / 2, y1: cy + l.h / 2, cy } };
    });
  }

  /* ---------- 1. Ordre de lecture ---------- */
  // trous dans la projection des boîtes sur un axe
  function gaps(items, lo, hi){
    const iv = items.map(it => [lo(it), hi(it)]).sort((a, b) => a[0] - b[0]);
    const out = []; let end = iv[0][1];
    for (const [a, b] of iv.slice(1)){
      if (a > end) out.push({ at: (a + end) / 2, size: a - end });
      end = Math.max(end, b);
    }
    return out;
  }
  // part des lignes qui continuent la précédente (minuscule au début, ou tiret / virgule à la fin d'avant)
  function flow(items){
    const t = [...items].sort((a, b) => a.box.cy - b.box.cy);
    let n = 0;
    for (let i = 1; i < t.length; i++){
      const prev = t[i - 1].text || "", next = t[i].text || "";
      if (/^[\p{Ll}]/u.test(next) || /[-,]$/.test(prev)) n++;
    }
    return t.length > 1 ? n / (t.length - 1) : 0;
  }
  function xyCut(items, H, out){
    if (items.length <= 1){ if (items.length) out.push(items); return; }
    // verticalement, on ne regarde que le cœur de chaque ligne (centre ± 1/4 de hauteur)
    const gy = gaps(items, it => it.box.cy - it.h * 0.25, it => it.box.cy + it.h * 0.25);
    const gx = gaps(items, it => it.box.x0, it => it.box.x1);
    const by = gy.reduce((m, g) => g.size > m.size ? g : m, { size: 0 });
    const bx = gx.reduce((m, g) => g.size > m.size ? g : m, { size: 0 });
    let cut = null;
    if (bx.size >= 1.5 * H){
      // deux colonnes de texte dont les lignes tombent à la même hauteur : on lit colonne par colonne
      const L = items.filter(it => it.box.x1 <= bx.at), R = items.filter(it => it.box.x0 >= bx.at);
      // … mais un tableau ou un formulaire (« Prénom | Léa ») se lit ligne par ligne : on ne coupe en
      // colonnes que si le texte coule d'une ligne à l'autre dans les deux colonnes
      if (L.length >= 3 && R.length >= 3 && by.size < 1.2 * H && Math.min(flow(L), flow(R)) >= 0.4) cut = ["x", bx.at];
    }
    if (!cut && by.size > 0) cut = ["y", by.at];
    if (!cut && bx.size >= 0.8 * H) cut = ["x", bx.at];
    if (!cut){
      // plus rien à couper : de haut en bas, puis de gauche à droite dans une même ligne
      const rows = [];
      for (const it of [...items].sort((a, b) => a.box.cy - b.box.cy)){
        const r = rows[rows.length - 1];
        if (r && it.box.cy - r.cy < 0.5 * Math.min(r.h, it.h)) r.items.push(it);
        else rows.push({ cy: it.box.cy, h: it.h, items: [it] });
      }
      for (const r of rows) out.push(r.items.sort((a, b) => a.box.x0 - b.box.x0));
      return;
    }
    const [axis, at] = cut;
    const c = it => axis === "y" ? it.box.cy : (it.box.x0 + it.box.x1) / 2;
    xyCut(items.filter(it => c(it) < at), H, out);
    xyCut(items.filter(it => c(it) >= at), H, out);
  }

  /* ---------- 2. Blocs ---------- */
  const LIST_MARK = /^([-–—•●▪■□☐❑➢➤►▶*]|\(?\d{1,2}[.)°]|\(?[a-hA-H][).]|[①-⑳❶-❿➀-➓]|[IVX]{1,4}[.)])$/u;
  const ENDS_PUNCT = /[.!?…:;,]["»)\]]*$/;
  function makeRows(lines){
    const H = median(lines.map(l => l.h)) || 20;
    const groups = []; xyCut(layoutFrame(lines), H, groups);
    // une "rangée" = des morceaux d'une même ligne (le détecteur coupe parfois aux grands espaces)
    return groups.map(g => {
      const words = g.flatMap(l => l.words.map(w => ({ text: tidy(w.text), boxes: [w.box] })));
      const box = { x0: Math.min(...g.map(l => l.box.x0)), y0: Math.min(...g.map(l => l.box.y0)),
                    x1: Math.max(...g.map(l => l.box.x1)), y1: Math.max(...g.map(l => l.box.y1)) };
      return { words, box, h: median(g.map(l => l.h)) };
    });
  }
  function sameBlock(blk, prev, next){
    const hAvg = (prev.h + next.h) / 2;
    const gap = next.box.y0 - prev.box.y1;
    if (gap > 0.9 * hAvg || gap < -0.6 * hAvg) return false;              // espace entre paragraphes
    if (Math.max(prev.h, next.h) / Math.min(prev.h, next.h) > 1.3) return false;  // taille différente : titre
    if (next.box.x0 > prev.box.x1 || next.box.x1 < prev.box.x0) return false;   // pas dans la même colonne
    if (Math.abs(next.box.x0 - blk.x0) > 2.5 * hAvg && next.box.x0 > blk.x0) {
      // ligne nettement en retrait : nouveau paragraphe, sauf si la précédente ne finit pas la phrase
      if (ENDS_PUNCT.test(lastText(prev))) return false;
    }
    const first = next.words[0].text;
    if (LIST_MARK.test(first) || /^[•●▪■□☐➢➤►▶]/u.test(first)) return false;    // élément de liste
    // ligne courte sans ponctuation finale suivie d'une majuscule : c'était un titre
    const right = Math.max(blk.x1, next.box.x1);
    const short = prev.box.x1 < right - 4 * hAvg;
    if (short && !ENDS_PUNCT.test(lastText(prev)) && !/-$/.test(lastText(prev)) && /^[\p{Lu}\d«"]/u.test(first)) return false;
    return true;
  }
  // petites retouches de lecture : « M.Dupont » -> « M. Dupont », « ... » -> « … »
  const tidy = t => t.replace(/^(M|MM|Mme|Mlle|Dr|Pr|Me|St|Ste)\.(?=\p{Lu})/u, "$1. ").replace(/\.{3,}/g, "…");
  const lastText = row => row.words[row.words.length - 1].text;

  function makeBlocks(rows){
    const blocks = [];
    let cur = null;
    for (const r of rows){
      if (cur && sameBlock(cur, cur.rows[cur.rows.length - 1], r)){
        cur.rows.push(r); cur.x0 = Math.min(cur.x0, r.box.x0); cur.x1 = Math.max(cur.x1, r.box.x1);
      } else {
        cur = { rows: [r], x0: r.box.x0, x1: r.box.x1 }; blocks.push(cur);
      }
    }
    return blocks.map(b => joinRows(b.rows));
  }
  // recolle les lignes d'un bloc ; « ver- » + « bes » -> « verbes »
  function joinRows(rows){
    const out = [];
    for (const r of rows){
      r.words.forEach((w, k) => {
        const p = out[out.length - 1];
        if (k === 0 && p && /\p{L}[-‐‑]$/u.test(p.text) && /^\p{Ll}/u.test(w.text)){
          p.text = p.text.slice(0, -1) + w.text; p.boxes = p.boxes.concat(w.boxes);
        } else out.push({ text: w.text, boxes: w.boxes.slice() });
      });
    }
    return out;
  }

  /* ---------- 3. Phrases ---------- */
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("fr", { granularity: "sentence" }) : null;
  const ABBR = /(?:^|[\s(«"'’])(?:M|MM|Mme|Mmes|Mlle|Mlles|Dr|Drs|Pr|Me|Mgr|St|Ste|Sts|ex|cf|p|pp|fig|vol|chap|art|env|av|apr|réf|tél|n°|no|nº|J\.-C|av\. J\.-C|c\.-à-d|cad|i\.e|e\.g|vs|etc|[A-Z])\.\s*$/u;
  function sentencesOf(text){
    let parts;
    if (seg) parts = [...seg.segment(text)].map(s => ({ start: s.index, text: s.segment }));
    else {
      parts = []; const re = /[^.!?…]+(?:[.!?…]+["»)\]]*\s*|$)/g; let m;
      while ((m = re.exec(text)) && m[0]) parts.push({ start: m.index, text: m[0] });
    }
    // « … » suivi d'une majuscule termine aussi une phrase (le segmenteur ne le sait pas)
    parts = parts.flatMap(p => {
      const out = []; let from = 0; const re = /…["»)\]]*\s+(?=[\p{Lu}«"])/gu; let m;
      while ((m = re.exec(p.text))){
        const end = m.index + m[0].length;
        out.push({ start: p.start + from, text: p.text.slice(from, end) }); from = end;
      }
      out.push({ start: p.start + from, text: p.text.slice(from) });
      return out.filter(o => o.text);
    });
    // on recolle : après une abréviation (« M. Dupont », « ex. pour »), après un numéro seul (« 1. Qui… »),
    // ou si la suite commence en minuscule
    const merged = [];
    for (const p of parts){
      const q = merged[merged.length - 1];
      const nextStartsLower = /^\s*[\p{Ll}\d,;:)]/u.test(p.text);
      const onlyMarker = q && /^\s*\(?(\d{1,3}|[a-zA-Z]|[IVX]{1,4})[.)°]\s*$/.test(q.text);
      if (q && (nextStartsLower || onlyMarker || (ABBR.test(q.text) && !/\betc\.\s*$/.test(q.text)))) q.text += p.text;
      else merged.push({ ...p });
    }
    return merged;
  }

  function build(lines){
    const words = [], segs = [];
    if (!lines.length) return { words, segs };
    const blocks = makeBlocks(makeRows(lines));
    for (const bw of blocks){
      // texte du bloc + position de chaque mot
      let text = "";
      const starts = bw.map(w => { const s = text.length ? text.length + 1 : 0; text += (text ? " " : "") + w.text; return s; });
      const sents = sentencesOf(text);
      let wi = 0;
      for (let si = 0; si < sents.length; si++){
        const end = si + 1 < sents.length ? sents[si + 1].start : Infinity;
        const group = [];
        while (wi < bw.length && starts[wi] < end) group.push(bw[wi++]);
        // phrase très longue sans ponctuation : on coupe (de préférence après une virgule)
        while (group.length){
          let n = group.length;
          if (n > 80){
            n = 80;
            for (let k = 79; k >= 30; k--) if (/[,;:]$/.test(group[k - 1].text)){ n = k; break; }
          }
          pushSeg(group.splice(0, n));
        }
      }
    }
    function pushSeg(ws){
      const s = { text: "", wordIdx: [] };
      for (const w of ws){
        const idx = words.length;
        words.push({ text: w.text, boxes: w.boxes, seg: segs.length, charStart: s.text.length ? s.text.length + 1 : 0 });
        s.text += (s.text ? " " : "") + w.text;
        s.wordIdx.push(idx);
      }
      segs.push(s);
    }
    return { words, segs };
  }

  return { build, sentencesOf };
})();
