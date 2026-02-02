<p align="center">
  <img src="../logo.png" alt="Image2PCE II" width="200" />
</p>

<h1 align="center">Image2PCE II</h1>

<p align="center">
  <strong>Convertisseur d'images pour PC-Engine / TurboGrafx-16</strong>
</p>

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

## Technologies

- **[Tauri 2](https://tauri.app/)** - Framework d'application desktop
- **Rust** - Backend de traitement d'images
- **JavaScript** - Interface utilisateur

## Licence

MIT License

## Auteur

Développé pour la communauté PC-Engine / TurboGrafx-16.
