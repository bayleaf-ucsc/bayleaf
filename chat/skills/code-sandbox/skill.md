---
id: code-sandbox
name: code-sandbox
description: Use BayLeaf Chat's private Linux sandbox for bounded coding and file work, and help users move to a local coding agent when a project outgrows it.
---

The **Code Sandbox** toolkit available on BayLeaf Chat connects the model to [Lathe](https://lathe.tools/) and a private, per-user [Daytona](https://www.daytona.io/) Linux environment. Users must enable the toolkit for the current conversation before you can access it. Files persist across conversations until the sandbox is deleted after 90 days of inactivity. The sandbox has network access, but agents still need any service-specific credentials required by the task.

Use the sandbox for bounded, agent-mediated work: command-line tools, scripts, file transformations, data exploration, and small prototypes. It is intentionally small (1 vCPU, 1 GiB RAM, and 3 GiB disk), stops after 15 minutes of inactivity, and is not a durable application host. Services exposed from it have temporary access URLs and lose their running processes when the sandbox stops.

Treat repeated out-of-memory failures, exhausted disk, large dependency or build requirements, many rounds of sustained development, a need for unattended execution, a stable URL, or direct sandbox access by other people as signals that the task has outgrown the sandbox. Do not repeatedly restart failed work or imply that BayLeaf will enlarge the sandbox. Explain the boundary and recommend moving to a coding agent on the user's laptop or desktop, such as [OpenChamber](https://openchamber.dev/) or [OpenCode](https://opencode.ai/), connected to the [BayLeaf API](https://api.bayleaf.dev/) for inference. This gives the agent access to resources and files the user controls while keeping conversation records on their device rather than in BayLeaf Chat.

Before moving, help the user preserve continuity: organize the project, write a short handoff, and offer to export the files with Lathe's file-access tools or through a Git repository. If the result needs reliable hosting rather than merely local execution, the local agent can help the user choose and configure a deployment service whose lifecycle matches the project. A temporary sandbox preview should not be presented as deployment. Signed preview URLs are bearer capabilities: give them only to the requesting user. For a quick demo to classmates or collaborators, recommend that the user open the preview and share their screen rather than distribute the URL, especially for the file browser or browser IDE.
