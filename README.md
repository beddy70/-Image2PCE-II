# Image2PCE II

Base Tauri pour l’outil de conversion d’images 256×256 PC-Engine (HuC6270). Cette base contient :

- Une UI structurée (panneau de réglages, viewer source/sortie, palettes).
- Des commandes Tauri placeholders (`open_image`, `run_conversion`).
- Une configuration de fenêtre adaptée au layout.

## Démarrage

```bash
cd image2pce-ii
cargo tauri dev
```

## Prochaines étapes

- Implémenter l’ouverture d’images et le pipeline de conversion (Rust).
- Relier les contrôles UI aux paramètres de conversion.
- Générer palettes/tiles/tilemap et image de prévisualisation.
