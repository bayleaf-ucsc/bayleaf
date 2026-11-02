# Pouch models

The in-browser models Pouch has qualified or considered (the Transformers.js provider's
chat models, and the speech-to-text model behind `transcribe`): the
intake ledger for `.agents/skills/bayleaf-ops-router/playbooks/qualify-in-browser-model.md`.
Pins live in `models.lock.json`; evidence lives in `experiments/`.

| Model (export, dtype) | License | Status | Evidence |
|---|---|---|---|
| LFM3-1.7B (`onnx-community/LFM3-1.7B-ONNX@ab9fec4c`, q4f16, 1.09 GB) | LFM Open License v1.0 (commercial use below $10M annual revenue; not permissive) | **ships**; core 56/56 with the v8 recipe (quant run); shipped-text recipe smoke 8/8, full matrix pending | `experiments/lfm3-webgpu/README.md`, `qualification/results/quant.json` |
| LFM3-1.7B q4 / q8 (same revision) | as above | rejected by the dtype rule: q4 no gain, q8 loses `feature` with the recipe | `quant.json` |
| LFM3-1.7B fp16 | as above | not run: 3.56 GB, over the size budget | `quant.json` |
| Parakeet TDT 0.6B v3, speech to text (`ysdede/parakeet-tdt-0.6b-v3-onnx@e5356bf6`, fp16 encoder and decoder, 1.28 GB; with its runtime add-on 1.3 GB) | CC-BY-4.0 (NVIDIA; attribution shown in the add-on sheet, `addons info`, the VTT and JSON outputs) | **candidate**: built and tested on this branch; ships when Adam approves the gateway release and both are deployed. 31.7 min of English in 27.8 s, WER 1.9% (M3 Max) | `experiments/parakeet-webgpu/README.md`, `test/parakeet-browser.mjs` |
| Parakeet int8 encoder (same revision, 652 MB) | as above | rejected: on WebGPU its quantized matmuls fall back to wasm, 20-35x slower | spike `results/` |
| Parakeet int8 decoder (same revision, 18 MB) | as above | rejected for fp16: half as fast at interview length, same accuracy (the brief's and asrjs's default) | spike `results/` |
| MiniCPM5-2B (community ONNX only, q4f16 ~1.83 GB) | Apache-2.0 | candidate, not qualified: no official WebGPU export; tool tags are special tokens and need a dedicated parser | `notes/surveys/small-models-survey.md` |

Delivery: weights come from the BayLeaf HF gateway
(`api.bayleaf.dev/hf`, issue #121), which mirrors an approved release; the page checks
every file against `models.lock.json`, and `deploy.mjs` checks the gateway's catalog
agrees with the lock. A model ships only if it is pinned here and approved there.

License intake is a human gate: a non-permissive license, like the one that ships today,
stays in use only by Adam's explicit decision, recorded here.

## License decisions

- Pending, Parakeet TDT 0.6B v3 (CC-BY-4.0): permissive; redistribution needs attribution,
  a link to the license and a note of changes, which the gateway release records
  (`api/src/hfReleases.json`: README and ATTRIBUTION served with the weights) and Pouch
  shows wherever it offers the model. Needs Adam's approval with the gateway release.

- 2026-11-01, LFM3-1.7B (LFM Open License v1.0): accepted by Adam on a non-commercial
  reading. BayLeaf is a free, gift-funded campus service operated by one faculty member;
  Pouch charges nothing and sells nothing. Revisit if BayLeaf's funding or operator changes.
