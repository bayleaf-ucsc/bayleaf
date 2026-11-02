# Pouch models

The in-browser models Pouch has qualified or considered (the Transformers.js provider's
chat models, and the speech-to-text model behind `transcribe`): the
intake ledger for `.agents/skills/bayleaf-ops-router/playbooks/qualify-in-browser-model.md`.
Pins live in `models.lock.json`; evidence lives in `experiments/`.

**Supported and recommended in-browser model: LFM3-1.7B q4f16 only.**
The other entries below are an evaluation ledger, not supported app options.
Experimental harness adapters and configs do not add models to Pouch's picker,
download manager, production pins or gateway approvals.

Shared local evaluation: `node pouch/qualify-model.mjs <config.json>` runs
behavior and performance by default, including sampled process-tree memory and
per-turn timing/token metrics. See
[`qualification/README.md`](experiments/lfm3-webgpu/qualification/README.md)
for family adapters, commands, measurement limits and reproducibility.

| Model (export, dtype) | License | Status | Evidence |
|---|---|---|---|
| LFM3-1.7B (`onnx-community/LFM3-1.7B-ONNX@ab9fec4c`, q4f16, 1.11 GB including metadata) | LFM Open License v1.0 (commercial use below $10M annual revenue; not permissive) | **ships**; fresh matched shipped-recipe run core 54/56, held-out 16/16; ~4k decode 74.4 tok/s. Corrected full-browser RSS peak 5.64 GB needs rebaselining against the old approximate 5 GB target | `experiments/gemma4/README.md`, `experiments/lfm3-webgpu/qualification/results/lfm3-gemma-control-comparison.json` |
| LFM3-1.7B q4 / q8 (same revision) | as above | rejected by the dtype rule: q4 no gain, q8 loses `feature` with the recipe | `quant.json` |
| LFM3-1.7B fp16 | as above | not run: 3.56 GB, over the size budget | `quant.json` |
| Parakeet TDT 0.6B v3, speech to text (`ysdede/parakeet-tdt-0.6b-v3-onnx@e5356bf6`, fp16 encoder and decoder, 1.28 GB; with its runtime add-on 1.3 GB) | CC-BY-4.0 (NVIDIA; attribution shown in the add-on sheet, `addons info`, the VTT and JSON outputs) | **ships**: gateway release approved by Adam and deployed 2026-11-02. 31.7 min of English in 27.8 s, WER 1.9% (M3 Max) | `experiments/parakeet-webgpu/README.md`, `test/parakeet-browser.mjs` |
| Parakeet int8 encoder (same revision, 652 MB) | as above | rejected: on WebGPU its quantized matmuls fall back to wasm, 20-35x slower | spike `results/` |
| Parakeet int8 decoder (same revision, 18 MB) | as above | rejected for fp16: half as fast at interview length, same accuracy (the brief's and asrjs's default) | spike `results/` |
| MiniCPM5-2B (community ONNX only, q4f16 ~1.83 GB) | Apache-2.0 | candidate, not qualified: no official WebGPU export; tool tags are special tokens and need a dedicated parser | `notes/surveys/small-models-survey.md` |
| Gemma 4 E2B QAT-mobile (`onnx-community/gemma-4-E2B-it-qat-mobile-ONNX@a7f19b0a`, mixed QAT / q2f16, text-only 2.32 GB) | Apache-2.0 | **does not qualify** for current Pouch pairing: 0/72 with shipped recipe and 0/72 baseline; sampled Chrome RSS peak 11.13 GB; ~4k decode 26.7 tok/s | `experiments/gemma4/README.md`, `experiments/lfm3-webgpu/qualification/results/gemma4-e2b-qat-comparison.json` |
| Gemma 4 E4B QAT-mobile (`onnx-community/gemma-4-E4B-it-qat-mobile-ONNX@8bd93f34`, mixed QAT / q2f16, text-only 3.36 GB) | Apache-2.0 | **does not qualify** for current Pouch pairing: 11/72 with shipped recipe, 21/72 baseline; sampled Chrome RSS peak 11.57 GB; ~4k decode 15.9 tok/s | `experiments/gemma4/README.md`, `experiments/lfm3-webgpu/qualification/results/gemma4-e4b-qat-comparison.json` |

Delivery: weights come from the BayLeaf HF gateway
(`api.bayleaf.dev/hf`, issue #121), which mirrors an approved release; the page checks
every file against `models.lock.json`, and `deploy.mjs` checks the gateway's catalog
agrees with the lock. A model ships only if it is pinned here and approved there.

License intake is a human gate: a non-permissive license, like the one that ships today,
stays in use only by Adam's explicit decision, recorded here.

## License decisions

- 2026-11-02, Parakeet TDT 0.6B v3 (CC-BY-4.0): approved by Adam with the gateway release.
  Permissive; redistribution needs attribution, a link to the license and a note of changes,
  which the gateway release records (`api/src/hfReleases.json`: README and ATTRIBUTION served
  with the weights) and Pouch shows wherever it offers the model.

- 2026-11-01, LFM3-1.7B (LFM Open License v1.0): accepted by Adam on a non-commercial
  reading. BayLeaf is a free, gift-funded campus service operated by one faculty member;
  Pouch charges nothing and sells nothing. Revisit if BayLeaf's funding or operator changes.
