# Delta Explorer for Firefox

**An AI helper for learning anything while you browse.** The browser companion to the
[Delta Explorer](https://github.com/naromil/delta-ai) desktop app: bring your own model, expand any
text inline, look things up, chat, explore on a canvas, and let it remember how you learn.

![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-orange)

## Features

- **Inline expansions on any page.** Select text and right-click **Expand** for a definition or
  explanation, or **Expand on…** to ask your own question, with one-click **Simpler / Example / Why /
  Compare / Deeper**. The answer streams in as markdown right where the text was. Answers nest (select
  inside an answer to go deeper), can be regenerated, re-asked, copied, sent to Chat, folded back into
  the text or removed, and come back when you revisit the page. `Ctrl+E` expands the selection;
  `Alt+Shift+E` asks first. An optional Expand bar can float over every selection.
- **Look-up popup.** The toolbar button (`Alt+Shift+D`) asks about the page you are on, with the
  selected text (or, if you choose, the readable page text) as context. Continue any look-up in Chat.
- **Chat.** Persistent conversations with inline expansions inside answers (selection bar, right-click,
  `Ctrl+E`), image attachments for vision models, edit-and-resend, regenerate, stop with `Esc`, rename,
  export as markdown, delete, and `Ctrl+K` search across every conversation's titles and content.
- **Canvas.** An open plane of answer rectangles: draw a rectangle and ask, and the answer is written to
  fit it. Draw against a card to continue that conversation, anywhere else to branch off a new one;
  expand terms into cards of their own; add notes, frames and labelled connections; link cards into a
  question as context; undo, tidy, outline search, a map, and a full keyboard map (`?`).
- **Any page as a canvas.** Right-click a page and choose **Explore this page on a canvas**, press
  `Alt+Shift+C`, or use the look-up's Canvas button. The page's text becomes the first card, links
  included: ask for links and the answer hands back the page's own, ready to click. Every
  conversation that continues it has the page as context, and its terms expand like an answer's. Opening
  it again on the same page brings your canvas back.
- **Rich answers.** Markdown with tables and code blocks (each with a Copy button), and LaTeX math
  rendered with KaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`).
- **Memory personalization.** A background curator turns your chats and page expansions into private
  markdown notes about what you know and how you like things explained (`index-learning.md` and
  friends). Chat, look-ups and expansions read them on every request, and can update them when you
  ask. Browse, edit or delete the notes in the Knowledge Base. Needs a tool-capable model on the
  Knowledge Base Maintenance role; can be turned off in Settings.
- **Role-based models.** Add any number of connections (OpenAI, OpenAI Compatible, Google AI Studio,
  OpenRouter, Ollama) and assign Chat, Look-up and Knowledge Base Maintenance independently, so
  look-ups can run on a fast model. Model details (context window, tool support, vision, price) come
  from [models.dev](https://models.dev); endpoints can be queried for their own model lists and tested.
- **Long chats fit the model's window.** The oldest messages are dropped when a request would exceed
  the model's context window as reported by models.dev; an unknown window trims nothing.
- **Light and dark** themes for the dashboard and popup; page bubbles follow the page.

## Installation (development)

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `manifest.json`.

Then open the dashboard (the house icon in the look-up, or the add-on's Options) and go to
**Settings → Models**: add a connection with your API key (or an Ollama host) and assign a model to
each role.

There is no build step and no npm. To package, zip the repository contents (without `.git`, `ref_src/`
and `dist/`) into an `.xpi`.

## Supported providers

All providers are reached through their OpenAI-compatible chat-completions endpoint with SSE
streaming and function calling.

| Provider          | Auth    | Default endpoint                                           |
| ----------------- | ------- | ---------------------------------------------------------- |
| OpenAI            | API key | `https://api.openai.com/v1`                                |
| OpenAI Compatible | API key (optional) | your base URL                                   |
| Google AI Studio  | API key | `https://generativelanguage.googleapis.com/v1beta/openai`  |
| OpenRouter        | API key | `https://openrouter.ai/api/v1`                             |
| Ollama            | host    | `{host}/v1` (default `http://localhost:11434`)             |

A model without tool support still answers; it just cannot read or write memories (it gets the
always-loaded notes as plain text instead). If Ollama answers HTTP 403, start it with
`OLLAMA_ORIGINS="moz-extension://*"`.

## Privacy

- **Bring your own key.** Keys are stored in this browser profile's extension storage.
- **All data stays local** except requests to the model providers you configure and the public
  models.dev model list. Expanding sends the selection and nearby page text to your Look-up model;
  chats and canvases go to your Chat model (a page canvas sends the page's readable text with each
  conversation that continues it); curating memories sends conversation summaries to the Knowledge Base
  Maintenance model.
- Images you attach are scaled down and re-encoded (stripping metadata) before they are sent or saved.
- No telemetry, no analytics, no accounts.

## Project structure

```
manifest.json            Firefox MV3 manifest
background.js            Message router, streaming host, KB scheduler (ES module)
content.js, content.css  Content script entry + inline bubble styles
src/content/             Page bubbles: anchors, streaming, selection bar, persistence, rehydrate
src/background/          Provider client, config, conversations, memory store + tools, KB, catalog
src/shared/              Prompts, models, conversation + rich-text model, offset-tracking markdown
src/ui/                  Shared page UI: conversation view, canvas board, API bridge, DOM helpers, styles
dashboard/               Home, Chat, Canvas, Knowledge Base, Guide, Settings
canvas/                  Canvas page: the overlay on a web page, or a tab
popup/                   Toolbar look-up
vendor/katex/            KaTeX 0.19.1 (MIT), unmodified
```

See [docs/architecture.md](docs/architecture.md) for the details.

## License

MIT — see [LICENSE.md](LICENSE.md). KaTeX is MIT-licensed (`vendor/katex/LICENSE`).
