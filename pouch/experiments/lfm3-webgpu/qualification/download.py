"""Download public pinned runtime/model assets, recording bytes, hosts and SHA256."""
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlparse
import hashlib, json, concurrent.futures

ROOT = Path(__file__).parent
REV = 'ab9fec4c681a25bec3b48b0b97a62fc2660a2985'
ORT = '1.31.0-dev.20260914-8d85527a0'
items = [('runtime/transformers.js', 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.js')]
for name in ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']:
    items.append(('runtime/'+name, f'https://cdn.jsdelivr.net/npm/onnxruntime-web@{ORT}/dist/{name}'))
for name in ['config.json','generation_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','chat_template.jinja','onnx/model_q4f16.onnx','onnx/model_q4f16.onnx_data']:
    items.append(('model/'+name, f'https://huggingface.co/onnx-community/LFM3-1.7B-ONNX/resolve/{REV}/{name}'))

def get(item):
    name, url = item
    dest = ROOT/'assets'/name
    dest.parent.mkdir(parents=True, exist_ok=True)
    final_host = None
    if not dest.exists():
        with urlopen(url) as r, dest.with_suffix(dest.suffix+'.part').open('wb') as f:
            final_host = urlparse(r.url).hostname
            while block := r.read(4*1024*1024): f.write(block)
        dest.with_suffix(dest.suffix+'.part').rename(dest)
    h = hashlib.sha256()
    with dest.open('rb') as f:
        while block := f.read(4*1024*1024): h.update(block)
    return dict(path='assets/'+name,url=url,host=urlparse(url).hostname,download_final_host=final_host,bytes=dest.stat().st_size,sha256=h.hexdigest())

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    records = list(pool.map(get,items))
(ROOT/'assets-manifest.json').write_text(json.dumps(dict(model_revision=REV,ort=ORT,assets=records),indent=2)+'\n')
print(json.dumps(dict(files=len(records),bytes=sum(x['bytes'] for x in records))))
