/* Offset-tracking markdown for answers, with no dependencies.
 *
 * Classic script (not a module) so the same file serves the content script,
 * the dashboard and the popup: it defines `globalThis.DeltaMarkdown`.
 *
 * Delta Explorer parses with remark and anchors expansions by mdast source
 * offsets. This is a small GFM-ish parser that keeps the same contract:
 * every node carries `start`/`end` offsets into the source, every rendered
 * text node is a leaf `[data-src]` element whose DOM offsets map 1:1 onto the
 * source, and code blocks, inline code, formulas and images are atoms that a
 * selection can only take whole (`data-atom-start`/`data-atom-end`).
 *
 * Supported: paragraphs, ATX and setext headings, block quotes, nested
 * ordered/bullet lists, fenced code, GFM tables, thematic breaks, display math
 * ($$…$$, \[…\]), and inline code, strong, emphasis, strikethrough, links,
 * autolinks, bare URLs, images (shown as alt text), inline math ($…$, \(…\)),
 * escapes and hard breaks. Unclosed constructs degrade to text, so a streaming
 * answer always renders. */
(function (root) {
  'use strict';
  if (root.DeltaMarkdown) return;

  /* ================= Block parsing ================= */

  var FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  var HEADING_RE = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
  var HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  var QUOTE_RE = /^ {0,3}> ?/;
  var LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
  var SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
  var TABLE_DELIM_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  function isBlank(text) { return /^[ \t]*$/.test(text); }

  function leadingSpaces(text) {
    var n = 0;
    while (n < text.length && (text[n] === ' ' || text[n] === '\t')) n++;
    return n;
  }

  /** Strips up to `columns` columns of indentation; returns the remaining line. */
  function stripIndent(line, columns) {
    var col = 0;
    var i = 0;
    while (i < line.text.length && col < columns) {
      var ch = line.text[i];
      if (ch === ' ') col += 1;
      else if (ch === '\t') col += 4 - (col % 4);
      else break;
      i++;
    }
    return { text: line.text.slice(i), off: line.off + i };
  }

  function indentColumns(text) {
    var col = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === ' ') col += 1;
      else if (text[i] === '\t') col += 4 - (col % 4);
      else break;
    }
    return col;
  }

  function lineEnd(line) { return line.off + line.text.length; }

  function isMathLine(text) {
    var t = text.trim();
    return t.indexOf('$$') === 0 || t.indexOf('\\[') === 0;
  }

  function startsBlock(text) {
    return FENCE_RE.test(text) || HEADING_RE.test(text) || HR_RE.test(text) ||
      QUOTE_RE.test(text) || LIST_RE.test(text) || isMathBlockStart(text);
  }

  /** `$$` alone or opening a formula that continues, or a whole-line `$$…$$` / `\[…\]`. */
  function isMathBlockStart(text) {
    var t = text.trim();
    if (t === '$$' || t === '\\[') return true;
    if (t.length >= 4 && t.indexOf('$$') === 0 && t.lastIndexOf('$$') === t.length - 2) return true;
    if (t.length >= 4 && t.indexOf('\\[') === 0 && t.lastIndexOf('\\]') === t.length - 2) return true;
    if (t.indexOf('$$') === 0 && t.indexOf('$$', 2) === -1) return true;
    if (t.indexOf('\\[') === 0 && t.indexOf('\\]', 2) === -1) return true;
    return false;
  }

  function parseBlocks(lines) {
    var nodes = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var text = line.text;
      if (isBlank(text)) { i++; continue; }

      var fence = FENCE_RE.exec(text);
      if (fence && !(fence[2][0] === '`' && fence[3].indexOf('`') !== -1)) {
        i = parseFence(lines, i, fence, nodes);
        continue;
      }
      if (isMathBlockStart(text)) {
        i = parseMathBlock(lines, i, nodes);
        continue;
      }
      if (HEADING_RE.test(text)) {
        nodes.push(parseHeading(line));
        i++;
        continue;
      }
      if (HR_RE.test(text)) {
        nodes.push({ type: 'thematicBreak', start: line.off, end: lineEnd(line) });
        i++;
        continue;
      }
      if (QUOTE_RE.test(text)) {
        i = parseQuote(lines, i, nodes);
        continue;
      }
      if (LIST_RE.test(text)) {
        i = parseList(lines, i, nodes);
        continue;
      }
      if (text.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1].text) &&
          lines[i + 1].text.indexOf('-') !== -1) {
        var tableEnd = parseTable(lines, i, nodes);
        if (tableEnd > i) { i = tableEnd; continue; }
      }
      i = parseParagraph(lines, i, nodes);
    }
    return nodes;
  }

  function parseFence(lines, i, match, nodes) {
    var open = lines[i];
    var indent = match[1].length;
    var marker = match[2];
    var info = match[3].trim();
    var body = [];
    var j = i + 1;
    var closed = null;
    var closeRe = new RegExp('^ {0,3}' + (marker[0] === '`' ? '`' : '~') + '{' + marker.length + ',}[ \\t]*$');
    while (j < lines.length) {
      if (closeRe.test(lines[j].text)) { closed = lines[j]; break; }
      body.push(stripIndent(lines[j], indent).text);
      j++;
    }
    var last = closed || (body.length ? lines[j - 1] : open);
    nodes.push({
      type: 'code',
      lang: info.split(/\s+/)[0] || null,
      value: body.join('\n'),
      start: open.off,
      end: lineEnd(last)
    });
    return closed ? j + 1 : j;
  }

  function parseMathBlock(lines, i, nodes) {
    var first = lines[i];
    var t = first.text.trim();
    var dollar = t.indexOf('$$') === 0;
    var open = dollar ? '$$' : '\\[';
    var close = dollar ? '$$' : '\\]';
    var startOff = first.off + first.text.indexOf(open);
    var rest = t.slice(2);
    var closeAt = rest.lastIndexOf(close);
    if (closeAt !== -1 && rest.slice(closeAt + 2).trim() === '') {
      nodes.push({
        type: 'math', value: rest.slice(0, closeAt).trim(),
        start: startOff, end: first.off + first.text.lastIndexOf(close) + 2
      });
      return i + 1;
    }
    var body = rest.trim() ? [rest] : [];
    var j = i + 1;
    while (j < lines.length) {
      var lt = lines[j].text;
      var at = lt.indexOf(close);
      if (at !== -1) {
        if (lt.slice(0, at).trim()) body.push(lt.slice(0, at));
        nodes.push({ type: 'math', value: body.join('\n').trim(), start: startOff, end: lines[j].off + at + 2 });
        return j + 1;
      }
      body.push(lt);
      j++;
    }
    nodes.push({ type: 'math', value: body.join('\n').trim(), start: startOff, end: lineEnd(lines[j - 1]) });
    return j;
  }

  function parseHeading(line) {
    var match = HEADING_RE.exec(line.text);
    var depth = match[2].length;
    var from = match[0].length;
    from += leadingSpaces(line.text.slice(from));
    var content = line.text.slice(from);
    var closing = /(?:^|[ \t]+)#+[ \t]*$/.exec(content);
    if (closing) content = content.slice(0, closing.index);
    content = content.replace(/[ \t]+$/, '');
    var seg = buildSegments([{ text: content, off: line.off + from }]);
    return {
      type: 'heading', depth: depth, start: line.off, end: lineEnd(line),
      children: parseInline(seg.s, seg.m, 0, seg.s.length)
    };
  }

  function parseQuote(lines, i, nodes) {
    var inner = [];
    var j = i;
    var lastWasText = false;
    while (j < lines.length) {
      var line = lines[j];
      var match = QUOTE_RE.exec(line.text);
      if (match) {
        var stripped = { text: line.text.slice(match[0].length), off: line.off + match[0].length };
        inner.push(stripped);
        lastWasText = !isBlank(stripped.text);
        j++;
        continue;
      }
      // Lazy continuation of a quoted paragraph.
      if (lastWasText && !isBlank(line.text) && !startsBlock(line.text)) {
        inner.push({ text: line.text.slice(leadingSpaces(line.text)), off: line.off + leadingSpaces(line.text) });
        j++;
        continue;
      }
      break;
    }
    nodes.push({
      type: 'blockquote', start: lines[i].off, end: lineEnd(lines[j - 1]),
      children: parseBlocks(inner)
    });
    return j;
  }

  function listKind(match) {
    var marker = match[2];
    return /\d/.test(marker[0]) ? 'o' + marker[marker.length - 1] : 'b' + marker;
  }

  function parseList(lines, i, nodes) {
    var first = LIST_RE.exec(lines[i].text);
    var kind = listKind(first);
    var ordered = kind[0] === 'o';
    var list = {
      type: 'list', ordered: ordered,
      startNumber: ordered ? parseInt(first[2], 10) : null,
      spread: false, start: lines[i].off, end: lineEnd(lines[i]), children: []
    };
    var j = i;
    var blankBetween = false;
    while (j < lines.length) {
      var line = lines[j];
      var match = LIST_RE.exec(line.text);
      if (!match || listKind(match) !== kind) break;
      if (blankBetween) list.spread = true;
      var markerEnd = match[1].length + match[2].length;
      var spaceCols = match[3].length;
      var contentIndent;
      var firstText;
      if (match[3] === '' || isBlank(line.text.slice(markerEnd))) {
        contentIndent = markerEnd + 1;
        firstText = { text: '', off: lineEnd(line) };
      } else if (spaceCols > 4) {
        contentIndent = markerEnd + 1;
        firstText = { text: line.text.slice(markerEnd + 1), off: line.off + markerEnd + 1 };
      } else {
        contentIndent = markerEnd + spaceCols;
        firstText = { text: line.text.slice(markerEnd + spaceCols), off: line.off + markerEnd + spaceCols };
      }
      var itemLines = [firstText];
      var k = j + 1;
      var lastNonBlank = !isBlank(firstText.text);
      var sawBlank = false;
      while (k < lines.length) {
        var next = lines[k];
        if (isBlank(next.text)) {
          itemLines.push({ text: '', off: next.off });
          sawBlank = true;
          lastNonBlank = false;
          k++;
          continue;
        }
        if (indentColumns(next.text) >= contentIndent) {
          if (sawBlank) list.spread = list.spread || hasContentAfter(itemLines);
          itemLines.push(stripIndent(next, contentIndent));
          lastNonBlank = true;
          sawBlank = false;
          k++;
          continue;
        }
        if (lastNonBlank && !startsBlock(next.text)) {
          var lead = leadingSpaces(next.text);
          itemLines.push({ text: next.text.slice(lead), off: next.off + lead });
          k++;
          continue;
        }
        break;
      }
      // Trailing blank lines separate items; they do not belong to this one.
      var trailing = 0;
      while (itemLines.length > 1 && isBlank(itemLines[itemLines.length - 1].text)) {
        itemLines.pop();
        trailing++;
      }
      blankBetween = trailing > 0;
      var lastLine = itemLines[itemLines.length - 1];
      var item = {
        type: 'listItem', start: line.off, end: Math.max(lineEnd(lastLine), line.off + markerEnd),
        children: parseBlocks(itemLines)
      };
      list.children.push(item);
      list.end = item.end;
      j = k;
    }
    nodes.push(list);
    return j;
  }

  function hasContentAfter(itemLines) {
    for (var i = 0; i < itemLines.length; i++) if (!isBlank(itemLines[i].text)) return true;
    return false;
  }

  /** Splits a table row into cells, ignoring escaped pipes and pipes in code spans. */
  function splitCells(line) {
    var text = line.text;
    var cells = [];
    var i = leadingSpaces(text);
    if (text[i] === '|') i++;
    var cellStart = i;
    var inCode = 0;
    for (; i <= text.length; i++) {
      var ch = text[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '`') {
        var run = 1;
        while (text[i + run] === '`') run++;
        inCode = inCode === run ? 0 : (inCode === 0 ? run : inCode);
        i += run - 1;
        continue;
      }
      if ((ch === '|' && !inCode) || i === text.length) {
        var raw = text.slice(cellStart, i);
        var lead = leadingSpaces(raw);
        var content = raw.slice(lead).replace(/[ \t]+$/, '');
        cells.push({ text: content, off: line.off + cellStart + lead });
        cellStart = i + 1;
      }
    }
    // A trailing pipe leaves one empty cell behind.
    if (cells.length > 1 && cells[cells.length - 1].text === '' && /\|[ \t]*$/.test(text)) cells.pop();
    return cells;
  }

  function parseTable(lines, i, nodes) {
    var header = splitCells(lines[i]);
    var delim = splitCells(lines[i + 1]);
    if (header.length !== delim.length) return i;
    var align = delim.map(function (cell) {
      var t = cell.text.trim();
      var left = t[0] === ':';
      var right = t[t.length - 1] === ':';
      return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
    });
    function row(line, cells, isHeader) {
      var children = [];
      for (var c = 0; c < header.length; c++) {
        var cell = cells[c] || { text: '', off: lineEnd(line) };
        var seg = buildSegments([cell]);
        children.push({
          type: 'tableCell', header: isHeader, align: align[c],
          start: cell.off, end: cell.off + cell.text.length,
          children: parseInline(seg.s, seg.m, 0, seg.s.length)
        });
      }
      return { type: 'tableRow', start: line.off, end: lineEnd(line), children: children };
    }
    var rows = [row(lines[i], header, true)];
    var j = i + 2;
    while (j < lines.length && !isBlank(lines[j].text) && lines[j].text.indexOf('|') !== -1 && !startsBlock(lines[j].text)) {
      rows.push(row(lines[j], splitCells(lines[j]), false));
      j++;
    }
    nodes.push({ type: 'table', start: lines[i].off, end: lineEnd(lines[j - 1]), children: rows });
    return j;
  }

  function parseParagraph(lines, i, nodes) {
    var collected = [lines[i]];
    var j = i + 1;
    var setext = 0;
    while (j < lines.length) {
      var text = lines[j].text;
      if (isBlank(text)) break;
      var underline = SETEXT_RE.exec(text);
      if (underline) { setext = underline[1][0] === '=' ? 1 : 2; break; }
      if (startsBlock(text)) break;
      collected.push(lines[j]);
      j++;
    }
    var segLines = collected.map(function (line, index) {
      var lead = leadingSpaces(line.text);
      var text = line.text.slice(lead);
      if (index === collected.length - 1) text = text.replace(/[ \t]+$/, '');
      return { text: text, off: line.off + lead };
    });
    var seg = buildSegments(segLines);
    var node = {
      type: setext ? 'heading' : 'paragraph',
      start: collected[0].off,
      end: setext ? lineEnd(lines[j]) : lineEnd(collected[collected.length - 1]),
      children: parseInline(seg.s, seg.m, 0, seg.s.length)
    };
    if (setext) node.depth = setext;
    nodes.push(node);
    return setext ? j + 1 : j;
  }

  /** Joins line segments with '\n', keeping `m[i]` = source offset of `s[i]`. */
  function buildSegments(segLines) {
    var s = '';
    var m = [];
    for (var i = 0; i < segLines.length; i++) {
      var line = segLines[i];
      if (i > 0) {
        var prev = segLines[i - 1];
        s += '\n';
        m.push(prev.off + prev.text.length);
      }
      s += line.text;
      for (var k = 0; k < line.text.length; k++) m.push(line.off + k);
    }
    return { s: s, m: m };
  }

  /* ================= Inline parsing ================= */

  var PUNCT_RE = /[!-\/:-@\[-`{-~]/;
  var WORD_RE = /[A-Za-z0-9À-\uFFFF]/;

  function startOff(m, i) { return i < m.length ? m[i] : endOff(m, i); }
  function endOff(m, j) { return j <= 0 ? (m.length ? m[0] : 0) : m[j - 1] + 1; }

  function pushText(out, s, m, a, b) {
    var from = a;
    for (var k = a + 1; k <= b; k++) {
      if (k === b || m[k] !== m[k - 1] + 1) {
        if (k > from) {
          var prev = out[out.length - 1];
          var value = s.slice(from, k);
          if (prev && prev.type === 'text' && prev.end === m[from] && prev.verbatimJoin) {
            prev.value += value;
            prev.end = endOff(m, k);
          } else {
            out.push({ type: 'text', value: value, start: m[from], end: endOff(m, k), verbatimJoin: true });
          }
        }
        from = k;
      }
    }
  }

  function findCodeClose(s, from, to, run) {
    var i = from;
    while (i < to) {
      if (s[i] === '`') {
        var n = 1;
        while (i + n < to && s[i + n] === '`') n++;
        if (n === run) return i;
        i += n;
      } else {
        i++;
      }
    }
    return -1;
  }

  /** Index after the `]` matching the `[` at `open`, or -1. */
  function matchBracket(s, open, to) {
    var depth = 0;
    for (var i = open; i < to; i++) {
      var ch = s[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '`') {
        var n = 1;
        while (s[i + n] === '`') n++;
        var close = findCodeClose(s, i + n, to, n);
        if (close !== -1) { i = close + n - 1; continue; }
        i += n - 1;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Parses `(dest "title")` at `i`; returns { url, end } with `end` after `)`. */
  function parseDestination(s, i, to) {
    if (s[i] !== '(') return null;
    var j = i + 1;
    while (j < to && (s[j] === ' ' || s[j] === '\n')) j++;
    var url = '';
    if (s[j] === '<') {
      var close = s.indexOf('>', j);
      if (close === -1 || close >= to) return null;
      url = s.slice(j + 1, close);
      j = close + 1;
    } else {
      var depth = 0;
      var begin = j;
      while (j < to) {
        var ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        else if (ch === ' ' || ch === '\n') break;
        j++;
      }
      url = s.slice(begin, j);
    }
    while (j < to && (s[j] === ' ' || s[j] === '\n')) j++;
    if (s[j] === '"' || s[j] === "'" || s[j] === '(') {
      var quote = s[j] === '(' ? ')' : s[j];
      var end = s.indexOf(quote, j + 1);
      if (end === -1 || end >= to) return null;
      j = end + 1;
      while (j < to && (s[j] === ' ' || s[j] === '\n')) j++;
    }
    if (s[j] !== ')') return null;
    return { url: url, end: j + 1 };
  }

  function isSpace(ch) { return ch === undefined || /\s/.test(ch); }

  /** Closing delimiter for emphasis of `size` copies of `ch`, or -1. */
  function findEmphasisClose(s, from, to, ch, size) {
    var i = from;
    while (i < to) {
      var c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        var n = 1;
        while (i + n < to && s[i + n] === '`') n++;
        var close = findCodeClose(s, i + n, to, n);
        i = close === -1 ? i + n : close + n;
        continue;
      }
      if (c === ch) {
        var run = 1;
        while (i + run < to && s[i + run] === ch) run++;
        // A closer is right-flanking: it follows a non-space.
        if (!isSpace(s[i - 1]) && i > from) {
          var after = s[i + run];
          var intraword = ch === '_' && after !== undefined && WORD_RE.test(after);
          if (!intraword) {
            if (run === size) return i;
            if (size === 1 && run >= 3) return i + run - 1;
            if (size === 2 && run === 3) return i;
          }
        }
        i += run;
        continue;
      }
      i++;
    }
    return -1;
  }

  var BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s<]+/;

  function trimUrl(url) {
    var trimmed = url.replace(/[.,:;!?'"*_~]+$/, '');
    while (trimmed.slice(-1) === ')' &&
      (trimmed.match(/\)/g) || []).length > (trimmed.match(/\(/g) || []).length) {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
  }

  function plainText(nodes) {
    return nodes.map(function (node) {
      if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') return node.value;
      if (node.children) return plainText(node.children);
      return '';
    }).join('');
  }

  function parseInline(s, m, from, to) {
    var out = [];
    var textStart = from;
    var i = from;
    function flush(upTo) {
      if (upTo > textStart) pushText(out, s, m, textStart, upTo);
    }
    function emit(node, next) {
      flush(i);
      out.push(node);
      i = next;
      textStart = next;
    }
    while (i < to) {
      var ch = s[i];

      if (ch === '\\') {
        var nx = s[i + 1];
        if (nx === '\n') { emit({ type: 'break', start: m[i], end: endOff(m, i + 2) }, i + 2); continue; }
        if (nx === '(' || nx === '[') {
          var closer = nx === '(' ? '\\)' : '\\]';
          var mathEnd = s.indexOf(closer, i + 2);
          if (mathEnd !== -1 && mathEnd + 2 <= to && s.slice(i + 2, mathEnd).indexOf('\n\n') === -1 && mathEnd > i + 2) {
            emit({
              type: 'inlineMath', display: nx === '[', value: s.slice(i + 2, mathEnd),
              start: m[i], end: endOff(m, mathEnd + 2)
            }, mathEnd + 2);
            continue;
          }
        }
        if (nx !== undefined && i + 1 < to && PUNCT_RE.test(nx)) {
          flush(i);
          out.push({ type: 'text', value: nx, start: m[i + 1], end: endOff(m, i + 2) });
          i += 2;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }

      if (ch === '`') {
        var run = 1;
        while (i + run < to && s[i + run] === '`') run++;
        var close = findCodeClose(s, i + run, to, run);
        if (close !== -1) {
          var value = s.slice(i + run, close).replace(/\n/g, ' ');
          if (value.length > 2 && value[0] === ' ' && value[value.length - 1] === ' ' && value.trim() !== '') {
            value = value.slice(1, -1);
          }
          emit({ type: 'inlineCode', value: value, ticks: run, start: m[i], end: endOff(m, close + run) }, close + run);
          continue;
        }
        i += run;
        continue;
      }

      if (ch === '$') {
        if (s[i + 1] === '$') {
          var dd = s.indexOf('$$', i + 2);
          if (dd !== -1 && dd + 2 <= to && dd > i + 2) {
            emit({ type: 'inlineMath', display: true, value: s.slice(i + 2, dd), start: m[i], end: endOff(m, dd + 2) }, dd + 2);
            continue;
          }
          i += 2;
          continue;
        }
        // Pandoc's rule keeps `$x^2$` and refuses prose like "$5 and $10".
        if (!isSpace(s[i + 1]) && s[i - 1] !== '$') {
          var j = i + 1;
          var found = -1;
          while (j < to) {
            if (s[j] === '\\') { j += 2; continue; }
            if (s[j] === '\n' && s[j + 1] === '\n') break;
            if (s[j] === '$') {
              if (!isSpace(s[j - 1]) && !/\d/.test(s[j + 1] || '') && s[j + 1] !== '$') found = j;
              break;
            }
            j++;
          }
          if (found !== -1) {
            emit({ type: 'inlineMath', display: false, value: s.slice(i + 1, found), start: m[i], end: endOff(m, found + 1) }, found + 1);
            continue;
          }
        }
        i++;
        continue;
      }

      if ((ch === '!' && s[i + 1] === '[') || ch === '[') {
        var bracket = ch === '!' ? i + 1 : i;
        var labelEnd = matchBracket(s, bracket, to);
        if (labelEnd !== -1) {
          var dest = parseDestination(s, labelEnd + 1, to);
          if (dest) {
            var children = parseInline(s, m, bracket + 1, labelEnd);
            if (ch === '!') {
              emit({ type: 'image', url: dest.url, alt: plainText(children), start: m[i], end: endOff(m, dest.end) }, dest.end);
            } else {
              emit({ type: 'link', url: dest.url, start: m[i], end: endOff(m, dest.end), children: children }, dest.end);
            }
            continue;
          }
        }
        i++;
        continue;
      }

      if (ch === '<') {
        var auto = /^<(https?:\/\/[^\s<>]+)>/.exec(s.slice(i, Math.min(to, i + 2048)));
        if (auto) {
          var linkEnd = i + auto[0].length;
          var inner = [];
          pushText(inner, s, m, i + 1, linkEnd - 1);
          emit({ type: 'link', url: auto[1], start: m[i], end: endOff(m, linkEnd), children: inner }, linkEnd);
          continue;
        }
        i++;
        continue;
      }

      if ((ch === 'h' || ch === 'w') && (i === from || /[\s(*_~]/.test(s[i - 1]))) {
        var bare = BARE_URL_RE.exec(s.slice(i, Math.min(to, i + 2048)));
        if (bare) {
          var url = trimUrl(bare[0]);
          if (url.length > 8) {
            var urlEnd = i + url.length;
            var urlText = [];
            pushText(urlText, s, m, i, urlEnd);
            emit({
              type: 'link', url: url.indexOf('www.') === 0 ? 'http://' + url : url,
              start: m[i], end: endOff(m, urlEnd), children: urlText
            }, urlEnd);
            continue;
          }
        }
        i++;
        continue;
      }

      if (ch === '~' && s[i + 1] === '~' && !isSpace(s[i + 2])) {
        var tilde = findEmphasisClose(s, i + 2, to, '~', 2);
        if (tilde !== -1) {
          emit({ type: 'delete', start: m[i], end: endOff(m, tilde + 2), children: parseInline(s, m, i + 2, tilde) }, tilde + 2);
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === '*' || ch === '_') {
        var count = 1;
        while (i + count < to && s[i + count] === ch) count++;
        var leftFlanking = !isSpace(s[i + count]) && !(ch === '_' && i > 0 && WORD_RE.test(s[i - 1] || ''));
        if (leftFlanking) {
          if (count >= 3) {
            var both = findEmphasisClose(s, i + 3, to, ch, 3);
            if (both !== -1) {
              emit({
                type: 'emphasis', start: m[i], end: endOff(m, both + 3),
                children: [{ type: 'strong', start: startOff(m, i + 1), end: endOff(m, both + 2), children: parseInline(s, m, i + 3, both) }]
              }, both + 3);
              continue;
            }
          }
          if (count >= 2) {
            var strongClose = findEmphasisClose(s, i + 2, to, ch, 2);
            if (strongClose !== -1 && strongClose > i + 2) {
              emit({ type: 'strong', start: m[i], end: endOff(m, strongClose + 2), children: parseInline(s, m, i + 2, strongClose) }, strongClose + 2);
              continue;
            }
          }
          if (count === 1 || count >= 2) {
            var emClose = findEmphasisClose(s, i + 1, to, ch, 1);
            if (count === 1 && emClose !== -1 && emClose > i + 1) {
              emit({ type: 'emphasis', start: m[i], end: endOff(m, emClose + 1), children: parseInline(s, m, i + 1, emClose) }, emClose + 1);
              continue;
            }
          }
        }
        i += count;
        continue;
      }

      if (ch === '\n' && i >= 2 && s[i - 1] === ' ' && s[i - 2] === ' ') {
        var spaces = i;
        while (spaces > textStart && s[spaces - 1] === ' ') spaces--;
        flush(spaces);
        out.push({ type: 'break', start: m[spaces], end: endOff(m, i + 1) });
        i += 1;
        textStart = i;
        continue;
      }

      i++;
    }
    flush(to);
    for (var n = 0; n < out.length; n++) delete out[n].verbatimJoin;
    return out;
  }

  function parse(source) {
    var text = String(source || '');
    var lines = [];
    var off = 0;
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      var lineText = parts[i];
      // A CR before the newline is not content.
      if (lineText.slice(-1) === '\r') lineText = lineText.slice(0, -1);
      lines.push({ text: lineText, off: off });
      off += parts[i].length + 1;
    }
    return { type: 'root', start: 0, end: text.length, children: parseBlocks(lines) };
  }

  /* ================= Anchoring ================= */

  var ATOMS = { code: 1, inlineCode: 1, math: 1, inlineMath: 1, image: 1 };
  var INLINE_WRAPPERS = { strong: 1, emphasis: 1, delete: 1, link: 1 };
  var PHRASING_PARENTS = { paragraph: 1, heading: 1, tableCell: 1, strong: 1, emphasis: 1, delete: 1, link: 1 };

  function overlappingChildren(node, range) {
    return (node.children || []).filter(function (child) {
      return child.end > range.start && child.start < range.end;
    });
  }

  function isVerbatimText(node, source) {
    return source.slice(node.start, node.end) === node.value;
  }

  function anchorInRun(parent, run, range, source) {
    if (!PHRASING_PARENTS[parent.type]) return null;
    var first = run[0];
    var last = run[run.length - 1];
    if (first.type === 'text' && !isVerbatimText(first, source)) return null;
    if (last.type === 'text' && !isVerbatimText(last, source)) return null;
    return {
      // An edge inside bold or a link takes in the whole element: it cannot be split.
      start: first.type === 'text' ? Math.max(range.start, first.start) : first.start,
      end: last.type === 'text' ? Math.min(range.end, last.end) : last.end,
      kind: 'inline'
    };
  }

  function anchorIn(node, range, source) {
    var overlapping = overlappingChildren(node, range);
    if (overlapping.length === 0) return null;
    if (overlapping.length > 1) return anchorInRun(node, overlapping, range, source);
    var child = overlapping[0];
    if (child.type === 'text') {
      return { start: Math.max(range.start, child.start), end: Math.min(range.end, child.end), kind: 'text' };
    }
    if (ATOMS[child.type]) return { start: child.start, end: child.end, kind: 'atom' };
    if (child.type === 'break') return null;
    if (INLINE_WRAPPERS[child.type] && range.start <= child.start && range.end >= child.end) {
      return { start: child.start, end: child.end, kind: 'inline' };
    }
    return anchorIn(child, range, source);
  }

  /** The range an expansion would take for a selection, or null when it crosses blocks. */
  function anchoredRange(source, range) {
    if (range.start >= range.end) return null;
    return anchorIn(parse(source), range, source);
  }

  function isAnchoredRange(source, range) {
    var anchored = anchoredRange(source, range);
    return anchored !== null && anchored.start === range.start && anchored.end === range.end;
  }

  /** Whether this slice shows the same with or without markdown rendering. */
  function isPlainMarkdown(text) {
    if (!/[*_`$~[\]\\<]|^\s*(#|>|\d+[.)]\s|[-+]\s)|https?:|www\./m.test(text)) return true;
    var tree = parse(text);
    if (tree.children.length !== 1 || tree.children[0].type !== 'paragraph') return false;
    var inner = tree.children[0].children;
    return inner.length === 1 && inner[0].type === 'text' && inner[0].value === text;
  }

  /* ================= Splicing expansions ================= */

  function textNode(value, start, end) {
    return { type: 'text', value: value, start: start, end: end };
  }

  function spliceRun(children, firstIndex, lastIndex, expansion) {
    var first = children[firstIndex];
    var last = children[lastIndex];
    var nodes = [];
    if (first.type === 'text') {
      var before = first.value.slice(0, expansion.start - first.start);
      if (before !== '') nodes.push(textNode(before, first.start, expansion.start));
    }
    nodes.push({ type: 'expansion', id: expansion.id, start: expansion.start, end: expansion.end });
    if (last.type === 'text') {
      var after = last.value.slice(expansion.end - last.start);
      if (after !== '') nodes.push(textNode(after, expansion.end, last.end));
    }
    Array.prototype.splice.apply(children, [firstIndex, lastIndex - firstIndex + 1].concat(nodes));
  }

  function spliceInChildren(parent, expansion) {
    var children = parent.children;
    if (!children) return false;
    var overlapping = overlappingChildren(parent, expansion);
    if (overlapping.length === 0) return false;
    var firstIndex = children.indexOf(overlapping[0]);
    var lastIndex = children.indexOf(overlapping[overlapping.length - 1]);
    var first = overlapping[0];
    var last = overlapping[overlapping.length - 1];

    if (overlapping.length > 1) {
      if (!PHRASING_PARENTS[parent.type]) return false;
      if (first.type !== 'text' && first.start < expansion.start) return false;
      if (last.type !== 'text' && last.end > expansion.end) return false;
      if (first.type === 'text' && first.start > expansion.start) return false;
      if (last.type === 'text' && last.end < expansion.end) return false;
      spliceRun(children, firstIndex, lastIndex, expansion);
      return true;
    }
    var contains = first.start <= expansion.start && expansion.end <= first.end;
    if (!contains) return false;
    if (first.type === 'text') {
      spliceRun(children, firstIndex, firstIndex, expansion);
      return true;
    }
    var whole = first.start === expansion.start && first.end === expansion.end;
    if (whole && (ATOMS[first.type] || INLINE_WRAPPERS[first.type])) {
      spliceRun(children, firstIndex, firstIndex, expansion);
      return true;
    }
    return spliceInChildren(first, expansion);
  }

  function sameRange(a, b) { return a.start === b.start && a.end === b.end; }

  function activeOf(group) {
    for (var i = group.length - 1; i >= 0; i--) if (!group[i].folded) return group[i];
    return group[group.length - 1];
  }

  /** Several expansions on one range share one place in the text: the active one. */
  function visibleExpansions(expansions) {
    var visible = [];
    expansions.forEach(function (node) {
      if (visible.some(function (other) { return sameRange(other, node); })) return;
      var active = activeOf(expansions.filter(function (other) { return sameRange(other, node); }));
      if (active) visible.push(active);
    });
    return visible.sort(function (a, b) { return a.start - b.start; });
  }

  function prepareTree(source, expansions) {
    var tree = parse(source);
    visibleExpansions(expansions || []).forEach(function (expansion) { spliceInChildren(tree, expansion); });
    return tree;
  }

  /* ================= DOM rendering ================= */

  var SAFE_PROTOCOL = /^https?:/i;

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function atomAttrs(node, element, ctx) {
    if (!ctx.anchored) return;
    element.setAttribute('data-atom-start', String(node.start));
    element.setAttribute('data-atom-end', String(node.end));
  }

  function renderMathNode(node, display, ctx) {
    var host = el('span', display ? 'md-math md-math-display' : 'md-math');
    atomAttrs(node, host, ctx);
    var rendered = null;
    if (ctx.renderMath) {
      try { rendered = ctx.renderMath(node.value, display); } catch (e) { rendered = null; }
    }
    if (rendered) {
      host.appendChild(rendered);
    } else {
      var code = el('code', 'md-math-source');
      code.textContent = node.value;
      host.appendChild(code);
    }
    return host;
  }

  function renderCodeBlock(node, ctx) {
    var pre = el(ctx.inline ? 'span' : 'pre', ctx.inline ? 'md-pre' : '');
    var code = el('code', node.lang ? 'language-' + node.lang : '');
    code.textContent = node.value;
    atomAttrs(node, code, ctx);
    pre.appendChild(code);
    if (ctx.inline) return pre;
    var wrap = el('div', 'md-codeblock');
    if (node.lang) {
      var label = el('span', 'md-codeblock-lang');
      label.textContent = node.lang;
      wrap.appendChild(label);
    }
    wrap.appendChild(pre);
    var copy = el('button', 'md-codeblock-copy');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      copyToClipboard(node.value).then(function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      });
    });
    wrap.appendChild(copy);
    return wrap;
  }

  function renderChildren(parent, nodes, ctx) {
    for (var i = 0; i < nodes.length; i++) {
      var rendered = renderNode(nodes[i], ctx);
      if (rendered) parent.appendChild(rendered);
    }
    return parent;
  }

  var BLOCK_CLASS = {
    paragraph: ['p', 'md-p'], blockquote: ['blockquote', 'md-quote'], listItem: ['li', 'md-li'],
    table: ['table', 'md-table'], tableRow: ['tr', 'md-row']
  };

  function renderNode(node, ctx) {
    switch (node.type) {
      case 'text': {
        if (!ctx.anchored) return document.createTextNode(node.value);
        var span = el('span');
        span.setAttribute('data-src', String(node.start));
        span.textContent = node.value;
        return span;
      }
      case 'break':
        return el('br');
      case 'expansion': {
        var entry = ctx.expansions.get(node.id);
        return entry && ctx.renderExpansion ? ctx.renderExpansion(entry.node, entry.group) : null;
      }
      case 'strong':
        return renderChildren(el('strong'), node.children, ctx);
      case 'emphasis':
        return renderChildren(el('em'), node.children, ctx);
      case 'delete':
        return renderChildren(el('del'), node.children, ctx);
      case 'link': {
        var url = String(node.url || '').trim();
        var link;
        if (SAFE_PROTOCOL.test(url)) {
          link = el('a', 'md-link');
          link.href = url;
          link.title = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else {
          link = el('span', 'md-link');
        }
        return renderChildren(link, node.children, ctx);
      }
      case 'image': {
        // Images render as their alt text: no remote fetch from model output.
        var img = el('span', 'md-img');
        img.textContent = node.alt || node.url || '';
        atomAttrs(node, img, ctx);
        return img;
      }
      case 'inlineCode': {
        var code = el('code');
        if (ctx.anchored) code.setAttribute('data-src', String(node.start + (node.ticks || 1)));
        code.textContent = node.value;
        return code;
      }
      case 'inlineMath':
        return renderMathNode(node, !!node.display, ctx);
      case 'math':
        return renderMathNode(node, true, ctx);
      case 'code':
        return renderCodeBlock(node, ctx);
      case 'thematicBreak':
        return ctx.inline ? el('span', 'md-hr') : el('hr');
      case 'heading':
        return renderChildren(ctx.inline ? el('span', 'md-h' + node.depth) : el('h' + node.depth), node.children, ctx);
      case 'list': {
        var list = ctx.inline
          ? el('span', 'md-list ' + (node.ordered ? 'md-ol' : 'md-ul'))
          : el(node.ordered ? 'ol' : 'ul');
        if (!ctx.inline && node.ordered && node.startNumber !== null && node.startNumber !== 1) {
          list.setAttribute('start', String(node.startNumber));
        }
        if (node.spread) list.classList.add('md-loose');
        for (var i = 0; i < node.children.length; i++) {
          var item = renderNode(node.children[i], ctx);
          if (ctx.inline) {
            var marker = el('span', 'md-li-marker');
            marker.textContent = node.ordered ? ((node.startNumber || 1) + i) + '.' : '•';
            item.insertBefore(marker, item.firstChild);
          }
          list.appendChild(item);
        }
        return list;
      }
      case 'table': {
        if (ctx.inline) return renderChildren(el('span', 'md-table'), node.children, ctx);
        var wrap = el('div', 'md-table-wrap');
        var table = el('table');
        var head = el('thead');
        var body = el('tbody');
        node.children.forEach(function (row, index) {
          (index === 0 ? head : body).appendChild(renderNode(row, ctx));
        });
        table.appendChild(head);
        if (body.childNodes.length) table.appendChild(body);
        wrap.appendChild(table);
        return wrap;
      }
      case 'tableCell': {
        var cell = ctx.inline ? el('span', 'md-cell') : el(node.header ? 'th' : 'td');
        if (node.align && !ctx.inline) cell.style.textAlign = node.align;
        return renderChildren(cell, node.children, ctx);
      }
      default: {
        var pair = BLOCK_CLASS[node.type];
        if (!pair) return null;
        return renderChildren(ctx.inline ? el('span', pair[1]) : el(pair[0]), node.children || [], ctx);
      }
    }
  }

  /**
   * Renders `source` with its expansions spliced in.
   * options: { inline, anchored = true, renderExpansion(node, group) -> Node, renderMath(tex, display) -> Node }
   */
  function render(source, expansions, options) {
    var opts = options || {};
    var list = expansions || [];
    var map = new Map();
    list.forEach(function (node) {
      map.set(node.id, { node: node, group: list.filter(function (other) { return sameRange(other, node); }) });
    });
    var ctx = {
      inline: !!opts.inline,
      anchored: opts.anchored !== false,
      renderExpansion: opts.renderExpansion,
      renderMath: opts.renderMath || root.DeltaMarkdownMath || null,
      expansions: map
    };
    var tree = ctx.anchored ? prepareTree(source, list) : parse(source);
    var host = el(ctx.inline ? 'span' : 'div', ctx.inline ? 'markdown-inline' : 'markdown-body');
    return renderChildren(host, tree.children, ctx);
  }

  /* ================= Selection mapping ================= */

  var FRAME_SELECTOR = '[data-expansion-id]';
  var ATOM_SELECTOR = '[data-atom-start]';

  function frameIdOf(element) {
    var frame = element && element.closest ? element.closest(FRAME_SELECTOR) : null;
    if (!frame) return null;
    var id = Number(frame.getAttribute('data-expansion-id'));
    return Number.isFinite(id) ? id : null;
  }

  function anchorOfText(text, offset, prefer) {
    var host = text.parentElement;
    if (!host) return null;
    if (!host.hasAttribute('data-src')) {
      // Code blocks and formulas have no per-character mapping: they count whole.
      var atom = host.closest(ATOM_SELECTOR);
      if (!atom) return null;
      var edge = Number(atom.getAttribute(prefer === 'start' ? 'data-atom-start' : 'data-atom-end'));
      return Number.isFinite(edge) ? { offset: edge, frameId: frameIdOf(atom) } : null;
    }
    var base = Number(host.getAttribute('data-src'));
    if (!Number.isFinite(base)) return null;
    return { offset: base + offset, frameId: frameIdOf(host) };
  }

  function firstTextInside(node) {
    if (node.nodeType === 3) return node;
    return document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
  }

  function lastTextInside(node) {
    if (node.nodeType === 3) return node;
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    var last = null;
    var current = walker.nextNode();
    while (current) { last = current; current = walker.nextNode(); }
    return last;
  }

  function resolveAnchor(node, offset, prefer) {
    if (node.nodeType === 3) return anchorOfText(node, offset, prefer);
    var children = Array.prototype.slice.call(node.childNodes);
    var i, text, anchor;
    if (prefer === 'start') {
      for (i = offset; i < children.length; i++) {
        text = firstTextInside(children[i]);
        anchor = text ? anchorOfText(text, 0, prefer) : null;
        if (anchor) return anchor;
      }
      return null;
    }
    for (i = Math.min(offset, children.length) - 1; i >= 0; i--) {
      text = lastTextInside(children[i]);
      anchor = text ? anchorOfText(text, text.length, prefer) : null;
      if (anchor) return anchor;
    }
    return null;
  }

  /** Maps a DOM Range onto `{ start, end, frameId }` source offsets, or null. */
  function anchorsFromRange(range) {
    var start = resolveAnchor(range.startContainer, range.startOffset, 'start');
    var end = resolveAnchor(range.endContainer, range.endOffset, 'end');
    if (!start || !end) return null;
    if (start.frameId !== end.frameId) return null;
    if (end.offset <= start.offset) return null;
    return { start: start.offset, end: end.offset, frameId: start.frameId };
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(area);
  }

  root.DeltaMarkdown = {
    parse: parse,
    prepareTree: prepareTree,
    anchoredRange: anchoredRange,
    isAnchoredRange: isAnchoredRange,
    isPlainMarkdown: isPlainMarkdown,
    render: render,
    anchorsFromRange: anchorsFromRange,
    copyToClipboard: copyToClipboard
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
