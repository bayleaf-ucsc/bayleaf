"""Tiny shared Google/Daytona substitutes, intentionally not full emulators.

The interpreter accepts two literal test commands, never arbitrary Python.
All data is synthetic and in-memory, lost when this container restarts.
"""

import uuid

from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse

app = FastAPI()
contexts = {}


@app.get("/health")
async def health():
    return {"fixture": True}


@app.post("/token")
async def token():
    return {
        "access_token": "synthetic-access-token",
        "scope": "https://www.googleapis.com/auth/calendar.readonly",
        "expires_in": 3600,
    }


@app.get("/google/calendar/v3/users/me/calendarList")
async def calendars(request: Request):
    if request.headers.get("Authorization") != "Bearer synthetic-access-token":
        return JSONResponse({"error": "invalid synthetic token"}, status_code=401)
    return {"items": [{"id": "synthetic-calendar", "summary": "Lab Calendar", "primary": True}]}


@app.get("/synthetic-sandbox/process/interpreter/context")
async def list_contexts():
    return {"contexts": [{"id": key} for key in contexts]}


@app.post("/synthetic-sandbox/process/interpreter/context")
async def create_context():
    key = str(uuid.uuid4())
    contexts[key] = {}
    return {"id": key}


@app.websocket("/synthetic-sandbox/process/interpreter/execute")
async def execute(ws: WebSocket):
    await ws.accept()
    message = await ws.receive_json()
    state = contexts[message["contextId"]]
    code = message["code"]
    if code == "x = 35":
        state["x"] = 35
    elif code == "print(x)" and "x" in state:
        await ws.send_json({"type": "stdout", "text": "35\n"})
    else:
        value = "name 'x' is not defined" if code == "print(x)" else "fixture only supports x = 35 and print(x)"
        await ws.send_json({"type": "error", "name": "NameError", "value": value})
    await ws.close()
