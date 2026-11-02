# Pouch: ubiquitous language

Status: adopted (Adam). Code, interface text, prompts and docs use these terms;
"Retired terms" lists the words they replaced, which `test/ul-node.mjs` keeps out of
first-party code. *Open* marks questions still unresolved; the decisions log records the
decisions that still hold (git history keeps the rest).

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
Control plane (/session, /task) = the files through which the Interface, the terminal and agents act
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
| The user's machine | **Localhost** | built | an OpenAI-compatible server on loopback: oMLX, Ollama, LM Studio, or a proxy the user runs and verifies themselves (e.g. to their own Tinfoil account). `src/localhost.ts` |

Excluded by policy: any non-localhost endpoint other than BayLeaf. Pouch does not
integrate third-party services directly (not even personal Tinfoil accounts); users
who want one route it through a localhost proxy they control. What a localhost server
forwards to is the user's choice and responsibility.

Localhost consequences: `connect-src` gains `http://localhost:*` and
`http://127.0.0.1:*` as a permanent, documented exception (a CSP is fixed per build,
not per user); `http://[::1]` is not possible, because CSP host sources cannot name IPv6
literals, so Pouch accepts only `localhost` and `127.0.0.1`; Chrome's Local Network Access
permission adds a browser-side gate; loopback HTTP is allowed from an HTTPS page; the local
server must allow the `https://pouch.bayleaf.dev` origin (CORS), documented per server
(README "Localhost").

**Harness.** What turns a model into an agent: the step loop, prompt assembly, tools,
limits, message queues and persistence. A harness is an **engine** plus a **profile**.
- *Engine*: pi-durable, extended by Pouch (routing, join, detach, caps, per-path
  write serialization).
- *Profile*: the prompt, tool set, limits and namespace defaults. Five exist, named in
  `src/profiles.ts` (main, subagent, oneshot, transformersjs, localhost):

  | Profile | Tools | Loop | Limits |
  |---|---|---|---|
  | main | full set incl. subagent, watch, run | multi-step | allowance |
  | subagent | trimmed (list, message, join) | multi-step | per-pair caps |
  | one-shot | none | exactly one call | 1 request |
  | Transformers.js (LFM3) | 4 qualified tools, tested recipe | multi-step | 8 steps, ~4k context |
  | localhost | main's prompt and tools minus subagent and agents | multi-step | 24 steps, no allowance |

  Localhost has one profile for every model so far: the server's own chat template does
  the per-family work that LFM3 needed a recipe for. A model family that needs more gets
  its own entry, as LFM3 did.

**Context.** What the model actually receives on a given step: system prompt, loaded
skills, the surviving turns of its thread's current branch, tool results, steers,
follow-ups, peer messages. Context is not the Thread: the system prompt is never shown,
compaction shrinks context while the thread keeps everything, and a revert changes
context without erasing the thread's history. The interface shows its size as the **context
meter** (about how many tokens the next request carries; `src/context.ts`); on Transformers.js,
**trimmed** means the provider left part of the context out to fit its budget.

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

**Blank session.** Where New session (and `/new`) brings you: an empty transcript and
the composer, with nothing stored and no sidebar row. The first send makes it a Session.
Not a "draft", which is the composer's unsent text (a blank session can hold one).
Reverting a session's first message also leaves a blank session.

**Workspace.** The files Pouch works on. At most one per browser; Pouch starts with
none, and Erase all returns to none. Shared by all sessions.

**Namespace.** One agent's view of the Workspace (mounts, read-only layers, /task).
What an agent can see is what it can touch; namespaces do not govern the network.

**Interface.** How a person perceives and acts on sessions, threads, agents and the
workspace: the Pouch page. *Open:* name the agent-facing counterpart (tools and /task
files, through which agents perceive the same things): "Surface", "Tools", or nothing.
In code, the Interface is `src/main.ts` composing its **regions** (`src/interface/*.ts`,
README "Architecture"); a region reaches another only through its interface on `app`,
whose type `App` composes the regions' interfaces.

**Egress module.** A module allowed to use the network, each for one stated reason (Sealed
ciphertext, the BayLeaf API account plane, the `bayleaf` command, Localhost, hash-checked
weights and runtimes, the offline copy). The build fails if any other module uses a network
API (`arch.mjs`). Distinct from egress *consent* (`src/egress.ts`): which requests the
`bayleaf` command may make, as a person granted them.

**Core.** The modules that work without a page: files, namespaces, storage, providers and
sandboxed runtimes (`CORE` in `arch.mjs`). The core never imports the Interface; it is what
the trusted core of #143 would replace, one boundary at a time.

**Contract.** A types-only module stating what crosses a boundary (a worker's messages, the
trust-boundary data in `src/trust.ts`, the `App` the regions share): no code, imported only
as types, so it may cross a seam but never a layer (`CONTRACTS` in `arch.mjs`).

**Show.** The agent's act of putting a file or folder in front of the person (bash
`show <path>`, `src/open-cli.ts`). Its counterpart is **Open**, the person's act (the
terminal's `open`, a link, a click in Files): different verbs because they carry different
authority. The politeness rule: show opens it at once only when that would not get in the
person's way; with unsaved edits, a dialog open, a touch of the page in the last few seconds
(`SHOW_QUIET_MS`, 4 s), or a subagent asking, it is *offered* instead, as a card with an Open
button in the transcript. Either way the Thread records the showing. Never Interactive:
scripts run only by a person's choice. *For now:* the rule is provisional, pending experience.

**Control plane.** The files through which anything that acts is controlled:
`/session/<sid>/agents/a<n>/{status,ctl,in,last,ns}`, `/session/<sid>/{usage,changes}` (what an
agent reads about itself: its allowance and requests, and what it changed this turn), `/session/events`, and `/task` for runs,
terminal commands and watches (README "Control plane", `src/ns/control.ts`). The Interface is
one client of it, the terminal another, the main agent a third; what a write does is the same
whoever wrote it. Who may write what is the Namespace they were handed (the main agent sees
only its own session and may not write `in`; subagents see none of it). Not the Thread: the
transcript is content, not control state. Partly answers open question 1: agents act through
tools and the control plane, and perceive through the same files.

## Messages to a working agent

**Steer.** A message delivered into the running turn, read after the current step. As a file:
`steer` written to the agent's `in`.

**Follow-up.** A message meant for after the turn ends. Delivered by queuing; "queue"
is the strategy, not the name. (Replaces "Queue" in the interface.)

## Handles

Agents have names (judge-evidence) and session-local handles **a1, a2, ...** (main is
a1), replacing s1, s2. Handles mean nothing outside their session: wherever an agent
appears outside its own session view, it is prefixed with the session title
("Essay review › judge-evidence").

## Retired terms

| Was | Now | Where |
|---|---|---|
| handles s1, s2, ... | a1 (main), a2, ...; tags `[from judge-evidence (a3)]` | `src/graph.ts` (`MAIN`, `asRef`, `refOf`, `migrateRows`), prompts, tools, views |
| "lane", "Sealed lane", "Local lane", "Local: ..." | Provider: **BayLeaf Sealed**, **Transformers.js**; picker groups by provider | interface, harness notes, docs; CSS `--provider-sealed`, `--provider-tjs` |
| "Queue", "Queued · after this turn" | **Follow-up**, "Follow-up · after this turn"; send mode value `followup` | split button, menu, setting, tray, announcements |
| "sessions of this scope" (agent-facing) | "agents of this session", "by handle" | `agents`/`subagent` tool text, `GRAPH_GLOSS`, errors |
| profiles implicit in agent.js, subagents.js, local/ | `src/profiles.ts`: `PROFILES`, `profileOf()`, the transformersjs recipe (moved byte for byte; values checked identical) | `src/subagents.ts` and `src/local/provider.ts` read it |
| pi-durable "conversation"/"session" read as a Pouch session | anti-corruption table at the top of `src/agent.ts` (conversation = Thread storage, whenBusy steer = Steer, held input = Follow-up) | `src/agent.ts` |
| sidebar "Subagents of ..." | "Agents in ...", each "Agent scout (a2), a subagent of main" | `src/sessions.ts` |
| a subagent's approval sheet "subagent x · session: T" | "T › x (subagent)" | `src/egress.ts` |
| internal `lane()`, `laneOf`, `queued`, `childQueue`, `userQueued` | `openDb()`, `dbOf`, `followUps`, `childFollowUps`, `followUpHeld` | code |

Upgrade: stored data is read in both forms, never rewritten in bulk. Registry rows go
through `migrateRows` on every read (handles, edge-count keys, wake marks, labels) and
are stored in the new form on the next write; watch owners, stored peer messages and
report labels are mapped as they load; the saved send mode "queue" is rewritten to
"followup" at startup. Tools accept old handles (an agent copying `s3` from an old
transcript reaches a3). No IndexedDB version bump was needed. `test/upgrade-browser.mjs`
makes a profile with the old build and reads it with the new one; `test/ul-node.mjs`
scans first-party code for the retired terms.

Deliberately left:
- Old transcripts keep their text: the model context of an existing thread still holds
  `[from x (s2)]` tags and the old prompts; only labels the page draws are mapped.
  Rewriting stored model content would change what the agent saw.
- The qualified Transformers.js prompt, few-shot turn and tool descriptions are
  unchanged (moved, not edited), so the T3 qualification stands. Its harness notes
  (step cap, refused tool, shortened context) now say "Transformers.js"; they are not
  part of the qualified recipe text.
- Internal identifiers that name the code module, not the term: `src/local/`,
  `isLocal`, `LOCAL_*`, model ids `local:...`, provider id `pouch-local`, the Cache
  Storage name `pouch-local-models` and the setting key `sealedModel`. Renaming them
  breaks stored model ids and caches for no reader's benefit.
- Storage keys (`conversation:<sid>`, database names) and pi-durable's own words inside
  `src/agent.ts` and `src/subagents.ts`, behind the anti-corruption table.
- `src/graph.ts` keeps `createScope`/`MAX_SCOPE_MESSAGES` as code names for one session's
  routing state.
- The API's own "plaintext lane" (an api.bayleaf.dev term) keeps its wording.

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
- 2026-11-01: Control plane adopted (Adam): the file tree is the authority for everything that acts; the Interface is one client among several.
- 2026-11-01: Show adopted (Adam): the agent shows, the person opens; show opens unless the person is busy, else offers (provisional).
- 2026-11-01: Egress module, Core and Interface regions built with #144: `src/egress.js` holds consent, `NETWORK` in `arch.mjs` inventories the egress modules, and the build checks both.
- 2026-11-02: Pouch's sources are strict TypeScript (#143's step 2), with no change in behavior; trust-boundary data and worker messages are typed **contracts** the build checks.
