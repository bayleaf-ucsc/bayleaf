"""Fetch 20 MB published runtime and 16 MB diagnostic metadata, not full weights."""
from pathlib import Path
import io
import tarfile
import urllib.request

root = Path(__file__).parent
package = urllib.request.urlopen(
    "https://registry.npmjs.org/@wllama/wllama/-/wllama-3.8.1.tgz"
).read()
with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
    for member in archive.getmembers():
        if member.name.startswith("package/"):
            member.name = member.name[len("package/"):]
            if member.name:
                archive.extract(member, root / "vendor", filter="data")
url = "https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/main/LFM3-1.7B-QAD-Q4_0.gguf"
response = urllib.request.urlopen(urllib.request.Request(
    url, headers={"Range": "bytes=0-16777215"}
))
if response.status != 206:
    raise RuntimeError("Expected partial response, refusing full download")
header = bytearray(response.read(16777216))
print("Original tensor count:", int.from_bytes(header[8:16], "little"))
# Metadata-only negative test: avoid bounds validation of absent weight data.
header[8:16] = (0).to_bytes(8, "little")
(root / "model-header.gguf").write_bytes(header)
