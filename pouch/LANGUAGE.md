# Pouch: ubiquitous language

Status: adopted 2026-10-31 (Adam). Code, interface text, prompts and docs use these
terms; "Current leaks" records what the realignment changed. *Open* marks questions
still unresolved; the decisions log records how terms were chosen.

## The shape

```
Workspace (at most one per browser; starts at zero; Erase all returns to zero)
  files: /work, /pouch, seed layers
Session  (many; the scope for messages, joins and caps; all share the one Workspace)
  Agent: main           = Model via Provider + Harness (engine + profile) + Context
    Thread              = the human-facing record of this agent's turns (one per agent)
  Agent: chair ...
    Thread
  Namespace (per agent) = that agent's view of the Workspace: its capabilities
Interface               = how a person perceives and acts on Sessions and Threads
```

## Terms

**Model.** The weights that predict tokens. Examples: glm-5-3, LFM3-1.7B.

**Provider.** Who runs a model, and how Pouch reaches it. Replaces "lane". Named
specifically (what Pouch integrates with), not by category. Every provider sits under
one of the three things BayLeaf asks users to trust: **BayLeaf** (Adam, the operator),
**their browser**, and **their own machine**. Pouch puts BayLeaf in a privileged
position; that is expected and stated.

| Trust root | Provider | Status | Behind it |
|---|---|---|---|
| BayLeaf | **BayLeaf Sealed** | built | Tinfoil enclaves via api.bayleaf.dev; BayLeaf relays ciphertext it cannot read |
| The browser | **Transformers.js** | built | Transformers.js 4.3.2 on ONNX Runtime Web (WebGPU backend), in the page (LFM3) |
| The user's machine | **Localhost** | not built | an OpenAI-compatible server on loopback: oMLX, Ollama, LM Studio, or a proxy the user runs and verifies themselves (e.g. to their own Tinfoil account) |

Excluded by policy: any non-localhost endpoint other than BayLeaf. Pouch does not
integrate third-party services directly (not even personal Tinfoil accounts); users
who want one route it through a localhost proxy they control. What a localhost server
forwards to is the user's choice and responsibility.

Localhost consequences: `connect-src` gains `http://localhost:*` and
`http://127.0.0.1:*` as a permanent, documented exception (a CSP is fixed per build,
not per user); Chrome's Local Network Access permission adds a browser-side gate;
loopback HTTP is allowed from an HTTPS page; the local server must allow the
`https://pouch.bayleaf.dev` origin (CORS), documented per server.

**Harness.** What turns a model into an agent: the step loop, prompt assembly, tools,
limits, message queues and persistence. A harness is an **engine** plus a **profile**.
- *Engine*: pi-durable, extended by Pouch (routing, join, detach, caps, per-path
  write serialization).
- *Profile*: the prompt, tool set, limits and namespace defaults. Four exist today,
  unnamed in code:

  | Profile | Tools | Loop | Limits |
  |---|---|---|---|
  | main | full set incl. subagent, watch, run | multi-step | allowance |
  | subagent | trimmed (list, message, join) | multi-step | per-pair caps |
  | one-shot | none | exactly one call | 1 request |
  | Transformers.js (LFM3) | 4 qualified tools, tested recipe | multi-step | 8 steps, ~4k context |

  A Localhost provider will likely need its own profile per model family, as LFM3 did.

**Context.** What the model actually receives on a given step: system prompt, loaded
skills, the surviving turns of its thread's current branch, tool results, steers,
follow-ups, peer messages. Context is not the Thread: the system prompt is never shown,
compaction shrinks context while the thread keeps everything, and a revert changes
context without erasing the thread's history.

**Agent.** A Model via a Provider, run by a Harness with its Context, acting inside a
Session. Agents act: they write, edit, delete and run things in the Workspace, and
can make network requests the user granted. The Interface must never present them as
harmless conversation partners. Every session has a **main** agent; others are
**subagents** (a role, not a different kind of thing).

**Thread.** The human-facing record of one agent's turns; one thread per agent. A
conversation-only **revert** branches within the thread: later turns stay visible as
an "other branch", and the agent's context follows the current branch. Files are not
reverted.

**Session.** The scope a person works in: one main agent, its subagents and their
threads. Sessions are the boundary for agent messages, joins and caps; they do not
own files (the Workspace is shared).

**Workspace.** The files Pouch works on. At most one per browser; Pouch starts with
none, and Erase all returns to none. Shared by all sessions.

**Namespace.** One agent's view of the Workspace (mounts, read-only layers, /task).
What an agent can see is what it can touch; namespaces do not govern the network.

**Interface.** How a person perceives and acts on sessions, threads, agents and the
workspace: the Pouch page. *Open:* name the agent-facing counterpart (tools and /task
files, through which agents perceive the same things): "Surface", "Tools", or nothing.

## Messages to a working agent

**Steer.** A message delivered into the running turn, read after the current step.

**Follow-up.** A message meant for after the turn ends. Delivered by queuing; "queue"
is the strategy, not the name. (Replaces "Queue" in the interface.)

## Handles

Agents have names (judge-evidence) and session-local handles **a1, a2, ...** (main is
a1), replacing s1, s2. Handles mean nothing outside their session: wherever an agent
appears outside its own session view, it is prefixed with the session title
("Essay review › judge-evidence").

## Current leaks (to realign later, not now)

| Today | Proposed |
|---|---|
| pi-durable "session" (one agent's persisted log) shown as a Pouch session; subagents listed as sessions | Thread storage; sidebar lists Sessions with Agents nested |
| handles s1, s2 | a1, a2 |
| "lane", "Sealed lane", "Local lane" | Provider: BayLeaf Sealed, Transformers.js |
| "Queue", "Queued · after this turn" | "Follow-up", "Follow-up · after this turn" |
| profiles implicit in agent.js, subagents.js, local/ | named profiles on one engine |

## Open questions

1. A name for the agent-facing interface, if any.
2. Does a coordinated pattern of agents (the review panel) need a term, or is it just
   a skill that creates agents?
3. Where skills and watches sit: a skill is Context; a watch belongs to an agent
   inside a session. Confirm.

## Decisions log

- 2026-10-31: Session, Agent, Thread adopted (Adam).
- 2026-10-31: Follow-up replaces Queue (intent over strategy).
- 2026-10-31: Provider replaces Lane; only high-security providers (attested remote,
  same device); no arbitrary remote endpoints.
- 2026-10-31: providers are named specifically: Transformers.js, not "in-browser".
- 2026-10-31: no direct Personal Tinfoil; users run a localhost proxy they control.
  Trust roots: BayLeaf, the browser, the user's own machine.
- 2026-10-31: one Thread per Agent; agents act and the interface must convey it.
- 2026-10-31: at most one Workspace; starts at zero; Erase all returns to zero.
