# Rooms Durable Object spike: results (2026-11-11)

Local only (`wrangler dev --local`); not deployed. Code: `worker/src/index.js`
(Worker and Durable Object), `worker/client/y-bayleaf.js` (provider),
`worker/test/spike.mjs` (checks). Contract: `docs/rooms-v2.md`, `docs/rooms-v2-yjs.md`.

## Run it

```bash
cd rooms/worker && npm install && printf 'OWNER_TOKEN=dev-owner\n' > .dev.vars
npm run dev                        # terminal 1
node test/spike.mjs                # terminal 2: 41 checks
# stop and restart `npm run dev`, then:
node test/spike.mjs verify         # state survived the restart
```

## What passed

All 41 checks pass. The restart check last ran before the presence change.

- **Credentials:** bulk issue works, and a duplicate label is refused.
- **Concurrent editing:** two writers inserting at position 0 at the same time
  converge, with no arbiter. 600 interleaved keystrokes, one append each,
  converge too.
- **Compaction:** 602 appends compact to 5 entries.
- **Commons:** yjs entries carry no `cred`.
- **Abrupt disconnect:** edits made across it converge, and the peer sees each edit
  exactly once (outbox resend under the same idempotency key).
- **Fresh reader:** a read-only client starting from `after=0` matches the document.
- **Freeze:** it reaches open sockets and refuses writes. An edit that races
  the freeze stays queued and reaches peers after the unfreeze, along with later
  edits.
- **Unsyncable edit:** a 900 KB paste moves the client to `diverged`, empties its
  outbox, and never reaches peers.
- **Revocation:** it ends the socket with reason `revoked`.
- **About 1 MB document:** it reaches the reader, and the merged state takes the
  chunked path under the 2 MB row cap. Participant export (`format=yjs`) rebuilds
  the document in a plain `Y.Doc`. The state survives a wrangler restart.
- **Opaque room:** an idempotent retry returns the same `seq`. Redact keeps `seq` and
  `cred` and tombstones the data. A frozen room refuses appends. Deleting the room
  returns 404 afterward.

## Findings

1. **The close handshake bug (fixed).** Under the hibernation API, the Durable Object
   must call `ws.close()` in `webSocketClose`. Otherwise clients hang in `CLOSING`
   with a stuck outbox. The provider also gained `reconnect()`, which doesn't wait
   for the handshake.
2. **Batching makes compaction rare in practice.** With the provider's 250 ms batching,
   600 keystrokes became 10 appends. Compaction matters for long-lived rooms and
   unbatched clients, not for one typing burst.
3. **The 64 KiB entry cap broke large pastes in yjs rooms.** Resolved by
   DECISIONS.md item 8: the cap is now 1 MiB serialized for yjs rooms. A 600 KB paste
   syncs, and a 900 KB paste (1.2 MB once base64-encoded) is still refused.
4. **A provider must never drop an update (fixed).** Yjs needs each client's clock
   range to be contiguous. Peers park every later update from a client with a gap
   in `pendingStructs`, forever, with no error. The first provider dropped a
   refused update on 409, and the old freeze check passed only because that
   client never typed again. A new check (an edit during the freeze, then one
   after) failed against that provider. Now refusals split two ways. A 409
   (frozen) keeps the outbox, stops sending and reports `read_only`; the outbox
   is resent in order on unfreeze. A 413 or 403 means the edit can never sync:
   the client reports `diverged`, stops sending and keeps receiving, and the app
   reloads from the room. A client-side size check skips the doomed round trip,
   so the 900 KB check covers that path. The server-side 413 path in the
   provider is untested.
5. **Delta presence and opaque Awareness (new).** The server used to send the
   full peer list to every socket on every change. Now `ready` carries a
   snapshot, and each change sends one `presence` or `left` frame to the other
   sockets. In yjs rooms the state is a base64 y-protocols Awareness update that
   the server never decodes. Its last value sits in the socket attachment
   (capped at 1 KiB) so newcomers can catch up. Two reconnect bugs both came from
   one Awareness rule: a state re-sent at a clock the receiver has already seen
   is ignored, even after that state was removed. The fixes: reconcile peers on
   `ready` instead of wiping them, and re-announce at a new clock. The provider
   throttles to 4/s and always sends the last state. After a departure, the
   caret disappears in about 50 ms, instead of waiting for the 30 s timeout.
6. **Fan-out at audience scale is comfortable locally** (`test/fanout.mjs`, local
   workerd, loopback, one Node process). Setup: 150 phones on one shared write
   link, plus a read-role projector. All of them connected in about 0.6 s.
   Steady taps (about 29/s in total, 4,100 frames/s out) reached the projector at
   p50 6 ms and p99 14 ms. The burst (every phone within 2 s) sent exactly
   150 × 149 + 150 = 22,500 frames, 11,250/s, at p99 16 ms. Every tap was
   delivered, or refused by the 5/s presence limit and counted (about 4% of
   Poisson taps land within 200 ms of each other). For co-editing, 12 writers at
   2 keystrokes/s saw peer arrival at p50 258 ms, which is almost entirely the
   provider's 250 ms batch timer (transport adds about 8 ms). That suggests a
   leading-edge flush: send at once when nothing is in flight, batch only during
   bursts. These numbers are a lower bound on transport cost, not a production
   claim. Still unmeasured: real Durable Object CPU limits, phone networks, and
   send-only subscriptions.
8. **Tiptap 3 works on y-bayleaf with no build step** (`client/demo/editor.html`,
   `test/browser.mjs`, 23 Playwright assertions). Two isolated browser contexts
   converge, each shows the other's labelled caret, freeze locks both editors
   and unfreeze restores them, and exactly one Yjs and one copy of each core
   ProseMirror package load. A negative control without `?external=` loads two
   copies of Yjs (y-tiptap pulls 13.6.33), so the check is meaningful. No
   provider or server bugs; the doc gaps are folded into `rooms-v2-yjs.md`.
   Run it with wrangler on :8788
   (`--persist-to /tmp/rooms-browser-state`) and `python3 -m http.server 8790
   --directory client`.
9. **API revision after run 05.** Scopes replace roles. A presence-only link
   can signal, can't append, and keeps signalling while the room is frozen.
   `storageKey` fixes the collision between two links to one room on one device.
   Leading-edge batching sends a lone keystroke at once: co-editing peer latency
   fell from p50 258 ms to 9 ms (p99 22 ms) on the same `fanout.mjs` workload.
   Rooms now default to a fixed 30-day expiry. 41 checks pass, and the 23
   browser assertions still pass.
7. **Ordering is not authority.** The server's `seq` is only a delivery cursor in yjs
   rooms: the concurrent-insert test converged on the same text in different runs,
   with an order that differed from run to run.

## Not tested

- Real hibernation eviction (local workerd).
- Latency and fan-out on deployed Durable Objects (local numbers in finding 6).
- CodeMirror and BlockNote bindings (Tiptap 3 is covered by finding 8).
- IndexedDB offline persistence.
- CPU time of `Y.mergeUpdates` on large rooms.
- Real BayLeaf owner auth, quotas and rate limits.
- Idle reaping.
