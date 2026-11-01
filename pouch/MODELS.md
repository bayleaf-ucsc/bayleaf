# Pouch models

The in-browser (Transformers.js provider) models Pouch has qualified or considered: the
intake ledger for `.agents/skills/bayleaf-ops-router/playbooks/qualify-in-browser-model.md`.
Pins live in `models.lock.json`; evidence lives in `experiments/`.

| Model (export, dtype) | License | Status | Evidence |
|---|---|---|---|
| LFM3-1.7B (`onnx-community/LFM3-1.7B-ONNX@ab9fec4c`, q4f16, 1.09 GB) | LFM Open License v1.0 (commercial use below $10M annual revenue; not permissive) | **ships**; core 56/56 with the v8 recipe (quant run); shipped-text recipe smoke 8/8, full matrix pending | `experiments/lfm3-webgpu/README.md`, `qualification/results/quant.json` |
| LFM3-1.7B q4 / q8 (same revision) | as above | rejected by the dtype rule: q4 no gain, q8 loses `feature` with the recipe | `quant.json` |
| LFM3-1.7B fp16 | as above | not run: 3.56 GB, over the size budget | `quant.json` |
| MiniCPM5-2B (community ONNX only, q4f16 ~1.83 GB) | Apache-2.0 | candidate, not qualified: no official WebGPU export; tool tags are special tokens and need a dedicated parser | survey notes (2026-11-01) |

License intake is a human gate: a non-permissive license, like the one that ships today,
stays in use only by Adam's explicit decision, recorded here.

## License decisions

- 2026-11-01, LFM3-1.7B (LFM Open License v1.0): accepted by Adam on a non-commercial
  reading. BayLeaf is a free, gift-funded campus service operated by one faculty member;
  Pouch charges nothing and sells nothing. Revisit if BayLeaf's funding or operator changes.
