/* Plugs KaTeX into DeltaMarkdown for the extension pages (classic script, after
 * vendor/katex/katex.min.js). `trust: false` keeps \href, \includegraphics and
 * friends disabled, so model-written TeX renders no links, URLs or scripts.
 * katex.render builds DOM nodes directly; bad TeX renders as KaTeX's inline
 * error rather than throwing mid-stream. Content scripts do not load this:
 * page bubbles show formulas as code. */
(function (root) {
  if (!root.katex) return;
  root.DeltaMarkdownMath = function (tex, display) {
    var host = document.createElement('span');
    root.katex.render(tex, host, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml'
    });
    return host;
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
