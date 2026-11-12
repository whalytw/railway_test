# Quaternius nature assets in RailLoopLab v8

These 63 third-party models are from Quaternius Ultimate Stylized Nature Pack (May 2022), identified in the source library as CC0-1.0. The dedicated pack page, official license, later generic QAL page and documented title discrepancy are preserved under `assets/licenses/Quaternius_UltimateStylizedNature_202205/`. Source Blender files and the full archive remain in the local asset library and are not delivered with the game.

Each `models/<asset ID>.json` records the original Blender SHA-256, imported GLB SHA-256, output GLB SHA-256, individual accessor byte hashes, placement guidance and exact model-specific compatible biomes. `textures.json` links each content-addressed PNG to its original author file and the verified recovery mirror, including all original filenames that share identical bytes.

The import only extracts embedded PNG image bytes into shared files and repacks non-image BIN views without changing their contents. All 457 accessors are checked byte-for-byte, including indices, positions, normals, UVs and tangents. MASK alpha, cutoffs, double-sided state, material assignments and sampler values are preserved. No baked animation, wind shader or LOD was added.

PalmTree models retain Desert as their exact catalog biome and carry `nearWaterOnly: true` and `habitat: oasis`; place them around water rather than throughout dry dunes. The original placement notes remain intact. Source files named Petals are static flower-head / flower-crown pieces for small flower patches or flower assembly, not individual falling-petal effects. They contain no particle behavior or falling animation.

Use `node scripts/import-nature-v8.mjs --source-root <GameAssets> --target-root <game> --verify-only` to repeat the source comparison. The source root is read-only. The game is fully local through its included HTTP server; no external texture or model requests are required.
