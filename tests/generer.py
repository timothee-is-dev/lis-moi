# Lis-moi — génère des pages de test variées, avec le texte attendu (une phrase par ligne).
#
#   python tests/generer.py
#
# Chaque page donne tests/pages/<nom>.jpg + tests/pages/<nom>.txt.
# Pour ajouter une vraie photo : déposer <nom>.jpg et écrire <nom>.txt à la main
# (une phrase par ligne, un titre = une ligne, dans l'ordre où il faut la lire).
# Dépendances : pip install pillow numpy opencv-python-headless   (polices Windows)
import os, random, math, shutil
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

ICI = os.path.dirname(os.path.abspath(__file__))
SORTIE = os.path.join(ICI, "pages")
FONTS = "C:/Windows/Fonts/"
W, H = 1240, 1754  # A4 à 150 dpi

def police(nom, taille):
    return ImageFont.truetype(FONTS + nom, taille)

# ---------- Mise en page ----------
class Page:
    def __init__(self, fond="white", marge=100):
        self.im = Image.new("RGB", (W, H), fond)
        self.d = ImageDraw.Draw(self.im)
        self.y = marge; self.m = marge; self.attendu = []

    def titre(self, texte, f="arialbd.ttf", t=54, couleur="black", centre=False, apres=40):
        fo = police(f, t)
        x = (W - self.d.textlength(texte, font=fo)) / 2 if centre else self.m
        self.d.text((x, self.y), texte, font=fo, fill=couleur)
        self.y += t * 1.3 + apres; self.attendu.append(texte)

    def para(self, phrases, f="arial.ttf", t=34, couleur="black", justifie=False, retrait=0,
             coupe=False, x0=None, largeur=None, interligne=1.45, apres=36, attendu=True):
        """Paragraphe ; coupe=True : on coupe les longs mots en fin de ligne avec un tiret."""
        fo = police(f, t); x0 = self.m if x0 is None else x0
        largeur = (W - 2 * self.m) if largeur is None else largeur
        mots = " ".join(phrases).split(" ")
        lignes, cur, ind = [], [], retrait
        def lg(ws): return self.d.textlength(" ".join(ws), font=fo)
        i = 0
        while i < len(mots):
            m = mots[i]
            if lg(cur + [m]) + ind <= largeur: cur.append(m); i += 1; continue
            if coupe and len(m) >= 7 and m.isalpha():
                for k in range(len(m) - 3, 2, -1):
                    if lg(cur + [m[:k] + "-"]) + ind <= largeur and m[k-1] in "aeiouyéèêàâ" :
                        cur.append(m[:k] + "-"); mots[i] = m[k:]; break
            lignes.append((cur, ind, True)); cur, ind = [], 0
        if cur: lignes.append((cur, ind, False))
        for ws, ind, pleine in lignes:
            if justifie and pleine and len(ws) > 1:
                libre = largeur - ind - sum(self.d.textlength(w, font=fo) for w in ws)
                x = x0 + ind; esp = libre / (len(ws) - 1)
                for w in ws:
                    self.d.text((x, self.y), w, font=fo, fill=couleur); x += self.d.textlength(w, font=fo) + esp
            else:
                self.d.text((x0 + ind, self.y), " ".join(ws), font=fo, fill=couleur)
            self.y += t * interligne
        self.y += apres
        if attendu: self.attendu += phrases
        return self

    def liste(self, items, marque="{n}.", f="arial.ttf", t=34, apres=30):
        fo = police(f, t)
        for n, phr in enumerate(items, 1):
            mk = marque.format(n=n, l="abcdefgh"[n-1])
            self.d.text((self.m, self.y), mk, font=fo, fill="black")
            dx = self.d.textlength(mk + "  ", font=fo)
            y0 = self.y
            self.para([phr], f=f, t=t, x0=self.m + dx, largeur=W - 2 * self.m - dx, apres=12, attendu=False)
            self.attendu.append(f"{mk} {phr}" if not mk.strip() in "•–-" else phr)
        self.y += apres

    def colonnes(self, gauche, droite, **kw):
        y0 = self.y; larg = (W - 2 * self.m - 60) // 2
        self.para(gauche, x0=self.m, largeur=larg, **kw); yg = self.y; self.y = y0
        self.para(droite, x0=self.m + larg + 60, largeur=larg, **kw); self.y = max(yg, self.y)

    def tableau(self, lignes, f="arial.ttf", t=32):
        fo = police(f, t); col = [self.m + 20, self.m + 520]; h = t * 2
        x1 = W - self.m
        for r, cells in enumerate(lignes):
            self.d.rectangle([self.m, self.y, x1, self.y + h], outline="black", width=2)
            self.d.line([col[1] - 20, self.y, col[1] - 20, self.y + h], fill="black", width=2)
            for c, txt in enumerate(cells):
                self.d.text((col[c], self.y + t * 0.45), txt, font=fo, fill="black")
                self.attendu.append(txt)
            self.y += h
        self.y += 40

    def cadre(self, y0, couleur=(30, 90, 200)):
        self.d.rounded_rectangle([self.m - 30, y0 - 25, W - self.m + 30, self.y - 10], radius=20, outline=couleur, width=4)

# ---------- Dégradations "photo" ----------
def en_bgr(im): return np.array(im)[:, :, ::-1].copy()

def photo(a, perspective=0.0, angle=0.0, ombre=0.0, courbure=0.0, flou=0, bruit=0.0,
          echelle=1.0, fond=(70, 90, 110), qualite=85, rotation=0, graine=0):
    rnd = random.Random(graine)
    h, w = a.shape[:2]
    if courbure:  # page de livre bombée : les lignes se courbent
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        dy = courbure * h * np.sin(np.pi * xs / w) * (1 - 0.6 * ys / h)
        a = cv2.remap(a, xs, ys - dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    P = int(0.12 * max(h, w)); Wc, Hc = w + 2 * P, h + 2 * P
    j = lambda: rnd.uniform(-1, 1) * perspective * w
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[P + j(), P + j()], [P + w + j(), P + j()], [P + w + j(), P + h + j()], [P + j(), P + h + j()]])
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    cx, cy = Wc / 2, Hc / 2
    dst = np.float32([[cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] for x, y in dst])
    M = cv2.getPerspectiveTransform(src, dst)
    bg = np.empty((Hc, Wc, 3), np.uint8); bg[:] = fond
    out = cv2.warpPerspective(a, M, (Wc, Hc), dst=bg, borderMode=cv2.BORDER_TRANSPARENT)
    if ombre:
        yy, xx = np.mgrid[0:Hc, 0:Wc]
        g = np.clip(xx / Wc * 0.6 + yy / Hc * 0.4, 0, 1)
        blob = np.exp(-(((xx - Wc * 0.3) / (Wc * 0.25)) ** 2 + ((yy - Hc * 0.7) / (Hc * 0.2)) ** 2))
        shade = (1 - ombre) + ombre * g - 0.5 * ombre * blob
        out = (out * np.clip(shade, 0.15, 1)[..., None]).clip(0, 255).astype(np.uint8)
    if flou: out = cv2.GaussianBlur(out, (0, 0), flou)
    if bruit: out = np.clip(out + np.random.default_rng(graine).normal(0, bruit, out.shape), 0, 255).astype(np.uint8)
    if echelle != 1: out = cv2.resize(out, None, fx=echelle, fy=echelle, interpolation=cv2.INTER_AREA)
    if rotation == 90: out = cv2.rotate(out, cv2.ROTATE_90_COUNTERCLOCKWISE)
    if rotation == 180: out = cv2.rotate(out, cv2.ROTATE_180)
    if rotation == 270: out = cv2.rotate(out, cv2.ROTATE_90_CLOCKWISE)
    return out, qualite

def ecrire(nom, page, a=None, qualite=90):
    a = en_bgr(page.im) if a is None else a
    cv2.imwrite(os.path.join(SORTIE, nom + ".jpg"), a, [cv2.IMWRITE_JPEG_QUALITY, qualite])
    with open(os.path.join(SORTIE, nom + ".txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(page.attendu) + "\n")
    print("  ", nom, len(page.attendu), "phrases")

# ---------- Les documents ----------
def exercice():
    p = Page()
    p.titre("Exercice 3")
    p.para(["M. Dupont est allé au marché avec sa fille, ex. pour acheter des pommes, des poires, etc.",
            "Il a payé 3,50 € pour le tout.", "Ensuite ils sont rentrés à la maison…",
            "La petite a conjugué les verbes du premier groupe.", "Quelle belle journée !"], coupe=True)
    p.titre("Consigne", t=46, couleur=(30, 60, 160))
    p.para(["Lis le texte puis réponds aux questions."], apres=8)
    p.para(["Où sont allés M. Dupont et sa fille ?"])
    return p

def conte():
    p = Page(fond=(250, 247, 238), marge=130)
    p.titre("CHAPITRE PREMIER", f="timesbd.ttf", t=44, centre=True, apres=60)
    kw = dict(f="times.ttf", t=36, justifie=True, coupe=True, retrait=50, interligne=1.35, apres=10)
    p.para(["Il était une fois, dans un petit village au bord de la mer, une vieille femme qui vivait seule avec son chat.",
            "Chaque matin, elle descendait au port pour regarder les bateaux rentrer de la pêche.",
            "Les marins la saluaient toujours avec gentillesse, car elle connaissait le nom de chacun d'entre eux."], **kw)
    p.para(["Un jour d'automne, pourtant, aucun bateau ne revint.",
            "Le ciel était devenu sombre, et le vent soufflait si fort que les volets claquaient contre les murs.",
            "La vieille femme attendit longtemps sur le quai, enveloppée dans son grand châle de laine."], **kw)
    p.para(["Quand la nuit tomba, elle alluma une lanterne et la posa sur le rebord de sa fenêtre.",
            "« Ainsi, ils sauront où se trouve la terre », murmura-t-elle."], **kw)
    return p

def dialogue():
    p = Page(marge=120)
    kw = dict(f="georgia.ttf", t=34, interligne=1.4, apres=14, retrait=40)
    p.para(["Le renard s'approcha doucement du puits.", "Il avait soif depuis le matin."], **kw)
    p.para(["— Qui est là ? demanda une petite voix.", "Je ne te vois pas !"], **kw)
    p.para(["— C'est moi, le renard.", "N'aie pas peur, je ne te veux aucun mal."], **kw)
    p.para(["— Mme la grenouille m'a dit de me méfier de toi, répondit la voix."], **kw)
    p.para(["Le renard sourit et s'assit sur la margelle."], **kw)
    return p

def colonnes():
    p = Page()
    p.titre("Le loup et l'agneau", t=50)
    p.colonnes(["La raison du plus fort est toujours la meilleure : nous l'allons montrer tout à l'heure.",
                "Un agneau se désaltérait dans le courant d'une onde pure."],
               ["Un loup survient à jeun, qui cherchait aventure, et que la faim en ces lieux attirait.",
                "Qui te rend si hardi de troubler mon breuvage ? dit cet animal plein de rage."], t=32)
    p.y += 40
    p.titre("Questions", t=46, couleur=(160, 30, 30))
    p.liste(["Qui est le plus fort ?", "Où boit l'agneau ?", "Pourquoi le loup est-il en colère ?"])
    return p

def fiche_enfant():
    p = Page(marge=110)
    p.titre("Ma fiche de lecture", f="comicbd.ttf", t=56, centre=True)
    y0 = p.y
    p.para(["Lis bien chaque phrase.", "Si tu ne connais pas un mot, demande à la maîtresse."], f="comic.ttf", t=36)
    p.cadre(y0)
    p.y += 30
    p.titre("Coche la bonne réponse", f="comicbd.ttf", t=40, couleur=(200, 60, 20))
    p.liste(["Le chat dort sur le canapé.", "Le chien court dans le jardin.", "Les oiseaux chantent le matin."],
            marque="{l})", f="comic.ttf", t=36)
    p.tableau([["Prénom", "Léa"], ["Classe", "CE1"], ["Date", "mardi 12 mars"]], f="comic.ttf", t=34)
    return p

def petite_police():
    p = Page(marge=90)
    p.titre("Note aux parents", f="calibrib.ttf", t=40)
    p.para(["Madame, Monsieur, la sortie scolaire au musée aura lieu le jeudi 14 novembre.",
            "Le départ est prévu à 8 h 30 devant l'école, le retour vers 16 h 45.",
            "Merci de prévoir un pique-nique, une gourde et des vêtements adaptés à la météo.",
            "La participation demandée est de 4,50 € par enfant.",
            "Pour toute question, vous pouvez contacter l'enseignante au 01 23 45 67 89."],
           f="calibri.ttf", t=24, interligne=1.3)
    p.para(["Signature des parents :"], f="calibri.ttf", t=24)
    return p

# (nom, document, réglages "photo" ou None pour un scan net)
JEU = [
    ("01_exercice_scan", exercice, None),
    ("02_exercice_photo_travers", exercice, dict(perspective=0.06, angle=4, ombre=0.45, graine=1)),
    ("03_exercice_tourne_90", exercice, dict(perspective=0.03, angle=-2, ombre=0.3, rotation=90, graine=2)),
    ("04_exercice_a_l_envers", exercice, dict(perspective=0.03, angle=2, ombre=0.3, rotation=180, graine=3)),
    ("05_conte_livre_bombe", conte, dict(perspective=0.04, angle=-3, courbure=0.012, ombre=0.4, fond=(120, 80, 40), graine=4)),
    ("06_conte_flou_basse_def", conte, dict(perspective=0.03, angle=2, flou=1.2, bruit=6, echelle=0.55, qualite=70, graine=5)),
    ("07_dialogue_penche", dialogue, dict(perspective=0.05, angle=6, ombre=0.35, graine=6)),
    ("08_colonnes_photo", colonnes, dict(perspective=0.05, angle=-2, ombre=0.4, graine=7)),
    ("09_fiche_enfant", fiche_enfant, dict(perspective=0.04, angle=1.5, ombre=0.3, graine=8)),
    ("10_petite_police_photo", petite_police, dict(perspective=0.03, angle=-1.5, ombre=0.35, graine=9)),
    ("11_fiche_enfant_ombre_forte", fiche_enfant, dict(perspective=0.06, angle=-5, ombre=0.75, graine=10)),
    ("12_dialogue_fond_clair", dialogue, dict(perspective=0.05, angle=2, fond=(225, 225, 220), ombre=0.2, graine=11)),
    ("13_conte_sans_bord_penche", conte, dict(angle=8, fond=(250, 247, 238), graine=12)),
    ("14_conte_tres_bombe", conte, dict(perspective=0.02, courbure=0.03, ombre=0.3, fond=(40, 60, 90), graine=13)),
    ("15_exercice_penche_fort", exercice, dict(perspective=0.04, angle=20, ombre=0.3, graine=14)),
]

# ---------- Photo d'un écran qui affiche une photo de livre (le cas des tests "à la main") ----------
def ecran(source, legende, zoom=1.0, angle=3.0, perspective=0.05, graine=0):
    """La page `source` (photo de tests/pages) est affichée sur un site web, sur un moniteur, photographié de biais."""
    rnd = random.Random(graine)
    S = Image.new("RGB", (1920, 1080), "white"); d = ImageDraw.Draw(S)
    d.rectangle([0, 0, 1920, 70], fill=(245, 246, 248)); d.text((40, 18), "Mettre en page un livre", font=police("arialbd.ttf", 30), fill=(40, 40, 40))
    livre = Image.open(os.path.join(SORTIE, source)).convert("RGB"); livre.thumbnail((1300, 860))
    x = (1920 - livre.width) // 2; S.paste(livre, (x, 95))
    d.text((x, 95 + livre.height + 12), legende, font=police("ariali.ttf", 26), fill=(60, 60, 60))
    d.rectangle([0, 1040, 1920, 1080], fill=(225, 230, 240))                       # barre des tâches
    for k in range(12): d.rounded_rectangle([700 + k * 44, 1046, 730 + k * 44, 1074], 6, fill=(rnd.randrange(40, 220), rnd.randrange(40, 220), rnd.randrange(40, 220)))
    a = en_bgr(S)
    a = cv2.copyMakeBorder(a, 28, 28, 28, 28, cv2.BORDER_CONSTANT, value=(20, 20, 20))   # bord du moniteur
    a, _ = photo(a, perspective=perspective, angle=angle, ombre=0.15, flou=1.0, bruit=5, fond=(60, 50, 45), graine=graine)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]                                                         # moiré de l'écran
    a = np.clip(a * (1 + 0.07 * np.sin(2 * np.pi * (xx * 0.13 + yy * 0.97) / 5.3))[..., None], 0, 255).astype(np.uint8)
    if zoom > 1:   # photo rapprochée : on cadre sur la page du livre
        cw, ch = int(w / zoom), int(h / zoom); cx, cy = w // 2 + rnd.randint(-40, 40), int(h * 0.45)
        a = a[max(0, cy - ch // 2): cy + ch // 2, max(0, cx - cw // 2): cx + cw // 2]
    a = cv2.resize(a, None, fx=1.4, fy=1.4, interpolation=cv2.INTER_CUBIC)
    return a

ECRANS = [
    ("40_ecran_preface_large", "30_livre_10.jpg", "Les Hauts de Hurle-Vent d'Emily Brontë aux éditions de Fallois", dict(zoom=1.0, angle=2, graine=20)),
    ("41_ecran_preface_proche", "30_livre_10.jpg", "Les Hauts de Hurle-Vent d'Emily Brontë aux éditions de Fallois", dict(zoom=1.7, angle=-3, graine=21)),
    ("42_ecran_remerciements_large", "30_livre_16.jpg", "Remerciements de 14-14 aux éditions Bragelonne", dict(zoom=1.0, angle=-2, graine=22)),
    ("43_ecran_remerciements_proche", "30_livre_16.jpg", "Remerciements de 14-14 aux éditions Bragelonne", dict(zoom=1.8, angle=4, perspective=0.07, graine=23)),
]

if __name__ == "__main__":
    os.makedirs(SORTIE, exist_ok=True)
    for nom, doc, reglages in JEU:
        p = doc()
        if reglages is None: ecrire(nom, p)
        else:
            a, q = photo(en_bgr(p.im), **reglages); ecrire(nom, p, a, q)
    for nom, src, legende, reglages in ECRANS:
        a = ecran(src, legende, **reglages)
        cv2.imwrite(os.path.join(SORTIE, nom + ".jpg"), a, [cv2.IMWRITE_JPEG_QUALITY, 85])
        shutil.copy(os.path.join(SORTIE, os.path.splitext(src)[0] + ".txt"), os.path.join(SORTIE, nom + ".txt"))
        print("  ", nom, "(photo d'écran de", src + ")")
