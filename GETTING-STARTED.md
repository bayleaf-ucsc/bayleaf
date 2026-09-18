# Getting Started Guide

This guide is intended for members of the campus community who are new to BayLeaf. You might be a Generative AI skeptic, a seasoned Claude user, or a refugee from Gemini. Regardless of your background, this guide will help you get started with BayLeaf Chat and the BayLeaf API.

BayLeaf is free to use for anyone with a UCSC identity. It covers almost every use case of mainstream chat and agent services while offering levels of control over the experience and user privacy that are not available from any other consumer or institution-facing platform.

By learning to use BayLeaf, you are actively participating in politically engaged resistance to hype-driven corporate influence over the use of Generative AI in higher education.

## Browser-based Chat

This section of the guide helps people who might otherwise be reaching for the browser-based chat features of [ChatGPT.com](https://chat.openai.com) or [Claude.ai](https://claude.ai). We'll get to helping you log in and use BayLeaf Chat in a moment, but there are some aspects of browser-based chat services you should understand first to use them responsibly.

### Privacy and Capability

Web-based chat services offer you consistent access to your conversations across any of your devices with browsers (e.g. laptops and smartphones). In exchange for this convenience come two important limitations:

- Privacy: Whoever runs the web-based chat service needs to be able to access your chat data. On BayLeaf Chat, only a single system operator is capable of leveraging this access, whereas entire teams are capable of doing this on other services. You can often use your profile settings in these services to opt out of having your data used for future model training. For BayLeaf Chat specifically, your data is not stored, even temporarily, by our inference providers, and there is no need for a manual opt-out step.

- Capability: Browser-based chat interfaces usually can't access files on your computer, so conversations often remain speculative and ungrounded until you copy-paste or drag in files that might be relevant to the conversation.

Many browser-based chat services (including BayLeaf Chat) offer Web Search and Code Sandbox features that trade some privacy for improved capability. When you enable Web Search, the agent may use a third-party search engine to look up terms and phrases from your conversation, leaking personal details beyond just your chat provider. When you enable the Code Sandbox, the agent may communicate with third-party services in a much more open-ended way, potentially exfiltrating your sensitive data in bulk. On BayLeaf Chat, Web Search and Code Sandbox are features that you opt into on a per-message basis, and you can delay enabling them until they seem specifically needed.


### Logging In

In your browser, visit <https://chat.bayleaf.dev/>. If this is your first time visiting, you'll see a message like:

> Sign in to BayLeaf (Open WebUI)
> 🔑 Continue with UCSC

[Open WebUI](https://github.com/open-webui/open-webui) is the open-source software we run to operate our chat services. It doesn't provide inference services on its own. It's just, as the name suggests, a web-based user interface for accessing inference services that the BayLeaf platform obtains from other providers.

When you click Continue, you'll be taken to a logon page for [CILogon](https://www.cilogon.org/). CILogon is a federated user authentication system that supports more than 5,000 identity providers, including many higher education institutions. We've customized the logon page to make it easy for you to use "University of California, Santa Cruz" as your identity provider. When you click Log On on the provider selection page, you'll be redirected through our campus-specific authentication system (Duo). Your password never goes to BayLeaf systems. Instead, BayLeaf only learns what the consent screen shows. Here's what it looks like for me:

> `displayName`: Adam M Smith
> `eduPersonPrincipalName`: amsmith@ucsc.edu
> `eduPersonScopedAffiliation`: Faculty@ucsc.edu, Employee@ucsc.edu, Member@ucsc.edu
> `givenName`: Adam
> `mail`: amsmith@ucsc.edu
> `nullAffiliation`: Faculty, Employee, Member
> `surname`: Smith

That's it. BayLeaf trusts CILogon's assertion that I have a specific name, campus email address, and a few specific affiliations. Everyone at UCSC is a "Member," but "Faculty" and "Employee" tags depend on your employment status. There's a "Student" tag as well, but I don't personally have that one. If you want a conversational agent on BayLeaf Chat to know more about you than what's given here, you'll need to provide that information.

### Basic Chat

Once you are logged into the BayLeaf Chat site, you'll see a page that looks and works a lot like you might expect from ChatGPT. There's a sidebar on the left you can use to organize your previous chats, and you can compose a message to start a new conversation in the main panel.

By default, you'll be talking to the Basic agent. There are other agents, but they are usually available to people added to specific user groups. Don't worry about those for now.

Try asking Basic, "What's BayLeaf?" Your browser may ask whether you want to allow BayLeaf Chat to access your location. You can accept or reject this as you see fit. Basic doesn't use your location for anything, but the interface proactively asks for this in case you later want to customize your setup to, for example, treat you differently when you are specifically on campus or traveling abroad.

The answer to "What's BayLeaf?" probably doesn't look like the one you'd get from ChatGPT: It seems to know what BayLeaf is without even having to do a web search. Every conversation with Basic starts from what's called a system prompt, a block of text (written by me, not you) that sets the context for the conversation to come, sometimes customizing the chat character's personality or grounding key situational facts. This mechanism gives Basic some information about the BayLeaf Chat project itself, and it includes some affiliation-specific notes as well (e.g. special advice for users in the Faculty or Student roles).

Now try asking a much more specific question like "What programming language is BayLeaf written in?" The model likely won't answer right away. You might see a thinking (also called reasoning) block you can expand to see an internal note from the agent like: "I don't know; could check repo but web-search skill available this turn? Skills are listed as available – I can load web-search skill." After that thought, it might visibly reply, "My self-knowledge doesn't include that, but I could [...]" Then you might see it use the `view_skill` tool to look up a skill called `web-search`. The result of that operation is another (hidden by default) block of text (also written by me) explaining to the agent what our Web Context toolkit is and how and when to guide the user to enable it. At this stage, you might even see another thinking block: "The skill says it requires enabling in the UI; I don't have an actual search tool callable here. So I can't check. Be honest." Finally, it'll compose the main message replying to you, explaining that while it can't look up the information directly, it could if you followed the on-screen instructions to enable a specific toolkit. It might close: "If you flip on Web Context, I'll pull the GitHub repo and give you a language breakdown from the actual source."

If you are done with this conversation, you can start a new one or just close the window and walk away. If you want to erase the existence of this conversation, you can use the Delete option for it in the sidebar. On BayLeaf Chat, these are not the soft deletions you might expect from other browser-based chat providers. Deleted conversations are permanently removed from our database and no longer accessible by the operator (me).

### Toolkits

#### Web Context

Continuing our "What programming language is BayLeaf written in?" vignette from above, let's enable the recommended toolkit. In the little diamond menu (labeled Integrations) in the message box, select Tools, then Web Context, then use the slider to enable the toolkit. Toolkits grant agents access to collections of tools they can call to reach beyond the current conversation's context. We saw one built-in tool above: `view_skill`.

You can think of our skill system as a kind of internal wiki maintained by me, filled with advice for how the agent should handle special situations. There's no privacy risk in consulting this wiki, and reading its pages can't have any destructive side effects by itself, so the `view_skill` tool is available to Basic by default.

Once you've enabled Web Context, reply to Basic, "I've enabled it now" (or even just informally say, "Try now"). You'll likely see some thinking blocks and calls to the `search` and `extract` tools as the agent looks up more information about itself using a web search engine and pulls source code directly from GitHub. After a bit of poking around, it might report, "It's a polyglot repo – TypeScript for the API layer, Python around the Open WebUI chat service." But you shouldn't trust this answer simply because the agent looked up the sources. If you click to expand those `search` and `extract` tool calls, you can see which terms it used for its search, which URLs it visited when extracting content from public web pages, and which specific chunks of content it extracted. If you don't want to dig around yourself, you might instead just reply, "Link to specific sources for me," and the agent will (likely) reply with an organized list of the relevant sources.

The Open WebUI software BayLeaf Chat uses offers an "Attach Webpage" feature you can use to share one specific web page with the active agent. This feature is much more limited than the Web Context toolkit, as it only shares one specific page without allowing the agent to reach out to the web and chase links to gather context beyond the initial URL you provide. As is often the case with these agents, you give up a little bit of privacy and control to give your agent more capability.

#### Code Sandbox

Sometimes you want your agent to do more than just chat and read web pages with you. Maybe you want it to download and visualize a public dataset, propose and show you a new design for your personal homepage, or even build and run a custom app to help you in some other way not anticipated by the designers of Open WebUI. For many of those situations, you might reach for the Code Sandbox toolkit.

Code Sandbox uses the [Lathe](https://lathe.tools/) coding agent harness to operate a private [Daytona sandbox](https://www.daytona.io/) on your behalf, letting your agent create and edit files, run programs, and host network services. Again balancing privacy and capability, Code Sandbox lets you do *most* of what you might do in a desktop app like ChatGPT or Claude (formerly Codex and Claude Cowork) while making sure that the agent only works with the files in an isolated sandbox, not your personal computer. If you were curious about *Agentic AI*, this is it. It's mostly just chatbots using computers, and you can do a lot of stuff with computers.

It's okay if you don't know what you'd personally do with the Code Sandbox toolkit. The Basic agent has enough information about BayLeaf and the Code Sandbox toolkit to recommend enabling this feature when it might be specifically relevant at some point in a conversation.

A few things to know about this rather open-ended sandbox feature:

- Files created in your sandbox persist across chats. This can be useful, but the convenience might tempt you to store things in the sandbox that would be better stored on your own physical device.
- The sandbox is not very big: Last I checked, it offered 1 vCPU, 1 GB RAM, and 3 GB disk space.
- It gets sleepy: About 15 minutes after your agent's last interaction with the sandbox (or after your last direct network connection to it dies), the sandbox will be stopped. This puts it into a low-cost mode where running programs are killed, but reawakening takes only a few seconds. After about an hour in this state, the sandbox goes into an archival state where reawakening takes longer (a minute or so), but our hosting costs go way down.
- It makes it easy to make potentially serious mistakes: If you ask the agent to launch a service like VS Code, it will give you a temporary link to a full-fledged software development environment, including a full-access command-line terminal. If someone else gets this link (because you accidentally pasted it somewhere or someone read it off your screen in a video chat), they'll have the same access to your sandbox data as you and your agents do.

> Just a day after I wrote the scary text above, I decided to close that specific security hole. Links given out to sandbox services can only be followed by the logged-in user who created them now. Just because I've locked that particular [footgun](https://en.wiktionary.org/wiki/footgun) in the cabinent doesn't mean there aren't others to play with, however. You can get into almost as much trouble with the sandbox as you can with your personal computer, so be careful.

If you (or your agents) get your sandbox into a broken or unresponsive state, you can ask your agent to `destroy` the sandbox. You'll lose any data stored in the sandbox, but you'll quickly be back to a predictable, clean starting state. If you don't touch your sandbox for an extended period of time (90 days at the time of writing this guide), your sandbox will be destroyed automatically. Use it as a temporary scratchpad, a playground, a sandbox. Don't be afraid to destroy your sandbox. It will grow back automatically the next time your agent tries to access it.

Like your other conversation data, the contents of your sandbox are accessible by the service operator (me). I'd probably sooner destroy your sandbox than look inside it, but do keep operator access in mind. If you want to have conversations and files that aren't visible to the operator, we have something for you, but you'll have to leave the browser to get it: desktop apps.

#### Google Workspace

Because UC Santa Cruz uses Google Workspace for email and other services, BayLeaf Chat offers an experimental integration toolkit. Once you turn on the Google Workspace toolkit, your agent will gain consent-gated access to Gmail, Calendar, Drive, Spreadsheets, and other Google Workspace services. You'll get a new permission prompt each time the agent wants to escalate access to another service capability. Our positive-consent features might feel tedious, but that's how we're trying to let you navigate the privacy–capability landscape yourself on a per-conversation basis. At the time of writing, our Google Workspace toolkit is configured for read-only access.

Before you try to use this feature for any serious work, you should familiarize yourself with Simon Willison's [lethal trifecta for AI agents](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents).

### Other Toolkits

Depending on your affiliation and group membership, there might be other toolkits available to you. Enabling a toolkit is generally a non-destructive operation. So, if you are curious about a toolkit, enable it and ask the agent what it is now capable of doing with that toolkit.

On a technical level, [toolkits are Python classes](https://docs.openwebui.com/features/extensibility/plugin/tools/development) exposing methods that the agent can call as tools. Toolkits can expose administrative settings, called valves, that let the installer configure the toolkit's behavior. For example, the Web Context toolkit has an admin valve for controlling the API key we use to access the Tavily search engine on your behalf. Toolkits can also expose user-facing settings, called user valves. Some user valves in the Code Sandbox allow advanced users to specify values for environment variables used when the agent runs programs in the sandbox. In the past, we've deployed course-specific toolkits that could read assignment details from Canvas, allowing instructors and TAs alike to customize the course-specific agent's behavior directly from Canvas without logging into BayLeaf Chat to make changes.

### Customization

If you find yourself repeatedly sharing information with the agent in each new conversation, you might want to put that in your personal System Prompt. In the bottom-left corner of the Open WebUI display, you'll find a menu with your name on it. Use that menu to access Settings, and within Settings find the General panel. On that panel, there is a block of text labeled System Prompt. On other browser-based chat services, this feature might be called (Custom) Instructions.

Like the system prompt I wrote for Basic, your System Prompt is automatically stamped onto the front of each new conversation you start on BayLeaf Chat.

You might use this to list your precise job title, the course you are teaching this quarter, the things you want to learn about, your preference for humor versus serious tone, etc. You might also indicate your *idioma preferida*. (Most agents will somewhat mirror the language you use in your messages, but most have a bias towards English. The fact that I've written the system prompts and tool descriptions and other platform context in English reinforces this bias.)

Most users can leave their System Prompt blank. Only add things here if you find yourself annoyed by how often you need to correct the agent's default behavior. If you are feeling tempted to heavily customize BayLeaf Chat, it might be time for you to graduate to using a desktop app where you have much more control over your agents' environment.

BayLeaf Chat doesn't operate an automatic memory management system (although Open WebUI supports memory features). So, if you want information to carry over between conversations, it is your job to explicitly copy it between them, convince your agent to write that information to your sandbox, or paste it into your System Prompt. BayLeaf Chat is set up this way so you can get hands-on experience with a bit of context engineering without relying on magical-feeling learning mechanisms (which are probably just doing the equivalent of editing your System Prompt behind your back).

That's it! You are fully onboarded to BayLeaf Chat. There's a lot more you can learn if you want to make custom agents and offer them to your students or teammates, but I'll save that for a future guide.

## Desktop Apps

This section of the guide helps people who might otherwise be reaching for the ChatGPT or Claude desktop apps (formerly Codex and Claude Cowork). Desktop apps make it easier for conversational agents to work with the files on your computer and control other apps on your behalf. Usually, a conversation in a desktop app can only touch data in the specific project folder you've selected to anchor it, and the app will use graphical permission prompts to get your consent when reaching beyond that project folder.

With BayLeaf Chat, you often had to give up some privacy to get more capability. With a desktop app, at least in how we use these apps with a zero-data-retention (ZDR) inference provider such as BayLeaf, you get a big step up in privacy and capability at the same time. On privacy, there's no way the BayLeaf operator (me) can get at your stored conversation data because it is stored only on your computer. On capability, it is like having a stronger version of Web Context (you might allow your agent to control your browser) and Code Sandbox (you might allow it to control *your* computer and use your other installed software on your behalf). It's all excitingly dangerous, if you opt into it, but you are ultimately in control of what happens on your computer.

### Installing OpenChamber

[OpenChamber](https://openchamber.dev/) is a free and open-source desktop app that describes itself as an *agentic development environment*. This phrase doesn't mean much to anyone who isn't specifically coming from a command-line coding agent harness (like the [OpenCode](https://opencode.ai/) harness that OpenChamber wraps). For most BayLeaf users, it's just the desktop user interface for agents that have their smarts provided by the BayLeaf API and their context and environment provided by your personal computer.

The [download page for OpenChamber](https://openchamber.dev/download/) offers installers for Windows, macOS, and Linux, split by processor architecture. This guide can't cover every combination, so I'll assume you can figure out how to install the desktop app and launch it for the first time.

If OpenCode isn't already installed, OpenChamber automatically installs it on first launch before proceeding to the main display.

When you launch OpenChamber, you'll be greeted with a user interface that looks a lot like the one from BayLeaf Chat. You've got a big chat window in the middle with a sidebar of your past conversations on the left.

**Important:** Even though it might be tempting to start a new conversation right away, hold off on that. The oh-so-convenient initial state of OpenChamber sets you up with free access to a data-harvesting inference service. (At the time of writing, their default model is ominously named *Big Pickle*.) We'll have you hooked up with an excellent privacy setup with just one more step.

### Configuring OpenChamber to use the BayLeaf API

(Note to author: We really need screenshots here to point out where people need to click!)

This is the only technical process required to use OpenChamber with the BayLeaf API, but it is easy to get lost in it.

On the far-right menu bar, find the Terminal button with a little `>_` icon. Click this to launch a terminal in the right sidebar. When the terminal panel opens, type (better yet, copy-paste) the following command:

```sh
opencode auth login https://api.bayleaf.dev
```

After a moment, you'll see a message like this:

```sh
Open this URL to approve access:
https://api.bayleaf.dev/auth/claim?c=PMKX-21D3
```

Copy-paste that link into your browser (or control/command-click it to open it directly). It will route you through the CILogon authentication process (just like in BayLeaf Chat), landing you on a page that says "Authorize OpenCode for BayLeaf," references the claim code you spotted in the terminal, and has some big Approve and Deny buttons. For this process, we want to Approve. A moment later, you'll see a new page with a message like "OpenCode for BayLeaf has been authorized. Return to your terminal, then restart OpenCode to access BayLeaf." (It says OpenCode instead of OpenChamber because OpenChamber is an OpenCode wrapper and we haven't yet built a graphical version of the onboarding flow originally designed for the command-line tools.)

You can close that browser tab and return to OpenChamber now. Hopefully, after a moment, you'll see a message like "Logged into https://api.bayleaf.dev." If so, close and reopen OpenChamber for the change to take effect.

After the restart, you'll be back at the OpenChamber main screen, but instead of seeing *Big Pickle* listed as your default model in the message composition box, you'll see something like *Z.ai: GLM-5.3-Flash*. When you mouse over this model name, you'll see a tooltip confirming *BayLeaf Remote* as the model's inference provider.

If you ever need to disconnect OpenChamber from the BayLeaf API (unlikely), you can use the command:

```sh
opencode auth logout https://api.bayleaf.dev
```

### Managing OpenChamber Projects

Unlike on BayLeaf Chat, where all of your conversations are dumped into a single chronological list in the sidebar by default, OpenChamber groups your chats by project. Projects aren't just for grouping related chats; they shape the agent's default access bounds while it works on your computer. Ultimately, projects are just folders somewhere on your computer, and having a conversation in a folder means the agent can read and write files in that folder.

When you add a project in OpenChamber, you are essentially bookmarking a specific folder on your computer as the home for a collection of conversations. If you remove the project from OpenChamber, your files remain safe on your computer (and even the conversation data is not lost from OpenChamber's local storage). Think of adding and removing projects as lightweight operations that mostly change which folders are convenient to access.

Usually, when an agent tries to access files outside of the project folder, OpenChamber will give you a graphical prompt in which you can allow access just once, allow it every time, or deny it for the specific files or folders. If you find yourself needing to approve many such requests, it is a sign that your current project doesn't actually contain the relevant context you hope it does or that you should be attaching your conversations to another project folder where the relevant files are readily available.

> BayLeaf Chat does have a *folders* feature that is similar to OpenChamber's *projects* feature, but it doesn't do anything to manage agent permissions. It merely groups conversations together in the sidebar and, optionally, lets you specify a system prompt addendum that all new conversations in that folder will inherit. If you find yourself reaching for this feature in BayLeaf Chat, it might be a sign that you would be better served with a desktop app instead.

### Managing Files in a Project

One way to work with the files in an OpenChamber project is to ask the agent to manipulate the files for you. However, you are probably experienced in manipulating those files yourself: this is your personal computer, after all. In the top right of the OpenChamber window, you'll see a drop-down menu with options to open the current project in several relevant apps, such as Finder/Explorer, VS Code, or an external terminal.

Even though OpenChamber has a built-in terminal (that we used previously) and a file browser, you'll probably find your computer's pre-existing file management tools more familiar.

### Using the Integrated Browser

One of OpenCode's more powerful built-in features is an integrated web browser. You might think that, if I just recommended using your familiar file browser over the built-in one, maybe you should use your familiar web browser too. One important feature of OpenChamber's integrated browser is that you and the agent can control it together: it can click buttons, fill in forms, and navigate between pages, then pause to let you do something manually, such as provide login details. The integrated browser is also isolated from your everyday browser, helping you scope the agent's access to the web without immediately giving it access to everything your everyday browser has access to (like your saved passwords, cookies, and other personal data).

You will almost never open the integrated browser yourself. Instead, your agent may decide, partway through a task, that it wants your help using some web service that it can't access programmatically. If you can help the agent get past the roadblock (e.g. a login screen), it can continue with bulk data analysis or whatever task without further involvement from you. If you subsequently close the integrated browser window, you'll immediately retract the agent's access to that browser session.

### `AGENTS.md` files

When you start a conversation in a project folder, OpenChamber lets the agent know the folder's path (e.g. `/Users/adam/Desktop/bayleaf`), the current date, and some information about OpenCode/OpenChamber itself. It doesn't know what you are trying to do with that project until it starts looking around by reading files.

You can save your agent some exploration steps and set it up to be more useful in its replies by creating an `AGENTS.md` file in your project folder. The contents of this file get injected into each new conversation in that project automatically in a role similar to a system prompt. [This feature](https://agents.md/) is supported by most coding agent harnesses and agentic development environments, so any work you put into making a good `AGENTS.md` file for a project folder will carry over to other apps you might explore in the future. The only trick is getting the capitalization right: `AGENTS.md` (and placing it at the root of your project folder).

You don't need to create and maintain this file by yourself. If you (or your agent) repeatedly make some mistake in a project, it is usually enough to say, "Let's make a note in the `AGENTS.md` file so we don't make this mistake again." Depending on whether the mistake seems to be project-specific or general-purpose, the agent might ask whether you want the note to be saved in a global `AGENTS.md` file (somewhere in your home directory) or a project-specific one (in the current project folder). The global and project-specific `AGENTS.md` files stack: both influence fresh conversations (and generally don't go into effect until your *next* conversation in that project).

You don't need to be very strategic about what goes into an `AGENTS.md` file, or even have any such files at all. Let repeated annoyances or important learnings guide you. If your `AGENTS.md` file is ever feeling too long and messy, just tell your agent to "interview me to figure out how we should go about cleaning up the messy agents file" or the like.

If you dare, you might add a note to your global `AGENTS.md` file that tells the agent you'd like it to keep the agents file updated automatically based on your experiences together, particularly when it might avoid fumbling with tools or looking up authoritative sources of context.

Here's a paraphrased version of a line from my own global `AGENTS.md` file: "If the user doesn't seem to be following the work we are doing together, challenge them with a spicy multiple-choice question to check their reading comprehension."

### `SKILL.md` files

A healthy `AGENTS.md` file usually has about one page of critical context for your whole computer and/or a specific project. There's an emerging convention called [agent skills](https://agentskills.io/) where you simply organize additional text files into folders with a peculiar name: `SKILL.md`. A skill is just another block of text that works like a system prompt (or `AGENTS.md` file) but it is dynamically loaded only when it is likely to be relevant.

The key things that separate a skill from an `AGENTS.md` file (beyond the filename and the fact that skills live in a subfolder of your project folder, such as `.agents/skills/example/SKILL.md`) are the `name` and `description` fields in its front matter. The name is a short, unique identifier for the skill, and the description works like a trigger condition.

When you start a new conversation, the agent gets to learn about the name and short description of all available skills (both global and project-specific). If the agent thinks a skill might be relevant to the current conversation, it uses a tool to read the larger contents of the skill's `SKILL.md` file.

In my own BayLeaf project folder (remember, I'm the BayLeaf operator and developer), I have a skill with the following front matter:

```yaml
---
name: bayleaf-ops-router
description: Operations playbooks for the BayLeaf platform (Chat at chat.bayleaf.dev, API at api.bayleaf.dev). Use when the user mentions Dependabot or dependency bumps for the API, upgrading Open WebUI, changing the LLM behind Basic or Help, editing system prompts or tools in prod, accessibility evidence or VPAT recordings, privacy notice changes, bumping spin-off modules like Lathe, adding a new service facet, or running the prod-to-repo backup/reconcile procedure.
---
```

The rest of the file describes my operations playbook system, lists the filenames and purposes of the specific playbooks available, and specifies a process to be followed whenever new playbooks are created or old ones are updated.

Because only a fraction of my conversations in the BayLeaf folder pertain to operations, my agent usually doesn't bother to read the router skill, let alone read any of the specific other files it mentions.

Again, you don't need to be super thoughtful about what goes into a skill or how skills are organized. Keep accumulating reusable knowledge in your `AGENTS.md` files. When they get too messy, ask your agent, "Do you think we could clean up this project by moving some of the stuff from the `AGENTS.md` files into distinct skills?"

### Project Folders as Git Repositories

Suppose you have a project folder set up nicely. Maybe it is one you are using for writing a research paper. Maybe your `AGENTS.md` file has a link to the publication venue's call for papers, and you have various agent skills for keeping your bibliographic database up to date, rerunning some analysis scripts, or fact-checking citations in your messy draft. Would you like to share this rich environment with a coauthor?

Even if you aren't a software engineer, you can get some benefits from using software engineers' tools. Ask your agent about publishing the project folder as a Git repository. It'll help you decide if that approach is relevant and how best to share the project with your colleague.

Take a brief look at the Git repository for the BayLeaf project itself: <https://github.com/bayleaf-ucsc/bayleaf>. It's got an `AGENTS.md` file with the spicy statement "BayLeaf is a convivial, sufficiency-capped degrowth artifact funded by a gift economy and animated, in places, by an innovation-accelerationist pulse it hasn't fully reconciled." It also has some agent skills, like the operations playbook one mentioned above, and another that maintains a political analysis of the landscape of Generative AI in higher education. Any new agent that you attach to the BayLeaf repository instantly understands BayLeaf as a political project, a constellation of live services, and a body of software code.

## Advanced Usage of the BayLeaf API

I created the BayLeaf API primarily to serve users of desktop agent harnesses like OpenCode and OpenChamber. However, there's more you can do with it. Following the emerging [`llms.txt`](https://llmstxt.org/) convention, we offer an agent-facing overview of the BayLeaf API at <https://api.bayleaf.dev/llms.txt>. It's plain English that you can read as well, but it probably has too much detail for most users. Stick with the current getting started guide for the highlights.

### Getting an API Key

Most features of the BayLeaf API require you to get an API key. Just log into the [API dashboard](https://api.bayleaf.dev/dashboard) and click the Create API Key button. The resulting key is hidden from view by default so you don't accidentally leak it to others while using screen sharing. If you do accidentally leak your API key, just press the big red Revoke button to invalidate it and generate a new one.

### BayLeaf API as an OpenAI-compatible Inference Provider

Above, when I had you run `opencode auth login https://api.bayleaf.dev`, you were letting BayLeaf make some fairly invasive changes to your OpenChamber installation. You can instead plug in the BayLeaf API as a boring, OpenAI-compatible inference provider. You'll need your API key, the endpoint URL `https://api.bayleaf.dev/v1`, and a valid model name. The API dashboard page has an Available Models list with links to upstream information about each model. Note that we only provide access to confirmed open-weight models (models that are freely available to download, even if most are too big to run on your personal computer).

For the models provided by our OpenRouter backend, we give you a daily spending limit ($5/day for most users, currently). Different models cost different amounts to process a given amount of text, so shop around, balancing cost and capability. As of September 2026, [DeepSWE](https://deepswe.datacurve.ai/) gives a reasonable cost-versus-capability landscape analysis. This benchmark is targeted at "long-horizon engineering tasks" rather than "everyday use." You might just skim to see what's cheap while hitting a score above 50%.

### Sealed Inference

If you are curious about next-generation privacy features (things you can't get from OpenAI or Anthropic), check out a blog post I have on the topic of "military-grade encryption" for LLM inference: <https://blog.bayleaf.dev/p/military-grade-encryption>. If you want to try it out, use `opencode auth login https://api.bayleaf.dev/sealed` or have your agent read our `llms.txt` and ask it to set it up for you.

### Alternate Harnesses and, uh, Surfaces, or Cockpits

I've mentioned that OpenChamber, the desktop app, wraps OpenCode, the command-line agent harness. Some candidate general terms for OpenChamber-like applications are "surface" and "cockpit": the software you look at and use with your mouse and keyboard while the harnessed agent works at the level of text and tool calls.

If you are a fan of command-line tools (unlikely), you might try using the [OpenCode](https://opencode.ai/) harness directly. OpenCode and OpenChamber share settings, so any setup you've done in OpenChamber will immediately carry over to OpenCode.

You might further try the [Pi](https://pi.dev/) command-line harness. More likely, you might have your existing agents leverage Pi as the harness for [autoresearch](https://shopify.engineering/autoresearch)-style long-running tasks.

As of September 2026, the cloud of things that are sort of like agent harnesses is getting quite large and messy. Here's one attempt at an overview (from the OpenChamber team): <https://openchamber.dev/blog/ai-coding-agents/>. They are all, for the most part, interchangeable. Almost all of them (the ones that don't come from OpenAI, Anthropic, or Google) cleanly separate the software that runs on your computer from the organizations that train the LLMs that power the agent's reasoning.

Your `AGENTS.md` files and `SKILL.md` files are largely portable across harnesses, and most harnesses will be compatible with the BayLeaf API as an inference provider.

### Web Context and Code Sandbox, at the API Level

The BayLeaf API wraps access to the Tavily search engine and the Daytona sandbox provider. These are the services that power the Web Context and Code Sandbox toolkits in BayLeaf Chat.

If you want the agent running on your computer to manipulate the sandbox used in BayLeaf Chat (so you can continue your project away from your laptop, perhaps from your phone's browser), you might direct your agent to upload files to the sandbox via the BayLeaf API.

### Canvas LMS and Google Workspace, at the API Level

While BayLeaf Chat needs to use specific toolkits (written by my agents) to connect you to services we often use on campus, such as the Canvas LMS or Google Workspace, our `llms.txt` gives your agent some clues about how to access these services directly. When you do this, you aren't using the BayLeaf API; you are using the other service's API directly. We've documented those integration patterns in our `llms.txt` file because it's much more likely that your agent, rather than you directly, will be building and maintaining those integrations.

If you figure out how to get your agent to integrate with another service widely used by the campus community, contact [me](mailto:amsmith@ucsc.edu) about adding some documentation to our `llms.txt` file so that others can learn from your experience directly.
