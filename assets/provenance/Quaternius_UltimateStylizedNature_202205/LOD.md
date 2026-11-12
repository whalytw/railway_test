# Nature LOD1 derivation

26 green tree/bush models have a true lower-triangle far model. Each retains a deterministic, spatially distributed subset of whole connected leaf-card islands. Islands are connected using exact vertex positions so UV seams cannot split a card into individual triangles. No card is collapsed, rescaled or given different UVs.

Six coordinate extremes remain represented, preserving every primitive's exact indexed bounds. All position, normal, UV and tangent accessor bytes are unchanged. Opaque bark and flower index buffers are unchanged; only independent foliage index arrays are shortened. Original main GLBs remain untouched and are used near the camera. The five palms are skipped because they have only 8–12 large fronds; opaque/dead trees, rocks, flowers, grass and flower-crown pieces are also unchanged.

Across the 26 affected models, one instance each is reduced from 92848 to 74032 triangles (20.3%). This is a geometry reduction, not a measured frame-rate guarantee. Full per-model selection and accessor proofs are under `lods/`; aggregate checks are in `validation/nature-v8-lod.json`.

Repeat deterministic verification with `node scripts/build-nature-lod-v8.mjs --verify-only`. It uses only delivered local game files.
