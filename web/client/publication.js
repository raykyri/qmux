// @ts-check
// This checked source is copied verbatim into the server bundle and hashed for CSP.
/**
 * @typedef {{start: number, end: number}} Offsets
 * @typedef {Offsets & {exact: string, prefix: string, suffix: string, nodeId: string}} Anchor
 * @typedef {Offsets & {nodeId: string, range: Range, card: HTMLAnchorElement | null, connector?: SVGGElement | null}} ResolvedAnchor
 * @typedef {Offsets & {contextStart: number, contextEnd: number, rect: DOMRect}} SelectedPassage
 */
(() => {
  // Copy-as-Markdown buttons: hidden in the static markup, revealed only when
  // a clipboard is actually available, sourcing the raw markdown from an
  // adjacent JSON data tag.
  var copyButtons = document.querySelectorAll("button[data-qmux-copy]");
  for (var bIndex = 0; bIndex < copyButtons.length; bIndex += 1) {
    (/** @param {HTMLButtonElement} button */ function (button) {
      var source = document.getElementById(button.getAttribute("data-qmux-copy") || "");
      if (!source || !navigator.clipboard) return;
      /** @type {string} */
      var markdown;
      try { markdown = JSON.parse(source.textContent || '""'); } catch (err) { return; }
      if (typeof markdown !== "string" || !markdown) return;
      button.hidden = false;
      var label = button.textContent;
      /** @type {number | null} */
  var restoreTimer = null;
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(markdown).then(function () {
          button.textContent = "Copied";
          if (restoreTimer) clearTimeout(restoreTimer);
          restoreTimer = window.setTimeout(function () {
            button.textContent = label;
          }, 1600);
        });
      });
    })(/** @type {HTMLButtonElement} */ (copyButtons[bIndex]));
  }

  const answerRoot = document.getElementById("qmux-answer-root");
  if (!answerRoot) return;
  const root = answerRoot;
  var rail = /** @type {HTMLElement | null} */ (document.querySelector(".research-followups"));
  var grid = /** @type {HTMLElement | null} */ (document.querySelector(".research-response-grid"));
  /** @type {SVGSVGElement | null} */
  var connectorSvg = null;

  // The rendered-text projection: what anchor offsets and quotes refer to.
  /** @type {Node[]} */
  var nodes = [];
  /** @type {number[]} */
  var starts = [];
  var text = "";
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
    starts.push(text.length);
    text += walker.currentNode.nodeValue;
  }

  // An empty side constrains nothing, matching the app's resolver: context is
  // captured clamped to the passage's enclosing message, so a quote reaching
  // that message's edge saves none on that side — and a whole conversation
  // turn, which is one message, saves none on either. Reading emptiness as
  // "must sit at the projection's own edge" left those anchors unpainted here
  // while the app placed them fine.
  /** @param {number} start @param {number} exactLength @param {string} prefix @param {string} suffix */
  function contextMatches(start, exactLength, prefix, suffix) {
    var end = start + exactLength;
    var prefixOk =
      !prefix || text.slice(Math.max(0, start - prefix.length), start) === prefix;
    var suffixOk = !suffix || text.slice(end, end + suffix.length) === suffix;
    return prefixOk && suffixOk;
  }

  /** @param {Anchor} anchor */
  function resolveOffsets(anchor) {
    if (!anchor.exact) return null;
    if (
      anchor.start >= 0 &&
      anchor.end <= text.length &&
      text.slice(anchor.start, anchor.end) === anchor.exact &&
      contextMatches(anchor.start, anchor.exact.length, anchor.prefix, anchor.suffix)
    ) {
      return { start: anchor.start, end: anchor.end };
    }
    var best = -1;
    var bestDistance = Infinity;
    var candidate = text.indexOf(anchor.exact);
    while (candidate >= 0) {
      if (contextMatches(candidate, anchor.exact.length, anchor.prefix, anchor.suffix)) {
        var distance = Math.abs(candidate - anchor.start);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      candidate = text.indexOf(anchor.exact, candidate + 1);
    }
    return best >= 0 ? { start: best, end: best + anchor.exact.length } : null;
  }

  /** @param {number} offset */
  function positionAt(offset) {
    for (var index = nodes.length - 1; index >= 0; index -= 1) {
      if (starts[index] <= offset) {
        return {
          node: nodes[index],
          offset: Math.min(offset - starts[index], (nodes[index].nodeValue || "").length),
        };
      }
    }
    return null;
  }

  /** @param {Offsets} offsets */
  function rangeFor(offsets) {
    var start = positionAt(offsets.start);
    var end = positionAt(offsets.end);
    if (!start || !end) return null;
    var range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  var canPaint = typeof Highlight !== "undefined" && CSS.highlights;

  // ------------------------------------------------------------------
  // Published query anchors: paint passages and anchor cards beside them.
  var dataEl = document.getElementById("qmux-anchor-data");
  /** @type {Anchor[]} */
  var anchors = [];
  if (dataEl) {
    try { anchors = JSON.parse(dataEl.textContent || "[]"); } catch (err) { anchors = []; }
    if (!Array.isArray(anchors)) anchors = [];
  }

  /** @type {Record<string, HTMLAnchorElement>} */
  var cardById = {};
  var anchoredCards = rail
    ? /** @type {NodeListOf<HTMLAnchorElement>} */ (rail.querySelectorAll("[data-anchor-node-id]"))
    : [];
  for (var cIndex = 0; cIndex < anchoredCards.length; cIndex += 1) {
    cardById[anchoredCards[cIndex].getAttribute("data-anchor-node-id") || ""] =
      anchoredCards[cIndex];
  }

  /** @type {ResolvedAnchor[]} */
  var resolved = [];
  for (var index = 0; index < anchors.length; index += 1) {
    var offsets = resolveOffsets(anchors[index]);
    if (!offsets) continue;
    var range = rangeFor(offsets);
    if (!range) continue;
    resolved.push({
      nodeId: anchors[index].nodeId,
      range: range,
      start: offsets.start,
      end: offsets.end,
      card: cardById[anchors[index].nodeId] || null,
    });
  }

  if (resolved.length > 0 && canPaint) {
    var highlight = new Highlight();
    for (var hIndex = 0; hIndex < resolved.length; hIndex += 1) {
      highlight.add(resolved[hIndex].range);
    }
    CSS.highlights.set("qmux-research-query-anchors", highlight);

    // Regions where two or more anchors stack, repainted near the text color
    // (all anchors share one wash, so stacked coverage
    // would otherwise be invisible). Mirrors the app's overlap layer.
    var events = [];
    for (var oIndex = 0; oIndex < resolved.length; oIndex += 1) {
      events.push({ at: resolved[oIndex].start, delta: 1 });
      events.push({ at: resolved[oIndex].end, delta: -1 });
    }
    events.sort(function (a, b) { return a.at - b.at || a.delta - b.delta; });
    var overlaps = new Highlight();
    overlaps.priority = 1;
    var paintedOverlap = false;
    var depth = 0;
    var regionStart = null;
    for (var eIndex = 0; eIndex < events.length; eIndex += 1) {
      depth += events[eIndex].delta;
      if (depth >= 2 && regionStart === null) {
        regionStart = events[eIndex].at;
      } else if (depth < 2 && regionStart !== null) {
        if (events[eIndex].at > regionStart) {
          var overlapRange = rangeFor({ start: regionStart, end: events[eIndex].at });
          if (overlapRange) {
            overlaps.add(overlapRange);
            paintedOverlap = true;
          }
        }
        regionStart = null;
      }
    }
    if (paintedOverlap) {
      CSS.highlights.set("qmux-research-highlight-overlaps", overlaps);
    }
  }

  // Hover linking, both directions, as in the app: hovering the passage links
  // its card, and clicking the passage opens the follow-up. The passage keeps
  // its stable base paint throughout hover to avoid asynchronous highlight
  // registry repaint artifacts.
  /** @type {ResolvedAnchor | null} */
  var linkedEntry = null;
  /** @param {ResolvedAnchor | null} entry */
  function setLinkedEntry(entry) {
    if (entry === linkedEntry) return;
    if (linkedEntry && linkedEntry.card) {
      linkedEntry.card.classList.remove("is-anchor-linked");
    }
    if (linkedEntry && linkedEntry.connector) {
      linkedEntry.connector.classList.remove("is-anchor-linked");
    }
    linkedEntry = entry;
    if (entry && entry.card) {
      entry.card.classList.add("is-anchor-linked");
    }
    if (entry && entry.connector) {
      entry.connector.classList.add("is-anchor-linked");
    }
    root.classList.toggle("is-highlight-hovered", Boolean(entry));
  }

  /** @param {number} clientX @param {number} clientY */
  function absoluteOffsetAt(clientX, clientY) {
    var node = null;
    var offset = 0;
    if (document.caretRangeFromPoint) {
      var caret = document.caretRangeFromPoint(clientX, clientY);
      if (caret) {
        node = caret.startContainer;
        offset = caret.startOffset;
      }
    } else if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(clientX, clientY);
      if (position) {
        node = position.offsetNode;
        offset = position.offset;
      }
    }
    if (!node || node.nodeType !== 3) return -1;
    var nodeIndex = nodes.indexOf(node);
    if (nodeIndex < 0) return -1;
    return starts[nodeIndex] + offset;
  }

  /** @param {MouseEvent} event */
  function entryAtPoint(event) {
    var offset = absoluteOffsetAt(event.clientX, event.clientY);
    if (offset < 0) return null;
    for (var pIndex = 0; pIndex < resolved.length; pIndex += 1) {
      if (offset >= resolved[pIndex].start && offset < resolved[pIndex].end) {
        return resolved[pIndex];
      }
    }
    return null;
  }

  if (resolved.length > 0) {
    root.addEventListener("mousemove", function (event) {
      setLinkedEntry(entryAtPoint(event));
    });
    root.addEventListener("mouseleave", function () {
      setLinkedEntry(null);
    });
    root.addEventListener("click", function (event) {
      var entry = entryAtPoint(event);
      if (entry && entry.card && entry.card.href) {
        window.location.href = entry.card.href;
      }
    });
    for (var lIndex = 0; lIndex < resolved.length; lIndex += 1) {
      (function (entry) {
        const card = entry.card;
        if (!card) return;
        card.addEventListener("mouseenter", function () {
          setLinkedEntry(entry);
        });
        card.addEventListener("mouseleave", function () {
          setLinkedEntry(null);
        });
        // Keyboard parity for the hover link: tabbing onto a card links the
        // pair, scrolling its passage into view when it sits off screen.
        // Guarded to focus-visible so mouse clicks don't jerk the page
        // before navigating.
        card.addEventListener("focus", function () {
          if (!card.matches(":focus-visible")) return;
          setLinkedEntry(entry);
          var passage = entry.range.getBoundingClientRect();
          if (passage.top < 0 || passage.bottom > window.innerHeight) {
            var target = entry.range.startContainer.parentElement;
            if (target) target.scrollIntoView({ block: "center" });
          }
        });
        card.addEventListener("blur", function () {
          setLinkedEntry(null);
        });
      })(resolved[lIndex]);
    }
  }

  // Rounded-elbow connector path: out from the passage's line into the
  // gutter, a vertical run at midX, then into the card at the card's own
  // height. Degenerates to a straight segment when the pair is level or the
  // gutter is too tight for the turns. Ported from the app's research
  // document (connectorElbowPath).
  /** @param {number} sx @param {number} sy @param {number} ex @param {number} ey @param {number} midX */
  function connectorElbowPath(sx, sy, ex, ey, midX) {
    var dy = ey - sy;
    if (Math.abs(dy) < 2 || ex - sx < 8) {
      return "M " + sx + " " + sy + " L " + ex + " " + ey;
    }
    var radius = Math.min(10, Math.abs(dy) / 2, midX - sx, ex - midX);
    var dir = dy > 0 ? 1 : -1;
    return "M " + sx + " " + sy + " L " + (midX - radius) + " " + sy +
      " Q " + midX + " " + sy + " " + midX + " " + (sy + dir * radius) +
      " L " + midX + " " + (ey - dir * radius) +
      " Q " + midX + " " + ey + " " + (midX + radius) + " " + ey +
      " L " + ex + " " + ey;
  }

  function clearConnectors() {
    for (var ccIndex = 0; ccIndex < resolved.length; ccIndex += 1) {
      resolved[ccIndex].connector = null;
    }
    if (connectorSvg) {
      connectorSvg.remove();
      connectorSvg = null;
    }
  }

  // Dotted elbow leaders from each passage's first line to its anchored card,
  // as in the app. Overlapping vertical runs are assigned gutter lanes by
  // greedy interval colouring (top-to-bottom) and fanned leftward one lane
  // step per collision, capped per run so it never crowds the passage edge.
  function drawConnectors() {
    clearConnectors();
    if (!grid || !rail || window.innerWidth < 900) return;
    var gridRect = grid.getBoundingClientRect();
    var startX = Math.round(root.getBoundingClientRect().right - gridRect.left) + 8;
    var geometry = [];
    for (var gcIndex = 0; gcIndex < resolved.length; gcIndex += 1) {
      var connectorEntry = resolved[gcIndex];
      if (!connectorEntry.card || !connectorEntry.card.classList.contains("is-anchored")) {
        continue;
      }
      var lineRects = connectorEntry.range.getClientRects();
      var firstLine = null;
      for (var flIndex = 0; flIndex < lineRects.length; flIndex += 1) {
        if (lineRects[flIndex].width > 0) {
          firstLine = lineRects[flIndex];
          break;
        }
      }
      if (!firstLine) continue;
      var cardRect = connectorEntry.card.getBoundingClientRect();
      geometry.push({
        entry: connectorEntry,
        sy: Math.round(firstLine.top + firstLine.height / 2 - gridRect.top),
        ex: Math.round(cardRect.left - gridRect.left) - 6,
        ey: Math.round(cardRect.top - gridRect.top) + 17,
      });
    }
    if (geometry.length === 0) return;
    /** @type {number[]} */
  var laneEnds = [];
    /** @type {Record<number, number>} */
  var laneByIndex = {};
    geometry
      .map(function (run, index) {
        return {
          index: index,
          top: Math.min(run.sy, run.ey),
          bottom: Math.max(run.sy, run.ey),
        };
      })
      .sort(function (a, b) { return a.top - b.top || a.index - b.index; })
      .forEach(function (run) {
        var lane = -1;
        for (var laneIndex = 0; laneIndex < laneEnds.length; laneIndex += 1) {
          if (laneEnds[laneIndex] <= run.top) {
            lane = laneIndex;
            break;
          }
        }
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = run.bottom;
        laneByIndex[run.index] = lane;
      });
    const svgNs = "http://www.w3.org/2000/svg";
    connectorSvg = document.createElementNS(svgNs, "svg");
    connectorSvg.setAttribute("class", "research-anchor-connector");
    connectorSvg.setAttribute("aria-hidden", "true");
    for (var pcIndex = 0; pcIndex < geometry.length; pcIndex += 1) {
      var piece = geometry[pcIndex];
      var lane = laneByIndex[pcIndex] || 0;
      var maxOffset = 0.25 * (piece.ex - startX);
      var offset = Math.min(lane * 14, maxOffset);
      var midX = Math.round((startX + piece.ex) / 2 - offset);
      var pair = document.createElementNS(svgNs, "g");
      pair.setAttribute("class", "research-anchor-connector-pair");
      var pathEl = document.createElementNS(svgNs, "path");
      pathEl.setAttribute("d", connectorElbowPath(startX, piece.sy, piece.ex, piece.ey, midX));
      var dotEl = document.createElementNS(svgNs, "circle");
      dotEl.setAttribute("cx", String(startX));
      dotEl.setAttribute("cy", String(piece.sy));
      dotEl.setAttribute("r", "2");
      pair.appendChild(pathEl);
      pair.appendChild(dotEl);
      connectorSvg.appendChild(pair);
      piece.entry.connector = pair;
    }
    grid.appendChild(connectorSvg);
  }

  function positionCards() {
    if (!rail) return;
    // The narrow layout stacks the rail under the answer; anchored absolute
    // positioning has no passage-adjacent meaning there, so restore the flow.
    var cardsContainer = /** @type {HTMLElement | null} */ (rail.querySelector(".research-followup-cards"));
    if (window.innerWidth < 900) {
      for (var nIndex = 0; nIndex < anchoredCards.length; nIndex += 1) {
        anchoredCards[nIndex].classList.remove("is-anchored");
        anchoredCards[nIndex].style.top = "";
      }
      rail.style.minHeight = "";
      if (cardsContainer) cardsContainer.style.marginTop = "";
      clearConnectors();
      return;
    }
    if (cardsContainer) cardsContainer.style.marginTop = "";
    var railRect = rail.getBoundingClientRect();
    var entries = [];
    for (var rIndex = 0; rIndex < resolved.length; rIndex += 1) {
      var card = resolved[rIndex].card;
      if (!card) continue;
      var passage = resolved[rIndex].range.getBoundingClientRect();
      entries.push({ card: card, top: passage.top - railRect.top });
    }
    entries.sort(function (a, b) { return a.top - b.top; });
    var minTop = 0;
    var composer = /** @type {HTMLElement | null} */ (rail.querySelector(".proposal-composer"));
    if (composer) {
      minTop = composer.offsetTop + composer.offsetHeight + 16;
    }
    for (var eIndex = 0; eIndex < entries.length; eIndex += 1) {
      var entry = entries[eIndex];
      entry.card.classList.add("is-anchored");
      var top = Math.max(entry.top, minTop);
      entry.card.style.top = top + "px";
      minTop = top + entry.card.offsetHeight + 14;
    }
    var maxBottom = 0;
    for (var mIndex = 0; mIndex < entries.length; mIndex += 1) {
      var bottom = parseFloat(entries[mIndex].card.style.top) +
        entries[mIndex].card.offsetHeight;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    if (maxBottom > 0) {
      rail.style.minHeight = maxBottom + "px";
    }
    // Anything still in the rail's flow (stacked cards, proposed follow-ups)
    // starts below the anchored cards instead of underneath them.
    if (cardsContainer && maxBottom > 0) {
      var hasFlowContent = rail.querySelector(".publication-proposals") !== null;
      for (var fIndex = 0; fIndex < cardsContainer.children.length; fIndex += 1) {
        if (!cardsContainer.children[fIndex].classList.contains("is-anchored")) {
          hasFlowContent = true;
        }
      }
      if (hasFlowContent) {
        var push = maxBottom + 20 - cardsContainer.offsetTop;
        if (push > 0) {
          cardsContainer.style.marginTop = push + "px";
        }
      }
    }
    drawConnectors();
  }

  if (resolved.length > 0) {
    positionCards();
    /** @type {number | null} */
  var positionCardsTimer = null;
    function schedulePositionCards() {
      if (positionCardsTimer !== null) window.clearTimeout(positionCardsTimer);
      positionCardsTimer = window.setTimeout(function () {
        positionCardsTimer = null;
        positionCards();
      }, 140);
    }
    window.addEventListener("resize", schedulePositionCards);
    if (typeof ResizeObserver !== "undefined") {
      var observedLayoutWidth = root.getBoundingClientRect().width;
      var layoutResizeObserver = new ResizeObserver(function (entries) {
        var nextWidth = entries[0] ? entries[0].contentRect.width : observedLayoutWidth;
        if (Math.abs(nextWidth - observedLayoutWidth) < 0.5) return;
        observedLayoutWidth = nextWidth;
        schedulePositionCards();
      });
      layoutResizeObserver.observe(root);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(positionCards);
    }
  }

  // ------------------------------------------------------------------
  // Anchored proposals: selecting answer text offers "Ask about this",
  // which quotes the passage into the rail's proposal composer.
  const proposalForm = /** @type {HTMLFormElement | null} */ (document.querySelector("form.proposal-composer"));
  const anchorInput = proposalForm
    ? /** @type {HTMLInputElement | null} */ (proposalForm.querySelector('input[name="anchor"]'))
    : null;
  const quoteRow = proposalForm
    ? /** @type {HTMLElement | null} */ (proposalForm.querySelector("[data-qmux-proposal-quote]"))
    : null;
  if (!proposalForm || !anchorInput || !quoteRow) return;
  var quoteText = quoteRow.querySelector(".research-followup-quote");
  var quoteDismiss = quoteRow.querySelector(".research-followup-quote-dismiss");

  var askButton = document.createElement("button");
  askButton.type = "button";
  askButton.className = "research-highlight-action";
  askButton.textContent = "Ask about this";
  askButton.hidden = true;
  document.body.appendChild(askButton);
  // Keep the selection alive through the click.
  askButton.addEventListener("mousedown", function (event) {
    event.preventDefault();
  });

  /** @type {SelectedPassage | null} */
  var pendingSelection = null;

  function selectionOffsets() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return null;
    }
    // A conversation anchor must stay inside one turn body. Labels exist only
    // in the published projection, and crossing a label/turn seam creates an
    // anchor the app cannot relocate against its label-free conversation view.
    /** @type {Element} */
    var contextRoot = root;
    if (root.querySelector(".research-conversation")) {
      var startElement = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      var endElement = range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
      var startTurn = startElement
        ? startElement.closest(".conversation-turn-body")
        : null;
      var endTurn = endElement
        ? endElement.closest(".conversation-turn-body")
        : null;
      if (!startTurn || startTurn !== endTurn || !root.contains(startTurn)) {
        return null;
      }
      contextRoot = startTurn;
    }
    var probe = document.createRange();
    probe.selectNodeContents(root);
    probe.setEnd(range.startContainer, range.startOffset);
    var start = (probe.cloneContents().textContent || "").length;
    probe.setEnd(range.endContainer, range.endOffset);
    var end = (probe.cloneContents().textContent || "").length;
    var contextStart = 0;
    var contextEnd = text.length;
    if (contextRoot !== root) {
      probe.setEnd(contextRoot, 0);
      contextStart = (probe.cloneContents().textContent || "").length;
      probe.setEnd(contextRoot, contextRoot.childNodes.length);
      contextEnd = (probe.cloneContents().textContent || "").length;
    }
    var slice = text.slice(start, end);
    var trimmedLeading = slice.length - slice.replace(/^\s+/, "").length;
    var trimmedTrailing = slice.length - slice.replace(/\s+$/, "").length;
    start += trimmedLeading;
    end -= trimmedTrailing;
    if (end <= start || end - start > 2000) return null;
    return {
      start: start,
      end: end,
      contextStart: contextStart,
      contextEnd: contextEnd,
      rect: range.getBoundingClientRect(),
    };
  }

  function updateAskAction() {
    pendingSelection = selectionOffsets();
    if (!pendingSelection) {
      askButton.hidden = true;
      return;
    }
    askButton.hidden = false;
    var left = Math.min(
      Math.max(8, pendingSelection.rect.left),
      window.innerWidth - askButton.offsetWidth - 8,
    );
    var top = Math.min(
      pendingSelection.rect.bottom + 8,
      window.innerHeight - askButton.offsetHeight - 8,
    );
    askButton.style.left = left + "px";
    askButton.style.top = top + "px";
  }

  document.addEventListener("mouseup", function () {
    setTimeout(updateAskAction, 0);
  });
  document.addEventListener("keyup", function () {
    setTimeout(updateAskAction, 0);
  });
  window.addEventListener("scroll", function () {
    askButton.hidden = true;
  }, { passive: true });

  askButton.addEventListener("click", function () {
    if (!pendingSelection) return;
    var start = pendingSelection.start;
    var end = pendingSelection.end;
    var exact = text.slice(start, end);
    if (!exact.trim()) return;
    anchorInput.value = JSON.stringify({
      start: start,
      end: end,
      exact: exact,
      prefix: text.slice(Math.max(pendingSelection.contextStart, start - 32), start),
      suffix: text.slice(end, Math.min(pendingSelection.contextEnd, end + 32)),
    });
    if (quoteText) {
      quoteText.textContent = exact.split(/\s+/).join(" ").trim();
    }
    quoteRow.hidden = false;
    proposalForm.classList.add("is-anchored");
    askButton.hidden = true;
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    var promptField = proposalForm.querySelector("textarea");
    if (promptField) {
      promptField.focus();
      promptField.scrollIntoView({ block: "nearest" });
    }
  });

  if (quoteDismiss) {
    quoteDismiss.addEventListener("click", function () {
      anchorInput.value = "";
      quoteRow.hidden = true;
      proposalForm.classList.remove("is-anchored");
    });
  }
})();
