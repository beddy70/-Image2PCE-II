<p align="center">
  <img src="logo.png" alt="Image2PCE II" width="200" />
</p>

<h1 align="center">Image2PCE II</h1>

<p align="center">
  <strong>Convertisseur d'images pour PC-Engine / TurboGrafx-16</strong>
</p>

---

## Table des matières

1. [Description](#description)
2. [Fonctionnalités](#fonctionnalités)
   - [Conversion d'images](#conversion-dimages)
   - [Gestion des palettes](#gestion-des-palettes)
   - [Dithering](#dithering)
   - [Courbe RGB333](#courbe-rgb333)
   - [Export](#export)
   - [Interface](#interface)
   - [Simulation CRT](#simulation-crt)
3. [Installation](#installation)
   - [Prérequis](#prérequis)
   - [Compilation](#compilation)
   - [Compilation multi-plateforme](#compilation-multi-plateforme)
   - [Développement](#développement)
4. [Utilisation](#utilisation)
5. [Raccourcis clavier](#raccourcis-clavier)
6. [Format des fichiers exportés](#format-des-fichiers-exportés)
   - [Binaires](#binaires)
   - [Format BAT](#format-bat)
   - [Format tuile planaire](#format-tuile-planaire)
   - [Format couleur PCE](#format-couleur-pce)
7. [Dépannage](#dépannage)
8. [Technologies](#technologies)
9. [Licence](#licence)
10. [Auteur](#auteur)

---

## Description

Image2PCE II est une application desktop permettant de convertir des images au format graphique de la PC-Engine (TurboGrafx-16). L'application génère automatiquement les données nécessaires pour afficher des images en 256×256 pixels avec les contraintes matérielles de la console :

- **16 palettes** de 16 couleurs chacune
- **Couleurs RGB333** (3 bits par canal = 512 couleurs possibles)
- **Tuiles 8×8** avec déduplication automatique
- **Format BAT** (Block Address Table) pour l'affichage

## Fonctionnalités

### Conversion d'images
- Support des formats PNG, JPEG, GIF, WebP, BMP
- Redimensionnement automatique en 256×256 avec plusieurs algorithmes (Lanczos, Nearest, CatmullRom)
- Option de préservation du ratio d'aspect
- Détection et optimisation des tuiles vides

### Gestion des palettes
- Génération automatique de 1 à 16 palettes optimisées
- Sélection manuelle de la couleur 0 (transparence)
- Visualisation interactive des palettes générées

### Dithering
- Mode Floyd-Steinberg pour un rendu progressif
- Mode Ordered pour un motif régulier
- Masque de dithering éditable

### Courbe RGB333
- Éditeur de courbe pour ajuster la quantification des couleurs
- Contrôle précis du mapping des niveaux de gris

### Export
- **Binaires** : fichiers `.bat`, `.tile`, `.pal` prêts à l'emploi
- **Assembleur** : fichier `.asm` avec données formatées et commentées
- **Image** : export PNG de la prévisualisation
- Adresse VRAM configurable pour le BAT

### Interface
- Prévisualisation en temps réel source/sortie
- Zoom et navigation dans les images
- Survol des tuiles avec affichage de la palette associée
- Sauvegarde automatique des réglages

### Simulation CRT
Simulation d'affichage sur écran cathodique avec plusieurs modes :
- **Scanlines** : lignes de balayage horizontales (flou léger)
- **Aperture Grille** : bandes RGB verticales style Trinitron (flou léger)
- **Shadow Mask** : motif de points RGB style TV classique (flou moyen)
- **Composite** : combinaison scanlines + grille RGB + vignettage (flou prononcé)

Chaque mode simule les caractéristiques analogiques des tubes CRT :
- Flou progressif selon le type d'écran
- Augmentation du contraste et de la saturation (phosphores)
- Effet de bloom (halo lumineux)
- Vignettage sur les bords (mode Composite)

## Installation

### Prérequis
- macOS 10.15+ / Windows 10+ / Linux
- [Rust](https://rustup.rs/) (pour la compilation)

### Compilation

```bash
cd image2pce-ii/src-tauri
cargo tauri build
```

L'application compilée se trouve dans `target/release/bundle/`.

### Compilation multi-plateforme

#### macOS

**Apple Silicon (M1/M2/M3)** :
```bash
rustup target add aarch64-apple-darwin
cargo tauri build --target aarch64-apple-darwin
```

**Intel** :
```bash
rustup target add x86_64-apple-darwin
cargo tauri build --target x86_64-apple-darwin
```

**Universal Binary (Intel + Apple Silicon)** :
```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri build --target universal-apple-darwin
```

Fichiers générés :
- `target/release/bundle/macos/Image2PCE II.app` - Application
- `target/release/bundle/dmg/Image2PCE II_x.x.x_*.dmg` - Image disque

#### Windows

**Prérequis** : [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) avec "Desktop development with C++"

**64-bit** :
```bash
rustup target add x86_64-pc-windows-msvc
cargo tauri build --target x86_64-pc-windows-msvc
```

**32-bit** :
```bash
rustup target add i686-pc-windows-msvc
cargo tauri build --target i686-pc-windows-msvc
```

Fichiers générés :
- `target/release/bundle/msi/Image2PCE II_x.x.x_x64.msi` - Installateur MSI
- `target/release/bundle/nsis/Image2PCE II_x.x.x_x64-setup.exe` - Installateur NSIS

#### Linux

**Prérequis** (Debian/Ubuntu) :
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**64-bit** :
```bash
rustup target add x86_64-unknown-linux-gnu
cargo tauri build --target x86_64-unknown-linux-gnu
```

Fichiers générés :
- `target/release/bundle/deb/image2pce-ii_x.x.x_amd64.deb` - Paquet Debian
- `target/release/bundle/appimage/image2pce-ii_x.x.x_amd64.AppImage` - AppImage
- `target/release/bundle/rpm/image2pce-ii-x.x.x-1.x86_64.rpm` - Paquet RPM

#### Cross-compilation depuis macOS

Pour compiler pour Windows depuis macOS (expérimental) :
```bash
# Installer les outils de cross-compilation
brew install mingw-w64

# Installer NSIS pour créer l'installateur Windows
brew install nsis

# Ajouter la target
rustup target add x86_64-pc-windows-gnu

# Compiler
cargo tauri build --target x86_64-pc-windows-gnu
```

> **Note** : La cross-compilation peut nécessiter une configuration supplémentaire. Il est recommandé de compiler nativement sur chaque plateforme cible pour une meilleure compatibilité.
>
> **Important** : NSIS (Nullsoft Scriptable Install System) est requis pour générer l'installateur `.exe`. Sans NSIS, la compilation échouera avec l'erreur `makensis: No such file or directory`.

### Développement

```bash
cd image2pce-ii/src-tauri
cargo tauri dev
```

## Utilisation

1. **Ouvrir une image** : Cliquez sur "Open image" pour charger votre image source
2. **Configurer les paramètres** :
   - Méthode de redimensionnement
   - Nombre de palettes (1-16)
   - Mode de dithering
   - Couleur de fond/transparence
3. **Convertir** : Cliquez sur "Convertir" pour lancer la conversion
4. **Exporter** : Choisissez le format d'export souhaité

## Raccourcis clavier

### Éditeur de masque (dithering)
| Raccourci | Action |
|-----------|--------|
| `Ctrl/Cmd + Z` | Annuler |
| `Ctrl/Cmd + Y` ou `Ctrl/Cmd + Shift + Z` | Rétablir |
| `X` | Basculer entre pinceau et gomme |

### Éditeur de tuiles
| Raccourci | Action |
|-----------|--------|
| `Ctrl/Cmd + Z` | Annuler |
| `Ctrl/Cmd + Y` ou `Ctrl/Cmd + Shift + Z` | Rétablir |
| `X` | Basculer entre pinceau et sélection |

## Format des fichiers exportés

### Binaires

| Fichier | Contenu | Taille |
|---------|---------|--------|
| `.bat` | Block Address Table (16-bit words, little-endian) | 2048 octets (32×32 tuiles × 2) |
| `.tile` | Données des tuiles (format planaire PCE) | Variable (32 octets/tuile) |
| `.pal` | Palettes (16 palettes × 16 couleurs × 2 octets) | 512 octets |

### Format BAT
Chaque entrée BAT est un mot 16 bits :
```
PPPP AAAA AAAA AAAA
│    └─────────────── Adresse VRAM >> 4
└──────────────────── Index de palette (0-15)
```

### Format tuile planaire
32 octets par tuile, organisés en 4 plans :
- Octets 0-7 : Plan 0, lignes 0-7
- Octets 8-15 : Plan 1, lignes 0-7
- Octets 16-23 : Plan 2, lignes 0-7
- Octets 24-31 : Plan 3, lignes 0-7

### Format couleur PCE
Chaque couleur est encodée sur 9 bits (RGB333) dans un mot 16 bits :
```
0000 0GGG RRRB BB00
      │    │   └──── Bleu (3 bits)
      │    └──────── Rouge (3 bits)
      └───────────── Vert (3 bits)
```

## Dépannage

### macOS : L'application ne se lance pas

Si l'application refuse de se lancer sur macOS avec un message du type "Image2PCE II est endommagé" ou "impossible de vérifier le développeur", cela est dû à la quarantaine Gatekeeper. Pour résoudre ce problème, exécutez cette commande dans le Terminal :

```bash
xattr -dr com.apple.quarantine /Applications/Image2PCE\ II.app
```

> **Note** : Cette commande supprime l'attribut de quarantaine ajouté par macOS lors du téléchargement. Assurez-vous d'avoir téléchargé l'application depuis une source fiable avant d'exécuter cette commande.

## Technologies

- **[Tauri 2](https://tauri.app/)** - Framework d'application desktop
- **Rust** - Backend de traitement d'images
- **JavaScript** - Interface utilisateur

## Licence

MIT License

## Auteur

Développé pour la communauté PC-Engine / TurboGrafx-16.
