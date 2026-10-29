# LFM3 browser WebGPU experiment

**Result: working browser generation, verified October 28, 2026.**

Isolated from Pouch's build and dependencies. No native inference or HTTP inference
server is used. Python serves static files only; model downloads come from Hugging
Face and runtime JavaScript comes from jsDelivr. Prompts stay in the browser.

## Run

```sh
python3 pouch/experiments/lfm3-webgpu/serve.py
```

Open <http://127.0.0.1:8768/onnx.html> and click **Load and generate**. This
downloads about 1.1 GB of model weights, cached by Transformers.js. The runtime is
`@huggingface/transformers@4.3.2`; the model is
`onnx-community/LFM3-1.7B-ONNX`, `q4f16`, explicitly `device: 'webgpu'`.
The external weight file is `onnx/model_q4f16.onnx_data`, 1,087,789,056 bytes.
The page records load time, output, generation time and first-token timing.

## Observed generation

Chrome `152.0.7977.167` on this Mac, WebGPU adapter vendor `apple`, architecture
`metal-3`, with `shader-f16` available. The model repository's main revision at
test time was `ab9fec4c681a25bec3b48b0b97a62fc2660a2985`.

Prompt: “What is the capital of France? Answer in one sentence.”

Output: **“The capital of France is Paris.”**

| Measurement | Cold run | Cached second run |
|---|---:|---:|
| Load, including first download | 33,781.69 ms | 897.39 ms |
| Generation, including prompt processing | 694.48 ms | 182.95 ms |
| First streamed token | 372.94 ms | 120.82 ms |
| Streamed token callbacks | 8 | 8 |
| WebGPU compute dispatches during generation | not instrumented | **2,633** |
| WebGPU queue submissions during generation | not instrumented | **212** |

The second run wraps the browser's real WebGPU compute-dispatch and queue-submit
methods immediately before generation. This establishes actual browser GPU work,
not merely a `device` string, CPU WASM generation, native Metal or HTTP inference.
CPU-side tokenization, sampling and graph orchestration are still normal parts of
the browser runtime; this is not proof every auxiliary graph operation runs on GPU.
Eight tokens are too few to claim a sustained decode benchmark.

No long-context, streaming cancellation, tool calls, phone compatibility or Pouch
integration has been qualified. The smallest next step is adapting this same
pipeline to a Pouch provider adapter, after a bounded multi-turn/tool-call trial.

Use `dist/transformers.js`, not `dist/transformers.web.js`: the latter leaves a
bare `onnxruntime-web/webgpu` import unresolved without a bundler/import map.

## Other routes checked

- **WebLLM/MLC:** upstream MLC's centralized model registry has no LFM3
  architecture. A renamed model or converted weight format alone cannot fix that.
  <https://github.com/mlc-ai/mlc-llm/blob/main/python/mlc_llm/model/model.py>
- **Browser llama.cpp:** wllama 3 does have real WebGPU support. However, npm's
  latest published version at the time of this experiment is **3.8.1**, released
  October 2, 2026. Its llama.cpp submodule is
  `46ca246de9bb1c35269722a6240d37d9dfd79cad`, before LFM3 support merged on
  October 27 in `19cce6919992fdffd92e0ac152caaf1e2b8f254e`.
  Even wllama master points to a pre-release llama.cpp revision (last sync October
  20). The master package.json version (3.12.0) is not the npm release version.
- **Rebuilding wllama:** no `emcc` installed and Docker's daemon is not running.
  Its provided builder uses Emscripten 4.0.20 in Docker. Stopped short of installing
  that toolchain. With a rebuilt latest-llama.cpp WebGPU WASM binary, LFM3's graph
  and actual GPU operation coverage still need testing: native support is not a
  browser qualification.
- **ONNX:** the community export documents Transformers.js >=4.3.2 WebGPU use.
  The official LiquidAI ONNX export also explicitly documents the WebGPU entry
  point, q4f16, and maximum 256-token prefill chunks. This experiment uses a short
  prompt only, not a long-context or Pouch tool-calling qualification.
  <https://huggingface.co/onnx-community/LFM3-1.7B-ONNX>
  <https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX>

## Optional wllama negative test

```sh
python3 pouch/experiments/lfm3-webgpu/prepare-wllama.py
```

Then open <http://127.0.0.1:8768/>. This fetches a 20 MB runtime and only the
first 16 MiB of `LiquidAI/LFM3-1.7B-GGUF/LFM3-1.7B-QAD-Q4_0.gguf`.
The diagnostic copy sets the GGUF tensor count from 287 to zero, retaining all
metadata, to get past truncated-tensor bounds validation. It is not a usable
model and must never be presented as a generation test. The observed error is:

```text
llama_model_load: error loading model: unknown model architecture: 'lfm3'
```

This negative test also initialized `ggml_webgpu` successfully on Apple
`metal-3` in Chrome 152. `metal-3` is the browser adapter's reported architecture,
not use of the native llama.cpp Metal backend.
