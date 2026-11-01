# Steer vs queue vs interrupt: mid-turn messaging survey (2026-10-30)

Research for BayLeaf Pouch's composer. Read-only survey from primary sources (official docs, source on GitHub, keybinding files). Web search was down for this session (HTTP 404), so everything here comes from fetching docs and source directly. Raw fetched copies are in `/tmp/pouch-qa/src/`.

## Terms

- **Steer**: the message goes into the running turn and the agent reads it at its next step boundary, usually after the current tool call(s) finish. No new turn starts, and in-flight work is kept.
- **Queue / follow-up**: the message waits until the whole turn ends, then starts a new turn.
- **Interrupt-and-send / Stop and Send**: abort the turn now, then send.
- Vocabulary is not shared across tools. Claude Code says "queue" for something that behaves like steering. Cursor's "Send now" means steer in one place and "send immediately, bypassing the queue" in another. Codex's API calls steering `turn/steer`.

## Per-tool findings

### Claude Code CLI (docs current 2026-10; features cite v2.1.275 and v2.1.281)
Source: https://code.claude.com/docs/en/interactive-mode (sections "Queue messages while Claude works", "When Claude Code sends what you queued", "Take back what you queued"); https://code.claude.com/docs/en/keybindings
- **Enter while busy** *queues* the message, but if Claude is running tool calls, it "passes it to Claude as soon as those tool calls finish, within the same turn." So the label says queue and the behavior is steering. Messages still waiting when the turn ends go out automatically, in order. Slash commands and `!` shell commands wait for the turn to end.
- **Ctrl+Enter** (or Ctrl+X Ctrl+S, the `chat:sendNow` action, v2.1.275+): sends the queue plus the current draft right away. Since v2.1.281, any shell commands or subagents that can move to the background do so and Claude reads the message in the same turn; otherwise it interrupts. Terminals without extended key reporting see Ctrl+Enter as plain Enter.
- **Ctrl+X Enter** (`chat:queueSubmit`): marks the message to "wait its turn" and never interrupt.
- **Esc**: interrupts the turn. "Claude Code keeps what you queued and sends it right away."
- **Visual**: queued and unstarted messages appear gray in the transcript until Claude starts responding to them.
- **Edit/cancel**: pressing Up from the first line pulls every queued entry back into the input, one per line, and Enter re-queues them as one entry.
- **Configurable**: Enter can be rebound to `chat:queueSubmit` or `chat:newline` in keybindings.json.

### Claude Code Desktop / web / mobile
Sources: https://code.claude.com/docs/en/desktop (line "redirect Claude at any point"), https://code.claude.com/docs/en/claude-code-on-the-web ("Take back a queued message"), https://code.claude.com/docs/en/mobile
- Desktop: Enter sends a correction "without stopping the running action. Claude reads the correction as soon as the current action completes." That is steering. Interrupting is the Stop button.
- Web: messages sent while Claude works queue "until Claude reads it", and an ✕ on the queued message returns its text to the message box.
- Mobile: docs mention steering but give no specific UI. **No steer/queue toggle is documented on any of these surfaces.**

### OpenAI Codex CLI (docs 2026-10)
Sources: https://learn.chatgpt.com/docs/developer-commands.md?surface=cli ("Interactive shortcuts"); https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer.rs (module doc)
- **Enter** while working: "inject new instructions into the current turn" (steer).
- **Tab**: queue a follow-up prompt, slash command, or shell command for the next turn. When idle, Tab submits like Enter, so input is never dropped. Queue keys are configurable in the keymap (`keymap.composer.queue`). The source still has a stub for the removed steer-mode flag: steering used to be opt-in and is now always on.
- Esc Esc with an empty composer edits the previous message and forks the chat.
- Changelog: "Prevented queued agent messages from restarting work after an interrupt or a switch to Plan mode" (PR #56330). After an interrupt, queued items no longer fire automatically.
- `codex queue --thread <id> --message ...` queues from outside the TUI.

### Codex in the ChatGPT desktop app and the IDE extension
Sources: https://learn.chatgpt.com/docs/prompting ("Steering and queuing"); https://learn.chatgpt.com/docs/reference/settings ("Follow-up behavior"); IDE settings table (`chatgpt.followUpQueueMode`), all in https://learn.chatgpt.com/docs/llms-full.txt
- Settings > General > **Follow-up behavior**: steer or queue. "The setting also shows the shortcut for using the other behavior for one message."
- "Queued messages appear above the composer, where you can edit, reorder, send, or delete them."
- IDE: `chatgpt.followUpQueueMode`, **default `queue`**. The legacy value `interrupt` now maps to `steer`. **Cmd/Ctrl+Shift+Enter inverts the behavior for one message.** Separately, `chatgpt.composerEnterBehavior` controls whether Enter or Cmd/Ctrl+Enter sends.
- The iOS Remote app added follow-up behavior settings in June 2026. The API has `turn/steer`, which appends to the in-flight turn, emits no new `turn/started`, and accepts no turn-level overrides.

### Cursor (docs 2026-10)
Source: https://cursor.com/docs/agent/overview.md ("Queued messages", "Steer a running agent")
- IDE agent: **Enter queues**. Queued messages show in order below the active task and can be **dragged to reorder**. **Cmd+Enter sends immediately**: the message is appended to the latest user message and attached to tool results.
- Newer behavior on cursor.com/agents, rolling out to the Agents Window: a **"Send now"** button or **Enter twice** steers at the next tool call; **Tab** queues for after the turn.
- Cursor CLI: Enter steers at a safe boundary, and Enter again interrupts.
- Cloud Agent API: "send a follow-up or steer" endpoint.
- Cursor is mid-migration, so different surfaces disagree.

### GitHub Copilot agent mode in VS Code (1.109.3, Feb 2026, experimental; Copilot CLI sessions added in 1.112)
Sources: https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_109.md, v1_110.md, v1_112.md; https://github.com/microsoft/vscode-docs/blob/main/docs/chat/chat-overview.md; https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatQueueActions.ts
- While a request is running, **the Send button turns into a dropdown**: **Add to Queue** / **Steer with Message** / **Stop and Send**.
- `chat.requestQueuing.defaultAction` = `steer` **(default)** or `queue`. Enable with `chat.requestQueuing.enabled`.
- Keys (source): **Enter = the default action, Alt+Enter = the other one.** The Queue action has Enter when the default is queue and Alt+Enter otherwise, and Steer mirrors it. No default key for Stop and Send was found.
- Steer "signals the current request to yield after finishing the active tool execution."
- Pending messages support drag reorder, Edit, Send Immediately, Remove from Queue, and Remove All Queued.
- 1.110: an **aria-status announcement for screen readers when steering occurs**. Steering is allowed while the ask-questions carousel is open.

### Windsurf / Cascade
Source: https://docs.windsurf.com/windsurf/cascade/cascade.md ("Queued Messages")
- Enter while working **queues**. "Press Enter again on an empty text box to send it right away" (send immediately). Messages can be deleted from the queue.
- No steer mode and no setting documented.

### Zed agent panel (docs current)
Source: https://github.com/zed-industries/zed/blob/main/docs/src/ai/agent-panel.md ("Queueing Messages")
- Messages sent while generating are **queued by default**. A **per-message "Steer" toggle** delivers the message at the next step, between a tool call and the response. This works only for the native Zed Agent, not external ACP agents, because Zed can't see their turn boundaries.
- Edit or remove one or all. "Send Now" (double Enter) on a queued message, or the Stop button, interrupts immediately.

### OpenCode
- **Web/desktop app** (`dev` branch, fetched 2026-10-30). Sources: https://github.com/anomalyco/opencode/blob/dev/packages/app/src/settings/model.tsx, `settings/general/general.tsx`, `session/composer/queue-panel.tsx`, `runtime/i18n/en.ts`.
  - Setting **Follow-up behavior: Queue | Steer, default `steer`**. The description reads: "Use {{keybind}} to switch", with keybind **Mod+Enter**, which inverts the setting for one message.
  - The queue panel shows "{n} queued", a per-row **Steer** button (tooltip "Send without interrupting", labeled "Send" when idle), Edit, Remove, Undo, and Reorder.
  - Shell commands cannot be queued: "runs now or not at all".
  - A steer sent while blocking shells or subagents are running moves them to the background, "like iOS".
  - History: a May 2026 snapshot force-migrated `queue` to `steer`. Queue was briefly removed, then restored.
- **TUI** (local snapshot 2026-05-31, `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`): user messages newer than the pending one get a **QUEUED** badge. The server loop picks them up at the next step, so they behave like steers. Esc is `session_interrupt`.

### pi coding agent (earendil-works/pi, formerly badlogic/pi-mono)
Sources: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md ("Change direction"); .../docs/keybindings.md
- **Enter while working = steer**: "waits until the current response and its tool calls finish, then guides the next response."
- **Alt+Enter = follow-up** (`app.message.followUp`; Ctrl+Q on Windows and WSL because Windows Terminal reserves Alt shortcuts): waits until Pi finishes the whole task.
- **Alt+Up** (`app.message.dequeue`; Alt+Q on Windows) restores queued messages to the editor. **Escape** aborts. "Aborting returns queued messages to the editor."
- Shift+Enter or Ctrl+J inserts a newline. All bindings can be remapped in keybindings.json.

### Gemini CLI (model steering is experimental)
Sources: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model-steering.md; .../docs/reference/keyboard-shortcuts.md
- **Tab** = `input.queueMessage` (process after the current task). Enter = submit. Newline is Ctrl/Cmd/Alt/Shift+Enter or Ctrl+J. Alt+Enter is taken by newline.
- With `experimental.modelSteering: true` (off by default), any text you type and send with Enter while the agent works becomes a **steering hint**. A small fast model posts a one-sentence acknowledgment, and the hint is injected with instructions to re-plan, delivered at the start of the next model turn.

### Amp (docs current)
Sources: https://ampcode.com/docs/markdown/prompting ("Queueing Messages"); https://ampcode.com/docs/markdown/cli/keybindings
- Enter **steers by default**, delivered after the current step (a command or a thinking block).
- To queue for the end of the turn: **Cmd/Ctrl+Enter on the web**, **long-press the send button on iOS**, or the Ctrl+O palette command "prompt: queue message" in the CLI.
- Enter Enter on a queued message steers it sooner. Esc Esc forcibly stops and sends now.
- Setting: Settings > Composer & Dictation > **Default Message Send Behavior**. Prompts Amp writes for you, such as Ship and Review, always queue.

### OpenChamber (main, fetched 2026-10-30)
Sources: https://github.com/openchamber/openchamber/blob/main/packages/ui/src/stores/messageQueueStore.ts; .../components/chat/ChatInput.tsx; .../components/chat/composer/DOCUMENTATION.md
- `followUpBehavior: 'steer' | 'queue'`, **default `queue`**. The legacy value `immediate` collapses to steer.
- Enter while busy follows the setting. **Ctrl/Cmd+Enter = plain send now**, bypassing queue and steer.
- While a turn runs and the composer has content, **a follow-up button sits above Stop** (inside the pill on collapsed mobile). In Queue mode it shows a rotated icon labeled "Queue message"; in Steer mode it looks like the normal send button.
- `QueuedMessagesStrip`: a single queued message gets its own row with **edit, send, remove**. Several collapse into an expandable count with drag reorder.
- On a mobile or expanded desktop composer, sending from the keyboard requires Ctrl/Cmd+Enter.

### Roo Code / Cline
Sources: https://github.com/RooCodeInc/Roo-Code/blob/main/CHANGELOG.md; https://github.com/cline/cline/blob/main/CHANGELOG.md
- Roo: message queueing added in 3.25.0 (2025-07-29), with images later and a delete-queued-message IPC in 3.48.1. A "POWER_STEERING" experiment was removed in early 2026. **Queue only, no steer.**
- Cline 4.1.7: "Preserve prompts queued during a turn when that turn is interrupted: they survive aborts, are drained after a turn aborts itself, and the stop is surfaced instead of the queue being silently dropped."
- **Exact keys and UI were not verified for either.**

### Aider
Source: https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/commands.md
- Synchronous: no mid-turn send. Control-C interrupts, and the partial response stays in context.

### Goose, ChatGPT consumer chat, Claude.ai consumer chat
- **Goose: not verified.** The fetched docs mention no mid-turn queue or steer, and the changelog URL returned 404.
- **ChatGPT**: the ChatGPT desktop app with Codex has the Follow-up behavior setting (see the Codex section). Plain ChatGPT chat mid-turn sends: **not verified**.
- **Claude.ai consumer chat: not verified.** The steering documented above is for Claude Code sessions opened in the claude.ai or Claude mobile apps.

## Convergences and conflicts

1. **Steer is becoming the default for Enter.** Steer by default: Codex CLI, VS Code Copilot, OpenCode web, Amp, Cursor CLI and cloud, pi, Claude Code (in effect, at tool boundaries), and Gemini when its experiment is on. Queue by default: Cursor IDE, Windsurf, Zed, OpenChamber, the Codex IDE extension (`queue`), and Roo. Terminal and agent-native tools lean steer; IDE chat panels that grew out of chat lean queue.
2. **Delivery boundary**: almost everyone delivers a steer after the current tool call or step, not mid-token. Newer refinements move running shells and subagents to the background so the steer lands sooner (Claude Code v2.1.281, OpenCode).
3. **A setting plus a one-message invert** is the mature pattern: Codex app and IDE, VS Code, OpenCode, Amp, OpenChamber. The invert key varies:
   - Alt+Enter: VS Code, pi
   - Mod+Enter: OpenCode (invert), Amp web (queue)
   - Cmd/Ctrl+Shift+Enter: Codex IDE
   - Tab: Codex CLI, Gemini CLI, Cursor web (queue)
4. **Mod+Enter is the most overloaded binding.** It means invert (OpenCode), queue (Amp), send now / interrupt (Cursor IDE, Claude Code, OpenChamber), newline (Gemini), and send when "modifier to send" is on (Codex app, OpenChamber mobile). Avoid giving it a steer or queue meaning.
5. **Tab** is a terminal convention. In a browser it moves focus, and hijacking it breaks keyboard accessibility (WCAG 2.1.2 No Keyboard Trap risk).
6. **Double-Enter / Enter Enter** to escalate (Windsurf, Cursor, Zed, Amp) is not discoverable, risks accidental sends, and doesn't work on touch.
7. **GUI pattern**: the Send button turns into a dropdown or split button while busy (VS Code: Queue / Steer / Stop and Send). Queued items sit in a tray above or below the composer with Edit / Send-or-Steer now / Remove (Codex app, VS Code, OpenCode, OpenChamber, Zed).
8. **On interrupt, behavior diverges.** Claude Code auto-sends the queue after Esc. pi returns queued messages to the editor. Codex stopped auto-restarting after an interrupt. Cline preserves the queue and surfaces the stop. The trend is toward never losing a queued message and never letting it silently restart work after the user pressed Stop.
9. **Mobile**: Amp iOS uses long-press on send (hidden). OpenChamber puts a follow-up button in the pill next to Stop. The iOS Codex app has a settings toggle. No tool documents an accessible touch invert other than a visible button or menu.

## Browser and OS hotkey notes for Pouch

- **Option/Alt+Enter on macOS**: Option combined with *letters* produces characters on the US layout and others (Option+E is a dead key, and so on). For Enter, the browser reports `key: "Enter"` with `altKey: true`, and the default action in a textarea is a plain line break, not a special character. Calling `preventDefault()` on keydown is enough. Unlike Option+B/F in terminals, this does not require "Option as Meta". **This is my reading of the platform and was not tested in this session; Pouch QA should check it in Safari, Chrome and Firefox on macOS.**
- **Windows/Linux**: AltGr is reported as Ctrl+Alt. Accept Alt+Enter only when `!e.ctrlKey && !e.metaKey`. Windows Terminal reserving Alt (the reason for pi's Ctrl+Q) does not apply inside a browser. Firefox's Alt-menu-bar toggle only fires when Alt is pressed and released alone. Alt+Enter in the *address bar* opens a new tab, but that doesn't affect page focus.
- **IME composition**: ignore Enter while `e.isComposing` or `keyCode === 229`, otherwise CJK input will send early.
- **Esc**: also exits fullscreen and closes dialogs. Bind stop-on-Esc only while focus is in the composer and no popup is open.
- **Touch keyboards** have no modifiers. Hardware keyboards on iPad and Android do. The per-message exception therefore needs a visible control.

## Recommendation for BayLeaf Pouch

**Default: Steer** (user setting "When I send while Pouch is working: Steer now / Queue for after").
- It matches pi-durable's Enter semantics, VS Code, Codex CLI, OpenCode, Amp and Cursor's direction, and what users intuitively expect ("I'm talking to it, it should listen").
- Make the setting prominent, because the IDE-style tools (Cursor IDE, Zed, Codex IDE, OpenChamber) default the other way.

**Keys** (desktop, composer focused, `!isComposing`):
- **Enter**: send with the default (Steer). Shift+Enter: newline.
- **Alt/Option+Enter**: send with the other mode for this one message. This is the pi and VS Code binding, so Pouch's runtime and the largest IDE agree. Optionally add **Mod+Shift+Enter** as an alias for Codex IDE habits.
- Do **not** give Mod+Enter a steer or queue meaning (see conflict 4). Do **not** use Tab (focus) or double-Enter (accidents, touch).
- **Esc** while busy: Stop, the same action as the Stop button.
- **Alt/Option+Up** (pi's dequeue): pull the queued message back into the composer for editing.
- Show the active keys in the button's accessible description and in a one-time hint.

**Composer affordance while busy:**
- Draft empty: show only **Stop**.
- Draft non-empty: show a **split button** next to Stop (do not replace Stop).
  - The primary segment's visible label is the mode: **"Steer"** (icon: curved arrow into a line) or **"Queue"** (icon: list-plus).
  - The 44×44 chevron segment opens a menu with radio-style items: "Steer now: Pouch reads this after its current step", "Queue for after: starts when this turn ends", and "Stop and send". The menu links to the setting.
  - Primary `aria-label`: "Steer: send into the current turn (Enter). Alt+Enter to queue instead."
  - Use this one control on both phone and desktop. No long-press-only path and no hover-only tooltips.
- When idle, the split collapses back to a plain Send.

**Activity tray rendering (before delivery):**
- **Steer pending**: a row with a chip "Steering · after current step", the text excerpt, and **Cancel** (returns the text to the composer). It disappears once delivered.
- **Queued**: a row with a chip "Queued · after this turn", plus **Edit** (back into the composer), **Steer now** (promote to the steer queue), and **Cancel**.
- Pouch holds one queued slot. If the user queues again while it is full, append to that item with a blank-line separator and announce "Added to queued message", following Claude Code, which merges entries on take-back. Don't silently replace.
- Announce changes through an `aria-live="polite"` region ("Steering message will be read after the current step", "Queued for after this turn", "Steering delivered"), following VS Code 1.110.

**Transcript after delivery:**
- A delivered steer is a user bubble placed where it entered the turn, between tool steps, with a small label **"Steered mid-turn"** (visible text, not only an icon). Precedents: Claude Code grays undelivered messages; Gemini acknowledges hints.
- A delivered queued message is an ordinary user bubble that starts a new turn, with no label.

**Stop and errors:**
- Stop never sends anything automatically, following Codex PR #56330 and Cline 4.1.7.
- An undelivered steer becomes the queued item, or returns to the composer if the slot is full. The tray then reads "Paused after Stop" with **Send** and Cancel.
- On error, keep both and surface them. Never drop text silently.
- "Stop and send" from the menu is the only path that aborts and sends together.

**Industry convention:** settings default plus a one-message invert on a modifier, a split or dropdown Send while busy, and a tray of editable, cancelable queued items with "send/steer now". The modifier itself has not converged. Alt+Enter is the best-justified choice for Pouch because pi uses it and VS Code uses it for the same meaning.
