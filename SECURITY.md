# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[security advisories](https://github.com/senoldogann/chatgpt-queue/security/advisories/new) rather
than in a public issue. Please include the affected component, the version or commit, reproduction
steps, and the impact you believe it has. You will get an acknowledgement, and credit in the fix
unless you prefer otherwise.

## What this project is

ChatGPT Queue is a Manifest V3 extension for `chatgpt.com` plus an optional local CLI bridge. It
does not call the OpenAI API and has no backend, so there is no server to compromise. The security
surface is what runs in your browser and on your machine:

- the extension (`background.js`, `content.js`)
- the FlowRun CLI (`dist-cli/`)
- the local Native Messaging host (`dist-native/`)

## Design properties that matter for security

Stating these explicitly makes it easier to tell a bug from a design decision:

- **Local only.** Queue contents, FlowRun run history, context settings, UI preferences, and the
  pending compaction handoff are stored in `chrome.storage.local` for this extension only. Nothing
  is uploaded anywhere.
- **Minimal permissions.** The production manifest requests `storage`, `notifications`, and host
  access to `https://chatgpt.com/*`. `nativeMessaging` is optional and is requested only when you
  explicitly enable the CLI bridge.
- **No credential access.** The extension never reads cookies, session tokens, or credentials, and
  it does not inject scripts into any other origin.
- **Fail closed.** When the extension cannot prove that an action is safe, it blocks the queue
  instead of guessing, and it never automatically retries a send whose result is unconfirmed.
- **Bounded writes.** Handoff records and FlowRun run history are capped, and migration between
  queue keys is fail-closed rather than lossy.

## In scope

- Escaping or injecting anything into the ChatGPT page beyond the intended panel behavior.
- Leaking queue contents, run history, or stored briefs to a page, another extension, or a network
  endpoint.
- Bypassing the ownership lease so two tabs drive the same conversation, or bypassing the
  fail-closed rules so an unconfirmed send is retried.
- The Native Messaging bridge accepting a job it is not authorized to run, or the install flow
  writing outside its documented locations.
- Cryptographically irrelevant but user-relevant issues such as unprompted message sends.

## Out of scope

- ChatGPT's own errors or outages, including the `backend-api` and TLS failures that appear in the
  page's console; those originate from OpenAI's own requests.
- ChatGPT DOM changes that cause the panel to report `interface degraded` or `unrecognized`. That is
  the fail-closed behavior working, not a vulnerability.
- Anything that requires a malicious extension or a compromised browser profile, since such an
  attacker already holds the extension's storage.

## Supported versions

Fixes target `main` and the newest published release candidate. Older release candidates are not
patched; reinstall the current release instead.
