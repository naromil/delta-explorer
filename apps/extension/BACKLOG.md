# Backlog — move items between sections to steer what gets built.

## Routine (Claude may build these without asking)

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Follow links inside a page canvas: clicking a link in a page card (or in an answer that hands
  links back) adds the linked page as a new page card beside the current one, instead of only opening
  a tab, so browsing happens on the canvas with each page digested in place. The background can fetch
  the page (it holds `<all_urls>`) and convert it with the same markdown extraction as
  `src/content/page-canvas.js`, but a fetched page is raw HTML: content built by scripts is missing
  and there is no layout to judge what is hidden, so the result is weaker than reading a live tab.
  Decide between fetching, opening the page in a background tab and reading it through the content
  script, or offering both (e.g. a plain click opens a tab, a modifier or menu item adds a card).

- [ ] A way to debug the web chat canvas against the real sites (see "Known limitations" in
  `AGENTS.md`): every fix so far was guessed from error text, because nothing here can drive Firefox
  on a signed-in chat. Options: drive Firefox with a signed-in profile (Playwright's Firefox or
  `web-ext run` plus Marionette); save DOM snapshots of each site (a conversation, a new chat, mid-reply)
  as fixtures and test the adapters in `src/content/web-chat.js` against them offline; or a debug
  command that dumps what each adapter selector matches on the open tab. Snapshots also catch a site's
  next markup change.

