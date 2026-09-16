# BayLeaf Chat Reference Sessions

This directory holds synthetic reference sessions supporting the empirical
accessibility pass in `../VPAT-chat.md`. Filenames begin with the primary WCAG
success criterion they examine.

Each retained run contains:

- `.json`: a content-bounded manifest of the flow, viewport, evidence checks,
  focus trail, and cleanup result;
- `.mp4`: a convenient rendering of the rrweb recording, tracked with Git LFS.

The raw rrweb archive includes the full rendered DOM. The capture harness uses it
as an in-memory intermediate and deliberately does not retain it in this public
repository.

These recordings contain only the dedicated probe account and fixed synthetic
content. They must never capture a human user's chats or credentials. See
`../../chat/vpat-recordings/README.md` for the capture and cleanup contract.
