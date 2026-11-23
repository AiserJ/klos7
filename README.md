# KLOS7 — V1.1

Ta garde-robe de tenues, guidée par la météo. Les photos restent sur le téléphone (rien n'est envoyé sur un serveur), sauf la position envoyée à Open-Meteo pour la météo.

## Nouveautés 1.1
- Correction des photos illisibles (« ? ») sur iPhone : les images sont maintenant stockées en octets bruts. Les anciennes tenues sont converties automatiquement, et une photo irrécupérable affiche « Photo à remplacer ».
- Les PNG détourés (fond transparent) gardent un fond clair au lieu de devenir noirs.
- Une nouvelle tenue est enregistrée comme tenue du jour par défaut (interrupteur « Je la porte aujourd'hui »).
- Météo actualisée toutes les 30 min entre 7h et 22h quand l'app est ouverte, avec une alerte si la prévision change (plus froid, plus doux, pluie).
- Message précis quand la localisation est bloquée.

## Ce que fait la V1
- **Ajouter une tenue** : photo (appareil ou galerie), compressée automatiquement (~3 Mo → ~200 Ko), avec des tags température, pluie, style, occasion et une note.
- **Aujourd'hui / Demain** : météo du jour ou du lendemain (Open-Meteo, gratuit, sans clé), conseil vestimentaire et bouton **Inspire-moi**. Après 18 h, l'app ouvre directement sur demain pour préparer la tenue.
- **Suggestion** : combine la température ressentie, la pluie, l'occasion choisie et les tenues pas portées depuis longtemps.
- **Garde-robe** : grille filtrable, historique des jours portés, modification et suppression.
- **Réglages** : ville ou géolocalisation, espace utilisé, export / import de sauvegarde, effacement des données.
- **Hors ligne** : l'app s'ouvre sans réseau (la dernière météo reste affichée).

## Mettre KLOS7 en ligne avec GitHub Pages (≈ 10 min, sans ligne de commande)
1. Sur github.com, clique sur **New repository**. Nom : `klos7`, visibilité **Public**, puis **Create repository**.
2. Clique sur **uploading an existing file** et glisse **le contenu** du dossier `klos7` (index.html, app.js, styles.css, sw.js, manifest.webmanifest, README.md et le dossier `icons`). Ensuite **Commit changes**.
3. Va dans **Settings → Pages**. Source : **Deploy from a branch**, branche `main`, dossier `/ (root)`, puis **Save**.
4. Après 1 à 2 minutes, l'app est disponible sur `https://TONPSEUDO.github.io/klos7/`. C'est le lien à envoyer à tes amis.

### Mettre à jour l'app
Remplace les fichiers modifiés dans le dépôt (Add file → Upload files). Pense à changer le numéro de version dans `sw.js` (`CACHE = 'klos7-v1.0.1'`) et dans `app.js` (`APP_VERSION`) : les téléphones récupèrent la nouvelle version à la prochaine ouverture.

## Installer sur le téléphone
- **iPhone** : ouvrir le lien dans **Safari**, puis Partager → **Sur l'écran d'accueil**.
- **Android** : ouvrir dans **Chrome**, puis menu ⋮ → **Installer l'application**.

⚠️ Sur iPhone, les données de l'app installée sont séparées de celles de Safari : il vaut mieux installer l'app avant d'ajouter ses tenues.

## Récolter les retours des testeurs
Crée un Google Form (ou Tally), puis colle son lien dans `app.js` :
```js
const FEEDBACK_URL = 'https://forms.gle/...';
```
Un bouton « Donner mon avis » apparaît alors dans les Réglages.

## Tester sur ton ordinateur
Un service worker ne fonctionne pas en ouvrant directement `index.html`, il faut un petit serveur local :
```bash
cd klos7
python3 -m http.server 8000
```
Puis ouvre http://localhost:8000.

## Notes techniques
- Stockage : IndexedDB (photos en Blob), base `klos7`.
- Météo : `api.open-meteo.com` (prévisions) et `geocoding-api.open-meteo.com` (recherche de ville), mise en cache 30 min.
- Les icônes `icons/` sont provisoires, à remplacer par le vrai logo (mêmes noms et mêmes tailles : 180, 192, 512).

## Idées pour la V2
Notification météo du soir (Cloudflare Worker + Web Push), statistiques de port, favoris, analyse IA des photos, volet social.
