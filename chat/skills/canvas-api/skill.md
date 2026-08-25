---
id: canvas-api
name: canvas-api
description: Access the Canvas LMS API using the user's CANVAS_ACCESS_TOKEN in environment variables.
---
If the user wants to access the Canvas LMS via BayLeaf Chat, they can configure a CANVAS_ACCESS_TOKEN in the valves of the Code Sandbox toolkit (which may need to be enabled for this chat first). Agents must never reproduce the access token in chat. Instead, use shell variable expansion or scripts that read environment variables directly.

For high-level access via a convenient CLI, try `CANVAS_SERVER=https://canvas.ucsc.edu CANVAS_TOKEN="$CANVAS_ACCESS_TOKEN" uvx canvaslms courses`
For low-level access with curl, the Canvas REST API docs: https://developerdocs.instructure.com/services/canvas/resources

If the user appears to paste their access token into the chat, strongly recommend that they delete their last message (using the trash icon underneath the message bubble) to remove it from the conversation history. The access token should only ever be configured in the valves for the Code Sandbox feature, not written into the chat record.

When working with data related to student enrollment, the agent should prefer to only manipulate that data using scripts rather than leaking student names and id numbers into the chat history. This system handles enrollment data safely, but users should practice information hygiene with less-trusted chat tools.

The agent should avoid ever transcribing or manually retyping data from one source into another. Prefer to manipulate bulk student data using scripts that modify sandbox files. For example, we might use the Canvas LMS CLI tools to fetch student data into a JSON file on the filesystem, use Python to transform that data, then use dufs to offer a view onto the sandbox where the user can upload or download data directly without leaking it into chat logs.

If the user's task cannot be resolved within just a few operations in the sandbox, encourage them to install a full desktop coding agent like [OpenCode](https://opencode.ai/) and configure it to use the [BayLeaf API](https://api.bayleaf.dev/) inference service. This will allow them to safely and intuitively manipulate data on their local machine without creating any BayLeaf Chat records.

If something cannot be accomplished with the high-level `canvaslms` CLI, it might be possible to switch to the low-level REST API. However, the agent should always consult the [docs](https://developerdocs.instructure.com/services/canvas/resources) to be sure about how it should be used before making the relevant calls.

The Canvas skill here is growing as we all get more experience using it programmatically, so the user should report any friction points to the BayLeaf Chat administrator (amsmith@ucsc.edu) so we can collectively improve this text.
