FROM python:3.11-slim
RUN pip install --no-cache-dir \
    fastapi==0.119.0 uvicorn[standard]==0.37.0 httpx==0.28.1 \
    httpx-ws==0.8.0 beautifulsoup4==4.14.2 html5lib==1.1 \
    cachetools==6.2.1 redis==6.4.0
WORKDIR /lab
CMD ["uvicorn", "lab:application", "--host", "0.0.0.0", "--port", "8080"]
