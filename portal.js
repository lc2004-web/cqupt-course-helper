'use strict';

(() => {
  if (window.top !== window || globalThis.__CQUPT_PORTAL_LOGIN_HELPER__) return;
  globalThis.__CQUPT_PORTAL_LOGIN_HELPER__ = true;

  const normalize = (value) => String(value || '').replace(/[\s\u3000]+/g, '');
  const targetText = /^(?:研究生在线|研究生管理系统)$/;
  const interactiveSelector = 'a, button, [role="button"], [role="link"], [onclick], [data-url], [data-href], [tabindex]';

  const visible = (element) => {
    if (!element || element.nodeType !== 1 || element.getClientRects().length === 0) return false;
    const currentWindow = element.ownerDocument?.defaultView;
    const style = currentWindow?.getComputedStyle?.(element);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse');
  };

  const sendStatus = (code) => chrome.runtime.sendMessage({ type: 'CQUPT_LOGIN_STATUS', code }).catch(() => {});

  const getAccessibleRoots = () => {
    const roots = [];
    const seenDocuments = new Set();
    const visitWindow = (currentWindow) => {
      try {
        const currentDocument = currentWindow.document;
        if (!currentDocument || seenDocuments.has(currentDocument)) return;
        seenDocuments.add(currentDocument);
        roots.push(currentDocument);
        for (const frame of Array.from(currentWindow.frames || [])) visitWindow(frame);
      } catch {
        // Ignore cross-origin frames.
      }
    };
    visitWindow(window);
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of Array.from(roots[index].querySelectorAll?.('*') || [])) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots;
  };

  const findClickableAncestor = (element) => {
    const semantic = element.closest?.(interactiveSelector);
    if (semantic && visible(semantic)) return semantic;
    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (!visible(current)) continue;
      const className = String(current.className || '');
      const style = current.ownerDocument?.defaultView?.getComputedStyle?.(current);
      if (/service|application|\bapp\b|item|card|entry|menu/i.test(className) || style?.cursor === 'pointer') return current;
    }
    return element;
  };

  const findGraduateEntry = () => {
    const exactMatches = [];
    const semanticMatches = [];
    for (const root of getAccessibleRoots()) {
      for (const element of Array.from(root.querySelectorAll?.('*') || [])) {
        if (!visible(element)) continue;
        const label = normalize(element.innerText || element.textContent || element.title || element.getAttribute?.('aria-label'));
        if (targetText.test(label)) exactMatches.push(element);
      }
      for (const control of Array.from(root.querySelectorAll?.(interactiveSelector) || [])) {
        if (!visible(control)) continue;
        const label = normalize(control.innerText || control.textContent || control.title || control.getAttribute?.('aria-label'));
        if (/研究生在线|研究生管理系统/.test(label)) semanticMatches.push(control);
      }
    }
    const exact = exactMatches.sort((a, b) => a.childElementCount - b.childElementCount)[0];
    if (exact) return { leaf: exact, control: findClickableAncestor(exact) };
    const semantic = semanticMatches.sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length)[0];
    return semantic ? { leaf: semantic, control: semantic } : null;
  };

  const openGraduateEntry = async ({ leaf, control }) => {
    await sendStatus('portal_opening');
    const anchor = control.closest?.('a[href]') || leaf.closest?.('a[href]') || (control.matches?.('a[href]') ? control : null);
    const rawUrl = anchor?.href || control.getAttribute?.('data-url') || control.getAttribute?.('data-href') || '';
    if (rawUrl && !/^javascript:/i.test(rawUrl)) {
      const targetUrl = new URL(rawUrl, control.ownerDocument?.location?.href || location.href).href;
      window.location.assign(targetUrl);
      return;
    }
    leaf.scrollIntoView?.({ block: 'center', inline: 'center' });
    control.click?.();
  };

  (async () => {
    const state = await chrome.runtime.sendMessage({ type: 'CQUPT_GET_LOGIN_STATE' });
    if (!state?.ok) return;
    await sendStatus('portal_locating');

    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      const entry = findGraduateEntry();
      if (entry) {
        window.clearInterval(timer);
        await openGraduateEntry(entry);
        return;
      }
      if (attempts >= 120) {
        window.clearInterval(timer);
        await sendStatus('portal_not_found');
      }
    }, 500);
  })().catch(() => {});
})();
