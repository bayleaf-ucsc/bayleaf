#!/usr/bin/env bash
# Same serving flags for each packaging arm. Pass the checkpoint directory.
set -euo pipefail
MODEL_DIR="${1:?usage: serve.sh /path/to/checkpoint}"
EXTRA=()
if [[ "${EAGER:-0}" == 1 ]]; then EXTRA+=(--enforce-eager); fi
date -u '+SERVER_LAUNCH=%FT%TZ'
exec vllm serve "$MODEL_DIR" \
  --served-model-name cyankiwi/Qwen3.8-27B-AWQ-INT4 \
  --host 127.0.0.1 --port 8000 \
  --tensor-parallel-size 1 \
  --language-model-only \
  --max-model-len 8192 \
  --max-num-seqs 8 \
  --gpu-memory-utilization 0.85 \
  --kv-cache-dtype fp8 \
  --reasoning-parser qwen3 \
  --enable-prefix-caching "${EXTRA[@]}"
