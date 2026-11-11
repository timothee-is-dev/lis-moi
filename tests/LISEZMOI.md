# Banc de test de Lis-moi

Fait lire des pages par la vraie appli (même code, mêmes modèles), dans Edge ou Chrome sans fenêtre,
et compare avec le texte attendu.

    pip install websocket-client                 # une seule fois
    python tests/lancer.py                       # toutes les pages
    python tests/lancer.py livre 05_             # seulement certaines pages (morceau du nom)

Résultat : un tableau dans le terminal, et `tests/resultats/rapport.html` à ouvrir dans le navigateur :
chaque page annotée (une couleur + un numéro par phrase) et la comparaison phrase par phrase.

- **phrases justes** : phrases attendues retrouvées, bien coupées et dans le bon ordre
  (une petite faute de lecture est tolérée, à 85 % de ressemblance) ;
- **en trop** : morceaux lus qui ne correspondent à aucune phrase attendue (souvent une phrase coupée en deux) ;
- **lettres fausses** : taux d'erreur sur les caractères de toute la page.

## Ajouter une vraie photo (le plus utile)

Déposer dans `tests/pages/` :
- `ma_page.jpg` : la photo telle quelle, prise au téléphone ;
- `ma_page.txt` : le texte attendu, **une phrase par ligne**, un titre seul sur sa ligne, dans l'ordre de lecture.

## Pages synthétiques

`python tests/generer.py` (re)crée les pages `01_` à `15_` (exercice, conte, dialogue, colonnes,
fiche d'enfant avec cadre, liste et tableau, petite police) avec des défauts de photo : feuille de travers,
ombres, page bombée, flou, basse définition, photo tournée ou à l'envers. Nécessite pillow, numpy,
opencv-python-headless et les polices Windows.
