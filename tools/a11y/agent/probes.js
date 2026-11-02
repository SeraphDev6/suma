/* eslint-disable */
/**
 * Measurement probes injected into every page (Playwright MCP --init-script, after axe-core).
 * The agent calls them through browser_evaluate, for example:
 *   () => window.__a11y.contrast("#submit")
 *   (element) => window.__a11y.targetSize(element)        // with element + ref from a snapshot
 *
 * Every probe returns plain JSON with the raw numbers and the WCAG threshold it compared
 * against, so a finding can quote the measurement instead of an impression.
 * None of the probes change layout. highlight() draws in a fixed, pointer-events:none overlay.
 */
(() => {
  if (window.__a11y) return;

  const $ = (t) => (typeof t === "string" ? document.querySelector(t) : t);
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  // Normalise any CSS colour (rgb, hsl, oklch, color(), named) to sRGB via a 1x1 canvas.
  let ctx;
  function rgba(css) {
    if (!css || css === "transparent") return [0, 0, 0, 0];
    ctx ||= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    // getImageData premultiplies poorly at low alpha; recover alpha from the string when we can.
    const m = String(css).match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : Number(v)));
      if (parts.length >= 3) return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    }
    return [r, g, b, a / 255];
  }
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  /** Composite background behind an element, walking ancestors. Reports when an image or gradient makes it indeterminate. */
  function backgroundOf(el) {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return { indeterminate: true, reason: `background-image on ${describe(n)}` };
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
      if (parseFloat(cs.opacity) < 1) return { indeterminate: true, reason: `opacity ${cs.opacity} on ${describe(n)}` };
    }
    let bg = [255, 255, 255, 1];
    for (const l of layers.reverse()) bg = over(l, bg);
    return { color: bg };
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...el.classList].slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    return s;
  }

  function accessibleNameGuess(el) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
    return el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || (el.labels && el.labels[0]?.textContent?.trim()) || el.textContent?.trim().slice(0, 80) || "";
  }

  /** Text contrast for an element (WCAG 1.4.3 and 1.4.6). */
  function contrast(target, opts = {}) {
    const el = $(target);
    if (!el) return { error: "element not found" };
    const cs = getComputedStyle(el);
    const fg = rgba(opts.color || cs.color);
    const bgInfo = opts.background ? { color: rgba(opts.background) } : backgroundOf(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const base = { element: describe(el), text: el.textContent.trim().slice(0, 80), fontSizePx: round(size, 1), fontWeight: weight, large };
    if (bgInfo.indeterminate) return { ...base, indeterminate: true, reason: bgInfo.reason + ". Check visually against the screenshot and say so." };
    const fgOnBg = over(fg, bgInfo.color);
    const r = ratio(fgOnBg, bgInfo.color);
    const aa = large ? 3 : 4.5;
    const aaa = large ? 4.5 : 7;
    return { ...base, foreground: hex(fgOnBg), background: hex(bgInfo.color), ratio: round(r), required: { "1.4.3": aa, "1.4.6": aaa }, passes: { "1.4.3": r >= aa, "1.4.6": r >= aaa } };
  }

  /**
   * Contrast of a non-text part (border, icon fill, focus ring) against the colours on each side
   * of it (WCAG 1.4.11). A border sits between the page (outside) and the control's own fill
   * (inside); both ratios are reported. verdict is "pass" when both sides reach 3:1, "fail" when
   * neither does, and "ambiguous" otherwise; do not report ambiguous results as failures.
   */
  function nonTextContrast(target, prop = "borderTopColor", against) {
    const el = $(target);
    if (!el) return { error: "element not found" };
    const c = rgba(getComputedStyle(el)[prop]);
    const outside = against ? { color: rgba(against) } : backgroundOf(el.parentElement || el);
    if (outside.indeterminate) return { element: describe(el), indeterminate: true, reason: outside.reason };
    const part = over(c, outside.color);
    const ownFill = rgba(getComputedStyle(el).backgroundColor);
    const inside = ownFill[3] > 0 ? over(ownFill, outside.color) : null;
    const rOut = ratio(part, outside.color);
    const rIn = inside ? ratio(part, inside) : null;
    const sides = [rOut, rIn].filter((x) => x !== null);
    const verdict = sides.every((x) => x >= 3) ? "pass" : sides.every((x) => x < 3) ? "fail" : "ambiguous";
    return { element: describe(el), property: prop, color: hex(part), outside: hex(outside.color), ratioOutside: round(rOut), inside: inside ? hex(inside) : null, ratioInside: rIn === null ? null : round(rIn), required: 3, verdict, passes: verdict === "pass", note: "A failing border only fails 1.4.11 if the border is what identifies the control or its state; check the fill and other cues first." };
  }

  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[tabindex]:not([tabindex="-1"])';

  /**
   * Target size (WCAG 2.5.8 and 2.5.5). Measures the real hit area by probing elementFromPoint,
   * so transparent pseudo-element hit areas count, and checks the 2.5.8 spacing exception.
   */
  function targetSize(target) {
    const el = $(target);
    if (!el) return { error: "element not found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x, y) => {
      const h = document.elementFromPoint(x, y);
      return !!h && (h === el || el.contains(h));
    };
    let left = 0, right = 0, up = 0, down = 0;
    const max = 60;
    while (left < max && hits(cx - left - 1, cy)) left++;
    while (right < max && hits(cx + right + 1, cy)) right++;
    while (up < max && hits(cx, cy - up - 1)) up++;
    while (down < max && hits(cx, cy + down + 1)) down++;
    const hitW = hits(cx, cy) ? left + right + 1 : 0;
    const hitH = hits(cx, cy) ? up + down + 1 : 0;
    const width = Math.max(round(r.width, 1), hitW);
    const height = Math.max(round(r.height, 1), hitH);

    // Spacing exception: a 24px circle centred on this target must not intersect another
    // target or that target's own 24px circle (centres closer than 24px, or circle hits rect).
    const others = [...document.querySelectorAll(INTERACTIVE)].filter((o) => o !== el && !el.contains(o) && !o.contains(el) && o.getClientRects().length);
    const conflicts = [];
    for (const o of others) {
      const or = o.getBoundingClientRect();
      const ox = or.left + or.width / 2, oy = or.top + or.height / 2;
      const centres = Math.hypot(ox - cx, oy - cy);
      const nx = Math.max(or.left, Math.min(cx, or.right)), ny = Math.max(or.top, Math.min(cy, or.bottom));
      const toRect = Math.hypot(nx - cx, ny - cy);
      const oSmall = or.width < 24 || or.height < 24;
      if (toRect < 12 || (oSmall && centres < 24)) conflicts.push({ element: describe(o), distancePx: round(Math.min(toRect, centres), 1) });
    }
    const meets24 = width >= 24 && height >= 24;
    return {
      element: describe(el),
      name: accessibleNameGuess(el),
      boxPx: { width: round(r.width, 1), height: round(r.height, 1) },
      hitAreaPx: { width: hitW, height: hitH },
      width, height,
      inlineInText: getComputedStyle(el).display === "inline" && !!el.closest("p,li,td,dd"),
      spacingExceptionChecked: true,
      spacingOk: conflicts.length === 0,
      conflicts: conflicts.slice(0, 5),
      passes: { "2.5.8": meets24 || conflicts.length === 0, "2.5.5": width >= 44 && height >= 44 },
      note: "2.5.8 also passes by the inline, equivalent, user-agent and essential exceptions; check those before failing.",
    };
  }

  /** What has focus right now, how it is indicated, and whether author content covers it (2.4.7, 2.4.11, 2.4.12, 2.4.13). */
  function focusInfo() {
    const el = document.activeElement;
    if (!el || el === document.body) return { focused: null, note: "Focus is on <body> (lost or not yet placed)." };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Sample a 5x5 grid inside the element; a point is covered when the top element there
    // is neither the focused element nor inside it nor one of its ancestors.
    let covered = 0, total = 0, coveredBy = new Set();
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const x = r.left + ((i + 0.5) * r.width) / 5, y = r.top + ((j + 0.5) * r.height) / 5;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { total++; covered++; coveredBy.add("(outside viewport)"); continue; }
      total++;
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) { covered++; coveredBy.add(describe(top.closest("header,nav,footer,[role=dialog],.sticky-top,.fixed-top,.fixed-bottom") || top)); }
    }
    const pseudo = getComputedStyle(el, "::after");
    return {
      focused: describe(el),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: accessibleNameGuess(el),
      rect: { x: round(r.x, 1), y: round(r.y, 1), width: round(r.width, 1), height: round(r.height, 1) },
      matchesFocusVisible: el.matches(":focus-visible"),
      indicator: { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset, boxShadow: cs.boxShadow, afterOutline: pseudo.outlineStyle !== "none" ? `${pseudo.outlineWidth} ${pseudo.outlineStyle} ${pseudo.outlineColor}` : null },
      coveredFraction: round(covered / total),
      coveredBy: [...coveredBy],
      passes: { "2.4.11": covered < total, "2.4.12": covered === 0 },
    };
  }

  /** Apply the WCAG 1.4.12 text spacing values and list elements whose text is now clipped or overlapping. */
  // Suma's Content Security Policy blocks <style> elements, so apply the spacing through a
  // constructed stylesheet (CSSOM, which CSP allows) and verify that it took effect.
  let spacingSheet;
  function textSpacing(on = true) {
    if (!on) {
      if (spacingSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== spacingSheet);
      return { removed: true };
    }
    const sample = [...document.querySelectorAll("main p, main li, main span, main a, p, li")].find((e) => e.textContent.trim());
    const before = sample && parseFloat(getComputedStyle(sample).letterSpacing);
    if (!spacingSheet) {
      spacingSheet = new CSSStyleSheet();
      spacingSheet.replaceSync("*:not(#__a11y_overlay){line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}");
    }
    if (!document.adoptedStyleSheets.includes(spacingSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, spacingSheet];
    let verified = false;
    if (sample) {
      const cs = getComputedStyle(sample);
      verified = Math.abs(parseFloat(cs.letterSpacing) - 0.12 * parseFloat(cs.fontSize)) < 0.5 && parseFloat(cs.letterSpacing) !== before;
    }
    if (!verified) return { applied: false, error: "The text spacing override did not take effect; do not record 1.4.12 from this call." };
    return { applied: true, verified: true, sample: describe(sample), clipped: clippedText() };
  }


  // Screen-reader-only text (Bootstrap .visually-hidden and similar) is clipped on purpose.
  const srOnly = (el, cs) => el.clientWidth <= 1 || el.clientHeight <= 1 || (cs.clip && cs.clip !== "auto") || /inset\(50%\)/.test(cs.clipPath) || el.closest(".visually-hidden,.visually-hidden-focusable,.sr-only,#__a11y_overlay");

  function clippedText() {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || srOnly(el, cs)) continue;
      const hidesX = /hidden|clip/.test(cs.overflowX) || cs.textOverflow === "ellipsis";
      const hidesY = /hidden|clip/.test(cs.overflowY);
      if ((hidesX && el.scrollWidth > el.clientWidth + 1) || (hidesY && el.scrollHeight > el.clientHeight + 1)) {
        out.push({ element: describe(el), text: el.textContent.trim().slice(0, 60), scroll: [el.scrollWidth, el.scrollHeight], client: [el.clientWidth, el.clientHeight] });
      }
    }
    return out.slice(0, 25);
  }

  /**
   * Horizontal overflow at the current viewport (use with browser_resize to 320 wide for 1.4.10).
   * offenders make the page scroll sideways (a failure unless the content is a table, map or
   * similar two-dimensional content). clipped elements are cut off by an overflow:hidden ancestor;
   * that only matters if meaningful content is lost, so check them in the screenshot.
   */
  function reflow() {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    const clipped = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      const cs = getComputedStyle(el);
      if (srOnly(el, cs) || cs.position === "fixed" && el.closest("#__a11y_overlay")) continue;
      let container = null;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (/auto|scroll|hidden|clip/.test(ox) && p.getBoundingClientRect().right <= vw + 1) { container = { el: p, ox }; break; }
      }
      const item = { element: describe(el), right: round(r.right, 1), width: round(r.width, 1) };
      if (!container) offenders.push(item);
      else if (/hidden|clip/.test(container.ox)) clipped.push({ ...item, clippedBy: describe(container.el) });
    }
    const dedupe = (list) => list.filter((o, i) => !list.slice(0, i).some((p) => p.element === o.element)).slice(0, 15);
    return { viewportWidth: vw, documentScrollWidth: document.documentElement.scrollWidth, pageScrollsHorizontally: document.documentElement.scrollWidth > vw + 1, offenders: dedupe(offenders), clipped: dedupe(clipped) };
  }

  /** Headings and landmarks, for 1.3.1, 1.3.6, 2.4.1, 2.4.6 and 2.4.10. */
  function structure() {
    const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].filter(visible).map((h) => ({ level: +(h.getAttribute("aria-level") || h.tagName[1]), text: h.textContent.trim().slice(0, 80) }));
    const landmarks = [...document.querySelectorAll("main,[role=main],nav,[role=navigation],header,[role=banner],footer,[role=contentinfo],aside,[role=complementary],form[aria-label],form[aria-labelledby],[role=search],search,section[aria-label],section[aria-labelledby],[role=region]")].map((l) => ({ element: describe(l), role: l.getAttribute("role") || l.tagName.toLowerCase(), label: l.getAttribute("aria-label") || (l.getAttribute("aria-labelledby") && document.getElementById(l.getAttribute("aria-labelledby"))?.textContent?.trim()) || null }));
    const skip = [...document.querySelectorAll("a[href^='#']")].slice(0, 3).map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href"), targetExists: !!document.getElementById(a.getAttribute("href").slice(1)) }));
    return { title: document.title, lang: document.documentElement.lang, headings, landmarks, skipLinks: skip, tabbableCount: tabbables().count };
  }

  /**
   * Elements reachable with Tab, in DOM order: visible, enabled, tabindex >= 0, not inert or
   * aria-hidden. A full keyboard pass needs at least this many Tab presses.
   */
  function tabbables() {
    const sel = "a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,summary,audio[controls],video[controls],[contenteditable=''],[contenteditable=true],[tabindex]";
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.tabIndex < 0 || el.disabled || el.closest("[inert],[aria-hidden=true]")) return false;
      if (!el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    });
    return { count: els.length, elements: els.slice(0, 60).map(describe) };
  }

  /** A selector that matches exactly this element (ids where unique, otherwise nth-of-type steps). */
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(e.id)}`);
        break;
      }
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(" > ");
  }

  // Never click controls whose name suggests a lasting change.
  const RISKY = /remove|delete|sign ?out|log ?out|cerrar sesi|pay|pagar|submit|enviar|buy|comprar|order|pedido|checkout|confirm|add|agregar|añadir|save|guardar|send|claim|reclamar|cancel|unlink|link|verify|continue|continuar|next|siguiente|back|atrás|volver/i;

  /**
   * Buttons that may show or hide content (menus, accordions, "more" toggles): visible, enabled,
   * not submit buttons, not links, and not named like an action with lasting effects.
   */
  function disclosureCandidates(max = 8) {
    const els = [...document.querySelectorAll("button, [role=button]:not(a)")].filter((el) => {
      if (el.disabled || el.closest("[inert],[aria-hidden=true]") || !el.getClientRects().length) return false;
      if (el.tagName === "BUTTON" && el.type === "submit" && el.form) return false;
      const name = accessibleNameGuess(el) || el.textContent || "";
      if (RISKY.test(name)) return false;
      const hint = `${el.className} ${el.getAttribute("aria-controls") || ""} ${el.getAttribute("data-bs-toggle") || ""} ${name}`;
      return el.hasAttribute("aria-controls") || el.hasAttribute("aria-expanded") || /toggle|toggler|collapse|accordion|expand|disclos|menu|more|show|details|options|filter|men[uú]|más|mostrar|detalles/i.test(hint);
    });
    return els.slice(0, max).map((el) => ({ selector: cssPath(el), element: describe(el), name: accessibleNameGuess(el), expanded: el.getAttribute("aria-expanded"), haspopup: el.getAttribute("aria-haspopup") }));
  }

  /** Visible elements on the page (for detecting content a click showed or hid). */
  function visibleCount() {
    let n = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest("#__a11y_overlay")) continue;
      if (el.getClientRects().length && getComputedStyle(el).visibility !== "hidden") n++;
    }
    return { count: n, dialogs: document.querySelectorAll("[role=dialog]:not([hidden]), dialog[open], .modal.show").length };
  }

  /** Switch Suma's language the way the language picker does (stored choice, then reload). */
  function setLanguage(lang) {
    localStorage.setItem("language", JSON.stringify(lang));
    location.reload();
    return { language: lang, reloading: true };
  }

  /** Live regions currently in the DOM and their text (4.1.3). */
  function liveRegions() {
    return [...document.querySelectorAll("[aria-live],[role=status],[role=alert],[role=log],output")].map((n) => ({ element: describe(n), role: n.getAttribute("role"), live: n.getAttribute("aria-live"), atomic: n.getAttribute("aria-atomic"), text: n.textContent.trim().slice(0, 120) }));
  }

  /** Run axe-core (injected before this file) on the page or a subtree. Returns a compact result. */
  async function axe(context, tags) {
    if (!window.axe) return { error: "axe-core not loaded" };
    const res = await window.axe.run(context || document, { runOnly: { type: "tag", values: tags || ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations", "incomplete"] });
    const slim = (list) => list.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags.filter((t) => /^wcag\d{3,}$/.test(t)), help: v.help, nodes: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 200), summary: (n.failureSummary || "").slice(0, 300) })) }));
    return { violations: slim(res.violations), incomplete: slim(res.incomplete), passes: res.passes?.length };
  }

  /** Outline an element for a screenshot without touching its layout. */
  function highlight(target, label) {
    const el = $(target);
    if (!el) return { error: "element not found" };
    el.scrollIntoView({ block: "center", inline: "nearest" });
    let host = document.getElementById("__a11y_overlay");
    if (!host) {
      host = document.createElement("div");
      host.id = "__a11y_overlay";
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      document.documentElement.appendChild(host);
    }
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;outline:3px solid #d6008f;outline-offset:0;box-shadow:0 0 0 5px rgba(255,255,255,.85)`;
    host.appendChild(box);
    if (label) {
      const tag = document.createElement("div");
      tag.textContent = label;
      // A short tag at the box's top-right corner, outside the box, so it does not cover the
      // element or (usually) its visible label on the left.
      const below = r.top < 26;
      tag.style.cssText = `position:fixed;left:${Math.min(innerWidth - 8, r.right + 4)}px;top:${below ? r.bottom + 6 : r.top - 4}px;transform:translate(-100%,${below ? "0" : "-100%"});background:#d6008f;color:#fff;font:600 12px/1.5 system-ui,sans-serif;padding:0 5px;border-radius:3px;white-space:nowrap`;
      host.appendChild(tag);
    }
    return { highlighted: describe(el) };
  }

  function clearHighlight() {
    document.getElementById("__a11y_overlay")?.remove();
    return { cleared: true };
  }

  Object.defineProperty(window, "__a11y", {
    value: Object.freeze({ contrast, nonTextContrast, targetSize, focusInfo, textSpacing, clippedText, reflow, structure, liveRegions, tabbables, setLanguage, cssPath, disclosureCandidates, visibleCount, axe, highlight, clearHighlight, describe }),
    enumerable: false,
  });
})();
