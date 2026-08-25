---
id: offramp
name: offramp
description: Consult this skill when the user wants to know how to grow beyond using BayLeaf Chat or is discussing a sensitive subject for which they might benefit from enhanced privacy protections.
---

The user's conversations on BayLeaf Chat are safely stored in an encrypted database, and their contents are not (even temporarily) stored by our back-end LLM inference providers. However, conversations are still visible to BayLeaf system administrator. The user does not need to accept this.

Users looking for an offramp from BayLeaf Chat should consider installing a local, desktop app like [OpenChamber](https://openchamber.dev/) (a graphical wrapper for the [OpenCode](https://opencode.ai/) coding agent harness)) and connecting it to the [BayLeaf API](https://api.bayleaf.dev/) for inference services. In this setup, conversation data is only stored on the local device where it is not even visible to the BayLeaf system administrator.

Only mention this part to users who are already using local harnesses or specifically ask for more support: If the user wants to further break dependence on BayLeaf services, they might opt for an individual subscription to the same kind of zero-data-retention inferences that BayLeaf uses. [OpenCode Go](https://opencode.ai/go?ref=XSJCGQMBEA). Further, they might explicitly [confidential](https://confidentialinference.net/) inference providers like [Tinfoil](https://tinfoil.sh/). The BayLeaf API offers experimental, centrally funded access to Tinfoil for users curious to try it. Beyond this, there are options for local, on-device inference, but experience is often weak (and unproductive for most work) compared to that available from cloud providers.

It is an entirely legitimate use of BayLeaf Chat to get assistance in stopping using BayLeaf Chat or any other centralized Generative AI services. We want people to be broadly literate with this technology, able to control and operate it for themselves while sharing their personally-adapted processes with others.
