# Lis-moi — banc de test : fait lire toutes les pages de tests/pages/ par la vraie appli,
# dans un navigateur sans fenêtre (Edge ou Chrome), et compare au texte attendu.
#
#   python tests/lancer.py              toutes les pages
#   python tests/lancer.py livre conte  seulement les pages dont le nom contient « livre » ou « conte »
#
# Résultats : tableau dans le terminal + tests/resultats/rapport.html (images annotées, phrases comparées).
# Dépendance : pip install websocket-client
import os, sys, json, time, base64, shutil, socket, subprocess, tempfile, unicodedata, difflib, html, urllib.request
import functools, http.server, threading, re

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(ICI)
PAGES = os.path.join(ICI, "pages")
RES = os.path.join(ICI, "resultats")
NAVIGATEURS = [
    r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    r"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    r"C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
SIM_PHRASE = 0.85   # deux phrases "correspondent" si elles se ressemblent à 85 % ou plus

# ---------- Comparaison ----------
def norm(s):
    s = unicodedata.normalize("NFC", s)
    for a, b in [("’", "'"), ("‘", "'"), ("...", "…"), ("\u00a0", " "), ("\u202f", " ")]:
        s = s.replace(a, b)
    s = " ".join(s.split())
    # la typographie varie (espace fine ou pas avant « ! ? : ; », petites capitales) : on n'en tient pas compte
    s = re.sub(r"\s+([!?:;»])", r"\1", s); s = re.sub(r"([«])\s+", r"\1", s)
    return s.lower()

def lev(a, b):
    if len(a) < len(b): a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

def sim(a, b):
    m = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return m.ratio() if m.real_quick_ratio() >= SIM_PHRASE else 0.0

def aligner(att, obt):
    """Alignement des phrases (dans l'ordre) : plus longue suite de paires qui se ressemblent."""
    n, m = len(att), len(obt)
    S = [[sim(a, b) for b in obt] for a in att]
    D = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            D[i][j] = max(D[i + 1][j], D[i][j + 1], D[i + 1][j + 1] + 1 if S[i][j] >= SIM_PHRASE else 0)
    paires, i, j = [], 0, 0
    while i < n or j < m:
        if i < n and j < m and S[i][j] >= SIM_PHRASE and D[i][j] == D[i + 1][j + 1] + 1:
            paires.append((i, j, S[i][j])); i += 1; j += 1
        elif j < m and (i == n or D[i][j + 1] >= D[i + 1][j]):
            paires.append((None, j, 0)); j += 1
        else:
            paires.append((i, None, 0)); i += 1
    return paires

# ---------- Navigateur ----------
def port_libre():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

class Silencieux(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript",
                      ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream"}
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # comme sur Netlify (_headers) : page isolée -> calcul sur plusieurs cœurs
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

class Navigateur:
    def __init__(self):
        import websocket
        exe = next((p for p in NAVIGATEURS if os.path.exists(p)), None)
        if not exe: sys.exit("Aucun navigateur Edge/Chrome trouvé (voir NAVIGATEURS dans lancer.py).")
        self.port = port_libre()
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), functools.partial(Silencieux, directory=RACINE))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.profil = tempfile.mkdtemp(prefix="lismoi-test-")
        dbg = port_libre()
        self.proc = subprocess.Popen([exe, "--headless=new", f"--remote-debugging-port={dbg}", "--user-data-dir=" + self.profil,
                                      "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try: tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json")); break
            except Exception: time.sleep(0.2)
        tab = next(t for t in tabs if t["type"] == "page")
        self.ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=600)
        self.n = 0; self.erreurs = []
        self.appel("Runtime.enable")
        # pas de service worker pendant les tests : on veut toujours le code tel qu'il est sur le disque
        self.appel("Page.addScriptToEvaluateOnNewDocument", {"source":
            "try{delete Navigator.prototype.serviceWorker}catch(e){}"})
        self.appel("Page.navigate", {"url": f"http://localhost:{self.port}/index.html"})
        self.evaluer("(async()=>{for(let i=0;i<200&&typeof Phrases==='undefined';i++)await new Promise(r=>setTimeout(r,50));"
                     "await OCR.load();return 1})()")

    def appel(self, methode, params=None):
        self.n += 1; self.ws.send(json.dumps({"id": self.n, "method": methode, "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("method") == "Runtime.exceptionThrown":
                self.erreurs.append(r["params"]["exceptionDetails"].get("exception", {}).get("description", "?"))
            if r.get("id") == self.n: return r

    def evaluer(self, js):
        r = self.appel("Runtime.evaluate", {"expression": js, "awaitPromise": True, "returnByValue": True})["result"]
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", str(r["exceptionDetails"])))
        return r["result"].get("value")

    def fermer(self):
        try: self.ws.close()
        except Exception: pass
        self.proc.kill(); self.srv.shutdown()
        time.sleep(0.5); shutil.rmtree(self.profil, ignore_errors=True)

# Lit une page dans l'appli et renvoie phrases + image annotée (une couleur par phrase)
JS_LIRE = r"""(async (url) => {
  const t0 = performance.now();
  const blob = await (await fetch(url)).blob();
  const img = await loadImage(blob);
  const page = await OCR.read(img, () => {});
  const ms = Math.round(performance.now() - t0);
  const r = Phrases.build(page.lines);
  const s = Math.min(1, 1100 / page.width), c = document.createElement("canvas");
  c.width = Math.round(page.width * s); c.height = Math.round(page.height * s);
  const g = c.getContext("2d"); g.drawImage(page.canvas, 0, 0, c.width, c.height); g.scale(s, s);
  r.segs.forEach((sg, k) => {
    const hue = (k * 67) % 360;
    g.fillStyle = `hsla(${hue},90%,55%,.33)`; g.strokeStyle = `hsla(${hue},90%,35%,.9)`;
    sg.wordIdx.forEach(i => r.words[i].boxes.forEach(b => { g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); }));
    const b = r.words[sg.wordIdx[0]].boxes[0];
    g.font = `bold ${Math.max(14, (b.y1 - b.y0) * 0.7)}px sans-serif`; g.fillStyle = `hsl(${hue},90%,30%)`;
    g.fillText(String(k + 1), Math.max(0, b.x0 - (b.y1 - b.y0) * 0.9), b.y1 - 2);
  });
  return { ms, segs: r.segs.map(x => x.text), lignes: page.lines.length, redressee: page.cropped,
           image: c.toDataURL("image/jpeg", 0.75) };
})"""

# ---------- Rapport ----------
def rapport(resultats):
    e = html.escape
    lignes = []
    for r in resultats:
        if "erreur" in r:
            lignes.append(f"<section><h2>{e(r['nom'])}</h2><p class=ko>Erreur : {e(r['erreur'])}</p></section>"); continue
        rangs = []
        if r["sans_attendu"]:
            rangs = [f"<tr><td class=n>{j + 1}</td><td>{e(t)}</td></tr>" for j, t in enumerate(r["obtenu"])]
            lignes.append(f"""<section><h2>{e(r['nom'])}</h2>
<p class=chiffres>Pas de texte attendu (ajouter {e(r['nom'])}.txt pour noter) · {len(r['obtenu'])} phrases lues · {r['ms']/1000:.1f} s ·
feuille {'trouvée et redressée' if r['redressee'] else 'non détourée'}</p>
<div class=duo><img src="{e(r['nom'])}.jpg" alt="page annotée"><table><tr><th></th><th>Lu par l'appli</th></tr>{''.join(rangs)}</table></div></section>""")
            continue
        for i, j, s in r["paires"]:
            a = e(r["attendu"][i]) if i is not None else ""
            b = e(r["obtenu"][j]) if j is not None else ""
            cl = "ok" if (i is not None and j is not None) else ("manque" if j is None else "trop")
            lab = f"{s:.0%}" if cl == "ok" else ("manquante" if cl == "manque" else "en trop")
            num = "" if j is None else str(j + 1)
            rangs.append(f"<tr class={cl}><td>{a}</td><td class=n>{num}</td><td>{b}</td><td class=n>{lab}</td></tr>")
        lignes.append(f"""<section><h2>{e(r['nom'])}</h2>
<p class=chiffres><b>{r['justes']}/{r['nb_attendu']}</b> phrases justes · {r['en_trop']} en trop ·
erreurs de lettres <b>{r['cer']:.1%}</b> · {r['ms']/1000:.1f} s · feuille {'trouvée et redressée' if r['redressee'] else 'non détourée'}</p>
<div class=duo><img src="{e(r['nom'])}.jpg" alt="page annotée"><table><tr><th>Attendu</th><th></th><th>Lu par l'appli</th><th></th></tr>{''.join(rangs)}</table></div></section>""")
    notes = [r for r in resultats if not r.get("sans_attendu")]
    tot_j = sum(r.get("justes", 0) for r in notes); tot_a = sum(r.get("nb_attendu", 0) for r in notes)
    page = f"""<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Lis-moi – tests</title><style>
:root{{--bg:#f4f5f8;--fg:#1b2333;--ok:#d9f2e1;--ko:#fde2e1;--trop:#fff1cc;--card:#fff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#12161e;--fg:#e8ecf4;--ok:#1d3a28;--ko:#4a2323;--trop:#4a3d14;--card:#1b2230}}}}
body{{margin:0;padding:16px;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}}
section{{background:var(--card);border-radius:12px;padding:14px;margin:0 0 18px}}h2{{margin:0 0 4px;font-size:18px}}
.duo{{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:14px;align-items:start}}
@media (max-width:800px){{.duo{{grid-template-columns:1fr}}}}
img{{width:100%;border-radius:8px}}table{{border-collapse:collapse;width:100%}}td,th{{padding:5px 7px;vertical-align:top;text-align:left;border-bottom:1px solid #8883}}
td.n{{white-space:nowrap;opacity:.75;font-size:13px}}tr.ok td{{background:var(--ok)}}tr.manque td{{background:var(--ko)}}tr.trop td{{background:var(--trop)}}
.ko{{color:#c33}}</style>
<h1>Lis-moi – résultats des tests</h1><p><b>{tot_j}/{tot_a}</b> phrases justes au total · {time.strftime('%d/%m/%Y %H:%M')}</p>
<p>Vert : phrase lue et coupée comme attendu · rouge : phrase attendue mais pas retrouvée (mal coupée, mal lue ou dans le mauvais ordre) · jaune : morceau lu en trop.
Sur l'image, chaque phrase a sa couleur et son numéro.</p>
{''.join(lignes)}</html>"""
    with open(os.path.join(RES, "rapport.html"), "w", encoding="utf-8") as f: f.write(page)

# ---------- Programme ----------
def main():
    filtres = [a.lower() for a in sys.argv[1:]]
    images = {os.path.splitext(f)[0]: f for f in sorted(os.listdir(PAGES))
              if os.path.splitext(f)[1].lower() in (".jpg", ".jpeg", ".png", ".webp")}
    images = {n: f for n, f in images.items() if not filtres or any(x in n.lower() for x in filtres)}
    if not images: sys.exit("Aucune page à tester dans tests/pages/ (une image, et si possible <nom>.txt avec le texte attendu).")
    os.makedirs(RES, exist_ok=True)
    print("Démarrage du navigateur et chargement des modèles…")
    nav = Navigateur(); resultats = []
    try:
        for n, im in images.items():
            txt = os.path.join(PAGES, n + ".txt")
            sans = not os.path.exists(txt)      # pas de texte attendu : on montre juste ce qui est lu
            attendu = [] if sans else [norm(l) for l in open(txt, encoding="utf-8").read().splitlines() if l.strip()]
            try:
                d = nav.evaluer(f"{JS_LIRE}({json.dumps('tests/pages/' + im)})")
            except Exception as ex:
                resultats.append({"nom": n, "erreur": str(ex)}); print(f"  {n:34} ERREUR {ex}"); continue
            with open(os.path.join(RES, n + ".jpg"), "wb") as f: f.write(base64.b64decode(d["image"].split(",", 1)[1]))
            obtenu = [norm(s) for s in d["segs"]]
            paires = aligner(attendu, obtenu)
            justes = sum(1 for i, j, _ in paires if i is not None and j is not None)
            ta, to = " ".join(attendu), " ".join(obtenu)
            cer = lev(ta, to) / max(1, len(ta))
            r = dict(nom=n, attendu=attendu, obtenu=obtenu, paires=paires, justes=justes, nb_attendu=len(attendu),
                     en_trop=len(obtenu) - justes, cer=cer, ms=d["ms"], redressee=d["redressee"], sans_attendu=sans)
            resultats.append(r)
            if sans:
                print(f"  {n:34} (pas de texte attendu) {len(obtenu)} phrases lues  {d['ms']/1000:5.1f} s"); continue
            print(f"  {n:34} phrases {justes:>2}/{len(attendu):<2}  en trop {r['en_trop']:<2}  lettres fausses {cer:6.1%}  {d['ms']/1000:5.1f} s")
    finally:
        nav.fermer()
    rapport(resultats)
    with open(os.path.join(RES, "resultats.json"), "w", encoding="utf-8") as f:
        json.dump(resultats, f, ensure_ascii=False, indent=1)
    ok = [r for r in resultats if "erreur" not in r and not r["sans_attendu"]]
    tj = sum(r["justes"] for r in ok); ta = sum(r["nb_attendu"] for r in ok)
    cer = sum(r["cer"] * len(" ".join(r["attendu"])) for r in ok) / max(1, sum(len(" ".join(r["attendu"])) for r in ok))
    print(f"\nTOTAL  phrases justes {tj}/{ta} ({tj/max(1,ta):.0%})  ·  lettres fausses {cer:.1%}")
    print("Rapport :", os.path.join(RES, "rapport.html"))
    if nav.erreurs: print("Erreurs JavaScript :", *set(nav.erreurs), sep="\n  ")

if __name__ == "__main__":
    main()
