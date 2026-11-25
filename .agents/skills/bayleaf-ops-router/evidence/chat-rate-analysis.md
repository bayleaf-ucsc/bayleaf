# Run evidence: chat-rate-analysis

Dated record of past runs of [`chat-rate-analysis.md`](../playbooks/chat-rate-analysis.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-10-27: Initial read-only metadata scan covered 586 accounts and 643 chats;
  excluded the synthetic probe and deduplicated 38 message IDs (one conflicting
  timestamp). No raw message text or identifying rows persisted. Compared 30/90
  days and user/assistant proxies; saved the rerunnable script with live-valve
  discovery and deterministic duplicate handling. The original scan used fixed
  thresholds; the saved script's live-valve path has synthetic tests but has not
  been rerun against production. No limit change was authorized by this analysis.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Frontmatter status:

```text
status: practiced
```

Read volume:

```text
transient HTTP retries. The first run needed about 1,250 reads for 586 accounts
and 643 retained chats. Rate-limit or transport
```

Recording step:

```text
After a run, append a short refinement entry with coverage/caveats and recipe
changes. Record code/docs
```
