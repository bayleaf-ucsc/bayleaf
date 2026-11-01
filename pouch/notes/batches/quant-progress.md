# LFM3 quantization experiment progress (2026-10-31)
- Variants at rev ab9fec4c: q4f16 1,088,085,770 B; q4 1,297,549,403 B; q8=model_quantized (TJS dtype q8 -> _quantized) 2,175,882,841 B; fp16 3,558,502,927 B (borderline; last, if disk/time).
- Harness: qualification/download-quant.py, worker-quant.js, quant.html, run-quant.mjs. Weights in ~/.cache/bayleaf-pouch/quant-exp/ (symlinked as assets-quant).
- 20:01 q4f16 perf done; matrix.sh launched (q4f16 agent, q4 perf/agent, q8 perf/agent). q4,q8 downloaded+verified.
- 20:03 Part B skipped: LiquidAI MLX builds are model_type lfm3; oMLX 0.7.2 bundles mlx-lm 0.31.4.dev without lfm3; model card says mlx-lm support in progress. summarize-quant.py written.
- 20:27 q4f16 agent: recipe 56/56, original 33/56. q4 agent: recipe 56/56, original 35/56. q4 weights deleted.
- 20:27 fp16 skipped: Cache Storage duplicates weights in profile (q8 profile 2.2 GB); fp16 needs ~7.1 GB with ~7.5 GB free after cleanup.
- 20:42 matrix done; quant.json written; quant-exp deleted, shipped q4f16 intact; server stopped.
