'use strict';

(() => {
  const HELPER_VERSION = '2.5.0';
  if (globalThis.__CQUPT_COURSE_HELPER_VERSION__ === HELPER_VERSION) return;
  globalThis.__CQUPT_COURSE_HELPER_VERSION__ = HELPER_VERSION;

  const MIN_REFRESH_SECONDS = 10;
  const MAX_REFRESH_SECONDS = 600;
  const MAX_RELOADS = 120;
  const SCAN_INTERVAL_MS = 800;
  const COURSE_PAGE_RE = /\/Course\/PlanCourseOnlineSel\.aspx/i;
  const CLASS_PICKER_TEXT = /(?:选择上课班级|选择班级|选班|查看班级)/;
  const DANGER_TEXT = /(?:提交|确认|保存|选课成功|立即选课|退选|删除|清空|撤销)/;
  const CLOSED_TEXT = /(?:未开放|未开始|不可选|已结束|已满|无余量|停开|冲突|禁止)/;
  const PLAN_MENU_TEXT = /(?:培养方案选择|培养计划制定|培养计划|培养方案)/;
  const COURSE_MENU_TEXT = /(?:课程网上选课管理|网上选课管理|课程网上选课|选课管理)/;
  const SERVICE_GATEWAY_TEXT = /^(?:服务|服务大厅|全部服务|办事服务|业务服务)$/;
  const CULTIVATION_GATEWAY_TEXT = /^(?:培养|培养管理|培养服务|培养工作)$/;
  const WIZARD_PANEL_ID = 'cqupt-course-plan-wizard';
  const DEFAULT_CONFIG = {
    targetsText: '',
    autoRefresh: true,
    refreshSeconds: 15,
  };

  let config = { ...DEFAULT_CONFIG };
  let running = false;
  let refreshTimer = null;
  let scanTimer = null;
  let mutationObserver = null;
  let mutationScanTimer = null;
  let lastReadySignature = '';
  let openedCourseKey = '';
  let previousTitle = document.title;
  let titleTimer = null;
  let wizardActive = false;
  let wizardTimer = null;
  let currentTabId = null;
  let monitorTabId = null;
  let scanInProgress = false;
  let navigationTimer = null;
  let navigationAttempts = 0;
  let serviceGatewayOpened = false;
  let cultivationGatewayOpened = false;
  let pendingClassSelection = null;
  let consecutiveScanFailures = 0;
  let healthTimer = null;
  let missingCourseFrameChecks = 0;
  let lastHealthWriteAt = 0;

  function normalize(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[()（）【】\[\]《》<>]/g, '');
  }

  function textOf(element) {
    return String(element?.innerText || element?.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function clampRefreshSeconds(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.refreshSeconds;
    return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, parsed));
  }

  function normalizeCourseCode(value) {
    return String(value ?? '').trim().replace(/[\s\u3000]+/g, '').toUpperCase();
  }

  function parseTargets(text) {
    const codes = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(normalizeCourseCode)
      .filter((code) => /^[A-Z][A-Z0-9_-]{2,30}$/.test(code));
    return [...new Set(codes)].map((code) => ({ id: code, code }));
  }

  function mapHeaders(table) {
    const rows = Array.from(table.rows || []);
    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 5); rowIndex += 1) {
      const cells = Array.from(rows[rowIndex].cells || []);
      const labels = cells.map((cell) => normalize(textOf(cell)));
      const code = labels.findIndex((label) => /课程编号|课程代码|课程序号/.test(label));
      const name = labels.findIndex((label) => /课程名称|课程名/.test(label));
      if (code < 0 || name < 0) continue;
      return {
        headerRowIndex: rowIndex,
        code,
        name,
        category: labels.findIndex((label) => /课程类别|课程类型/.test(label)),
        credits: labels.findIndex((label) => /^学分$|课程学分/.test(label)),
        className: labels.findIndex((label) => /班级名称|教学班|上课班级/.test(label)),
        status: labels.findIndex((label) => /选课状态|状态|余量|容量/.test(label)),
      };
    }
    return null;
  }

  function getCourseTables() {
    return Array.from(document.querySelectorAll('table'))
      .map((table) => ({ table, headers: mapHeaders(table) }))
      .filter((entry) => entry.headers);
  }

  function getAccessibleDocuments() {
    const documents = [];
    const seen = new Set();
    function visit(currentWindow) {
      try {
        const currentDocument = currentWindow.document;
        if (!currentDocument || seen.has(currentDocument)) return;
        seen.add(currentDocument);
        documents.push(currentDocument);
        for (const frame of Array.from(currentWindow.frames || [])) visit(frame);
      } catch {
        // Ignore cross-origin frames; the CQUPT navigation frame remains same-origin.
      }
    }
    try {
      visit(window.top);
    } catch {
      visit(window);
    }
    return documents;
  }

  function getCourseTablesAcrossFrames() {
    return getAccessibleDocuments().flatMap((currentDocument) =>
      Array.from(currentDocument.querySelectorAll('table'))
        .map((table) => ({ table, headers: mapHeaders(table) }))
        .filter((entry) => entry.headers),
    );
  }

  function readRow(row, headers) {
    const cells = Array.from(row.cells || []);
    const courseCodePattern = /^[A-Z][A-Z0-9_-]{2,30}$/;
    let actualCodeIndex = headers.code;
    if (!courseCodePattern.test(normalizeCourseCode(textOf(cells[actualCodeIndex])))) {
      actualCodeIndex = cells.findIndex((cell) => courseCodePattern.test(normalizeCourseCode(textOf(cell))));
    }
    const columnOffset = actualCodeIndex >= 0 ? actualCodeIndex - headers.code : 0;
    const adjustedCell = (headerIndex) => headerIndex >= 0 ? cells[headerIndex + columnOffset] : null;
    return {
      row,
      code: textOf(adjustedCell(headers.code)),
      name: textOf(adjustedCell(headers.name)),
      category: textOf(adjustedCell(headers.category)),
      credits: textOf(adjustedCell(headers.credits)),
      className: textOf(adjustedCell(headers.className)),
      status: textOf(adjustedCell(headers.status)),
      text: textOf(row),
    };
  }

  function rowLooksSelected(record) {
    if (record.row.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) return true;
    if (record.row.getAttribute('aria-selected') === 'true') return true;
    if (record.row.querySelector('[aria-selected="true"], [aria-checked="true"], [aria-pressed="true"]')) return true;
    const stateText = `${record.status} ${record.text}`;
    if (/(?:未选中|未选择)/.test(stateText)) return false;
    return /(?:已选|已选择|选中|退选)/.test(stateText);
  }

  function extractSelectedCourseData() {
    const courses = new Map();
    const seenRows = new Set();
    for (const { table, headers } of getCourseTablesAcrossFrames()) {
      const rows = Array.from(table.rows || []).slice(headers.headerRowIndex + 1);
      for (const row of rows) {
        if (seenRows.has(row)) continue;
        seenRows.add(row);
        const record = readRow(row, headers);
        const code = normalizeCourseCode(record.code);
        if (/^[A-Z][A-Z0-9_-]{2,30}$/.test(code) && rowLooksSelected(record)) {
          const previous = courses.get(code);
          const creditMatch = String(record.credits || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
          const credits = creditMatch ? Number.parseFloat(creditMatch[0]) : null;
          const categories = ['公共必修', '公共基础', '专业基础', '专业课', '自选课', '其他培养环节'];
          const category = categories.find((name) => String(record.category || '').includes(name)) || '';
          courses.set(code, {
            code,
            category: category || previous?.category || '',
            credits: Number.isFinite(credits) ? credits : (previous?.credits ?? null),
          });
        }
      }
    }
    return { codes: [...courses.keys()], courses: [...courses.values()] };
  }

  function buildCreditSummaryFromPage(courses) {
    const knownCategories = ['公共必修', '公共基础', '专业基础', '专业课', '自选课', '其他培养环节'];
    const requirementCandidates = [];
    for (const currentDocument of getAccessibleDocuments()) {
      const pageText = textOf(currentDocument.body).slice(0, 6000);
      const tail = pageText.split(/最低学分要求\s*[：:]?/).slice(1).join('最低学分要求').slice(0, 500);
      const requirements = {};
      if (tail) {
        for (const category of knownCategories) {
          const match = tail.match(new RegExp(`${category}\\s*[：:]\\s*(\\d+(?:\\.\\d+)?)`));
          if (match) requirements[category] = Number.parseFloat(match[1]);
        }
      }
      if (Object.keys(requirements).length) requirementCandidates.push(requirements);
    }
    const requirements = requirementCandidates
      .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] || {};
    const categories = Object.keys(requirements);
    if (!categories.length) return { available: false, items: [], allMet: false, unknownCourseCodes: [] };
    const totals = Object.fromEntries(categories.map((category) => [category, 0]));
    const unknownCourseCodes = [];
    for (const course of courses) {
      if (!knownCategories.includes(course.category) || !Number.isFinite(course.credits)) {
        unknownCourseCodes.push(course.code);
      } else if (categories.includes(course.category)) {
        totals[course.category] += course.credits;
      }
    }
    const items = categories.map((category) => {
      const selected = Number(totals[category].toFixed(2));
      const required = requirements[category];
      const missing = Number(Math.max(0, required - selected).toFixed(2));
      return { category, selected, required, missing, met: missing === 0 };
    });
    return {
      available: true,
      items,
      allMet: items.every((item) => item.met) && unknownCourseCodes.length === 0,
      unknownCourseCodes,
    };
  }

  function controlLabel(control) {
    return textOf(control) || String(control.value || control.title || control.getAttribute('aria-label') || '').trim();
  }

  function controlIsVisible(control) {
    if (!control || control.nodeType !== 1 || control.getClientRects().length === 0) return false;
    const currentWindow = control.ownerDocument?.defaultView;
    const style = currentWindow?.getComputedStyle?.(control);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse');
  }

  function findNavigationControl(kind) {
    const pattern = kind === 'plan' ? PLAN_MENU_TEXT : COURSE_MENU_TEXT;
    const exclusions = kind === 'plan' ? /(?:选课管理|课程网上选课)/ : /(?:培养方案|培养计划)/;
    const candidates = getAccessibleDocuments().flatMap((currentDocument) =>
      Array.from(currentDocument.querySelectorAll('a, button, [role="menuitem"], [onclick]')),
    );
    return candidates
      .map((control) => ({ control, label: controlLabel(control) }))
      .filter(({ control, label }) =>
        label && pattern.test(label) && !exclusions.test(label) && !DANGER_TEXT.test(label)
          && controlIsVisible(control) && !control.disabled && control.getAttribute('aria-disabled') !== 'true',
      )
      .sort((a, b) => a.label.length - b.label.length)[0]?.control || null;
  }

  function findGatewayControl(labelPattern) {
    const semanticSelector = 'a, button, [role="button"], [role="tab"], [role="menuitem"], [onclick], [data-url], [data-href], [lay-href]';
    const candidates = [];
    for (const currentDocument of getAccessibleDocuments()) {
      for (const control of Array.from(currentDocument.querySelectorAll(semanticSelector))) {
        const label = normalize(textOf(control));
        if (labelPattern.test(label) && controlIsVisible(control)
          && !control.disabled && control.getAttribute('aria-disabled') !== 'true') {
          candidates.push({ control, semantic: true });
        }
      }
      for (const leaf of Array.from(currentDocument.querySelectorAll('span, div, li'))) {
        const label = normalize(textOf(leaf));
        if (!labelPattern.test(label) || !controlIsVisible(leaf)) continue;
        const clickable = leaf.closest(semanticSelector) || leaf;
        if (controlIsVisible(clickable) && !clickable.disabled && clickable.getAttribute('aria-disabled') !== 'true') {
          candidates.push({ control: clickable, semantic: clickable !== leaf });
        }
      }
    }
    return candidates
      .sort((a, b) => Number(b.semantic) - Number(a.semantic))[0]?.control || null;
  }

  function planPageIsVisible() {
    return getCourseTablesAcrossFrames().some(({ table }) => {
      const currentDocument = table.ownerDocument;
      const headingText = Array.from(currentDocument.querySelectorAll('h1, h2, h3, legend, .title, .panel-title'))
        .slice(0, 12)
        .map(textOf)
        .join(' ');
      let pathname = '';
      try {
        pathname = currentDocument.defaultView?.location?.pathname || '';
      } catch {
        pathname = '';
      }
      const explicitlyPlan = PLAN_MENU_TEXT.test(`${currentDocument.title || ''} ${headingText} ${pathname}`);
      const hasSelectionControl = Boolean(table.querySelector('input[type="checkbox"], input[type="radio"]'));
      return explicitlyPlan || (hasSelectionControl && !COURSE_PAGE_RE.test(pathname));
    });
  }

  function removeWizardPanel() {
    try {
      window.top.document.getElementById(WIZARD_PANEL_ID)?.remove();
    } catch {
      document.getElementById(WIZARD_PANEL_ID)?.remove();
    }
  }

  function setWizardMessage(text, tone = 'normal') {
    let panel;
    try {
      panel = window.top.document.getElementById(WIZARD_PANEL_ID);
    } catch {
      panel = document.getElementById(WIZARD_PANEL_ID);
    }
    if (!panel) return;
    const message = panel.querySelector('[data-cqupt-wizard-message]');
    if (message) {
      message.textContent = text;
      message.style.color = tone === 'warn' ? '#9a3412' : '#334155';
    }
  }

  function ensureWizardPanel() {
    if (window.top !== window) return;
    const rootDocument = document;
    if (rootDocument.getElementById(WIZARD_PANEL_ID) || !rootDocument.body) return;
    const panel = rootDocument.createElement('aside');
    panel.id = WIZARD_PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'top:18px', 'right:18px', 'z-index:2147483647', 'width:330px', 'padding:15px',
      'background:#ffffff', 'color:#172033', 'border:2px solid #0891b2', 'border-radius:12px',
      'box-shadow:0 12px 36px rgba(15,23,42,.28)', 'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif',
    ].join(';');

    const title = rootDocument.createElement('strong');
    title.textContent = '选课辅助器 · 培养方案导入';
    title.style.cssText = 'display:block;margin-bottom:6px;color:#0e7490;font-size:15px';
    const message = rootDocument.createElement('div');
    message.dataset.cquptWizardMessage = 'true';
    message.textContent = '正在打开培养方案，请稍候…';
    message.style.cssText = 'margin-bottom:11px;color:#334155';
    const finish = rootDocument.createElement('button');
    finish.type = 'button';
    finish.textContent = '导入已选课程';
    finish.style.cssText = 'width:100%;padding:9px;border:0;border-radius:8px;color:#fff;background:#0891b2;font-weight:700;cursor:pointer';
    const cancel = rootDocument.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消导入';
    cancel.style.cssText = 'width:100%;margin-top:7px;padding:7px;border:1px solid #cbd5e1;border-radius:8px;color:#475569;background:#fff;cursor:pointer';

    finish.addEventListener('click', importPlanSelection);
    cancel.addEventListener('click', async () => {
      wizardActive = false;
      await chrome.storage.local.set({ wizardActive: false });
      removeWizardPanel();
      sendStatus('培养方案导入已取消。');
    });
    panel.append(title, message, finish, cancel);
    rootDocument.body.appendChild(panel);
  }

  function showPlanImportSuccess(codes, creditSummary) {
    const rootDocument = document;
    if (!rootDocument.body) return;
    rootDocument.getElementById(WIZARD_PANEL_ID)?.remove();
    const panel = rootDocument.createElement('aside');
    panel.id = WIZARD_PANEL_ID;
    panel.dataset.cquptImportSuccess = 'true';
    panel.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'background:rgba(15,23,42,.58)', 'font:16px/1.5 system-ui,"Microsoft YaHei",sans-serif',
      'pointer-events:none', 'opacity:0',
    ].join(';');
    const card = rootDocument.createElement('section');
    card.style.cssText = [
      'width:min(560px,calc(100vw - 48px))', 'padding:30px 32px', 'text-align:center', 'background:#f0fdf4',
      'color:#14532d', 'border:4px solid #22c55e', 'border-radius:20px',
      'box-shadow:0 24px 70px rgba(0,0,0,.38)',
    ].join(';');
    const check = rootDocument.createElement('div');
    check.textContent = '✓';
    check.style.cssText = 'width:74px;height:74px;margin:0 auto 12px;border-radius:50%;color:#fff;background:#16a34a;font:700 52px/74px system-ui';
    const title = rootDocument.createElement('strong');
    title.textContent = '导入成功';
    title.style.cssText = 'display:block;margin-bottom:8px;color:#166534;font-size:28px';
    const message = rootDocument.createElement('div');
    message.textContent = `已导入 ${codes.length} 门课程。`;
    message.style.cssText = 'margin-bottom:14px;color:#166534;font-size:17px';
    const codeList = rootDocument.createElement('div');
    codeList.textContent = codes.join('、');
    codeList.style.cssText = 'max-height:110px;overflow:hidden;padding:11px;color:#14532d;background:#dcfce7;border-radius:9px;font:15px/1.6 ui-monospace,Consolas,monospace';
    const creditBox = rootDocument.createElement('div');
    creditBox.style.cssText = 'margin-top:14px;padding:13px;text-align:left;color:#334155;background:#fff;border:1px solid #bbf7d0;border-radius:10px;font-size:14px';
    if (creditSummary?.available && Array.isArray(creditSummary.items) && creditSummary.items.length) {
      const format = (value) => Number.isInteger(value) ? String(value) : Number(value).toFixed(1).replace(/\.0$/, '');
      const heading = rootDocument.createElement('strong');
      heading.textContent = creditSummary.allMet ? '✓ 已满足最低学分要求' : '⚠ 尚未满足最低学分要求';
      heading.style.cssText = `display:block;margin-bottom:7px;color:${creditSummary.allMet ? '#166534' : '#b91c1c'};font-size:16px`;
      creditBox.appendChild(heading);
      for (const item of creditSummary.items) {
        const line = rootDocument.createElement('div');
        line.textContent = item.met
          ? `${item.category}：${format(item.selected)} / ${format(item.required)} 学分 ✓`
          : `${item.category}：${format(item.selected)} / ${format(item.required)} 学分，还差 ${format(item.missing)}`;
        line.style.cssText = `padding:3px 0;color:${item.met ? '#166534' : '#dc2626'};font-weight:${item.met ? '500' : '700'}`;
        creditBox.appendChild(line);
      }
      if (creditSummary.unknownCourseCodes?.length) {
        const warning = rootDocument.createElement('div');
        warning.textContent = `${creditSummary.unknownCourseCodes.length} 门课程未识别学分或类型，未计入合计。`;
        warning.style.cssText = 'margin-top:6px;color:#9a3412;font-size:12px';
        creditBox.appendChild(warning);
      }
    } else {
      creditBox.textContent = '未能读取页面左上角的最低学分要求，请人工核对。';
      creditBox.style.color = '#9a3412';
    }
    const countdown = rootDocument.createElement('div');
    countdown.textContent = '提示将在 4 秒后自动关闭';
    countdown.style.cssText = 'margin-top:13px;color:#4b7b5a;font-size:13px';
    card.append(check, title, message, codeList, creditBox, countdown);
    panel.appendChild(card);
    rootDocument.body.appendChild(panel);
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: 'forwards', easing: 'ease-out' });
    window.setTimeout(() => {
      if (!panel.isConnected) return;
      const animation = panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, fill: 'forwards', easing: 'ease-in' });
      animation.finished.then(() => panel.remove()).catch(() => panel.remove());
    }, 4000);
  }

  async function importPlanSelection() {
    const selection = extractSelectedCourseData();
    const codes = selection.codes;
    if (!codes.length) {
      setWizardMessage('尚未识别到已勾选课程。请先在培养方案表格中勾选课程，再点击本按钮。', 'warn');
      sendStatus('培养方案中尚未识别到已勾选课程。', 'warn');
      return;
    }

    const creditSummary = buildCreditSummaryFromPage(selection.courses);
    const stored = await chrome.storage.local.get('config');
    const nextConfig = { ...DEFAULT_CONFIG, ...(stored.config || {}), targetsText: codes.join('\n') };
    wizardActive = false;
    running = false;
    await chrome.storage.local.set({
      config: nextConfig,
      creditSummary,
      wizardActive: false,
      running: false,
      reloadCount: 0,
      latestStatus: {
        tone: 'ready',
        text: `已导入 ${codes.length} 门课程。`,
        updatedAt: Date.now(),
      },
    });
    showPlanImportSuccess(codes, creditSummary);
  }

  async function startPlanGuide() {
    if (window.top !== window) return;
    wizardActive = true;
    running = false;
    cancelRefresh();
    await chrome.storage.local.set({ wizardActive: true, running: false, reloadCount: 0 });
    removeWizardPanel();
    ensureWizardPanel();
    const planNavigation = findNavigationControl('plan');
    if (planNavigation) {
      planNavigation.click();
      setWizardMessage('正在进入培养方案；打开后请勾选课程，再点击下方按钮。');
    } else if (planPageIsVisible()) {
      setWizardMessage('请在培养方案中勾选要抢的课程，完成后点击下方按钮。');
    } else {
      setWizardMessage('未自动找到培养方案菜单，请手动进入“培养方案/培养计划”，本向导会继续保留。', 'warn');
    }
  }

  async function processPendingNavigation() {
    if (window.top !== window) return;
    const local = await chrome.storage.local.get(['pendingNavigationKind', 'pendingNavigationTabId']);
    const kind = local.pendingNavigationKind;
    if (!kind) return;
    if (currentTabId === null) {
      try {
        const context = await chrome.runtime.sendMessage({ type: 'CQUPT_GET_TAB_CONTEXT' });
        currentTabId = context?.tabId ?? null;
      } catch {
        currentTabId = null;
      }
    }
    if (local.pendingNavigationTabId !== currentTabId) return;

    const control = findNavigationControl(kind);
    if (control) {
      if (navigationTimer) window.clearTimeout(navigationTimer);
      navigationTimer = null;
      navigationAttempts = 0;
      serviceGatewayOpened = false;
      cultivationGatewayOpened = false;
      await chrome.storage.local.set({ pendingNavigationKind: null, pendingNavigationTabId: null });
      control.click();
      sendStatus(kind === 'plan' ? '已打开培养方案。' : '已打开课程网上选课管理。');
      return;
    }

    if (!cultivationGatewayOpened) {
      const cultivationControl = findGatewayControl(CULTIVATION_GATEWAY_TEXT);
      if (cultivationControl) {
        cultivationGatewayOpened = true;
        cultivationControl.click();
        sendStatus('已打开“培养”，正在查找目标功能…');
      }
    }

    if (!cultivationGatewayOpened && !serviceGatewayOpened) {
      const serviceControl = findGatewayControl(SERVICE_GATEWAY_TEXT);
      if (serviceControl) {
        serviceGatewayOpened = true;
        serviceControl.click();
        sendStatus('已打开“服务”，正在查找“培养”…');
      }
    }

    navigationAttempts += 1;
    if (navigationAttempts >= 50) {
      navigationAttempts = 0;
      serviceGatewayOpened = false;
      cultivationGatewayOpened = false;
      await chrome.storage.local.set({ pendingNavigationKind: null, pendingNavigationTabId: null });
      sendStatus('等待约 20 秒仍未找到目标入口。请展开导入诊断信息后反馈。', 'warn');
      return;
    }
    if (navigationTimer) window.clearTimeout(navigationTimer);
    navigationTimer = window.setTimeout(processPendingNavigation, 400);
  }

  function matchesCourse(record, target) {
    return normalizeCourseCode(record.code) === target.code;
  }

  function findClassPicker(record) {
    const selector = 'button, a, input[type="button"], input[type="image"], [role="button"], [onclick]';
    return Array.from(record.row.querySelectorAll(selector)).find((control) => {
      const label = String(
        control.innerText || control.value || control.alt || control.title || control.getAttribute('aria-label') || '',
      ).trim();
      if (!CLASS_PICKER_TEXT.test(label) || DANGER_TEXT.test(label)) return false;
      return !control.disabled && control.getAttribute('aria-disabled') !== 'true';
    });
  }

  function findSafeLocalSelector(record) {
    const controls = Array.from(record.row.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      .filter((control) => {
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
        const label = String(
          control.value || control.title || control.getAttribute('aria-label') || textOf(control.closest('label')) || '',
        ).trim();
        return !DANGER_TEXT.test(label);
      });
    return controls.length === 1 ? controls[0] : null;
  }

  function chooseRandom(items) {
    if (!items.length) return null;
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    return items[random[0] % items.length];
  }

  function activateSelector(control) {
    control.click();
    if (!control.checked) {
      control.checked = true;
      control.setAttribute('aria-checked', 'true');
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function findOpenClassSelectors() {
    const candidates = [];
    const seen = new Set();
    const dialogSelector = '[role="dialog"], .layui-layer, .modal, .dialog, .popup, .el-dialog';
    for (const currentDocument of getAccessibleDocuments()) {
      for (const control of Array.from(currentDocument.querySelectorAll('input[type="checkbox"], input[type="radio"]'))) {
        if (seen.has(control) || control.disabled || !controlIsVisible(control)) continue;
        const row = control.closest('tr, li, [role="row"], .class-item, .course-item') || control.parentElement;
        const table = control.closest('table');
        const dialog = control.closest(dialogSelector);
        const tableHeading = table ? Array.from(table.rows || []).slice(0, 4).map(textOf).join(' ') : '';
        const rowText = textOf(row);
        const isClassArea = Boolean(dialog && controlIsVisible(dialog))
          || /教学班|班级名称|任课教师|授课教师|上课时间|容量|余量/.test(tableHeading);
        if (!isClassArea || !rowText || CLOSED_TEXT.test(rowText) || DANGER_TEXT.test(rowText)) continue;
        if (row?.querySelectorAll?.('th').length && !row.querySelectorAll('td').length) continue;
        seen.add(control);
        candidates.push(control);
      }
    }
    return candidates;
  }

  function isClosed(record) {
    return CLOSED_TEXT.test(`${record.status} ${record.text}`);
  }

  function rememberOriginalStyle(row) {
    if (!Object.hasOwn(row.dataset, 'cquptOriginalStyle')) {
      row.dataset.cquptOriginalStyle = row.getAttribute('style') || '';
    }
  }

  function markRow(row, tone) {
    rememberOriginalStyle(row);
    row.dataset.cquptHelperMark = tone;
    row.style.setProperty('outline', tone === 'ready' ? '3px solid #16a34a' : '2px solid #f59e0b', 'important');
    row.style.setProperty('outline-offset', '-2px', 'important');
    row.style.setProperty('background', tone === 'ready' ? '#dcfce7' : '#fef3c7', 'important');
  }

  function clearMarks() {
    for (const row of document.querySelectorAll('[data-cqupt-helper-mark]')) {
      const original = row.dataset.cquptOriginalStyle || '';
      if (original) row.setAttribute('style', original);
      else row.removeAttribute('style');
      delete row.dataset.cquptHelperMark;
      delete row.dataset.cquptOriginalStyle;
    }
  }

  function sendStatus(text, tone = 'normal') {
    chrome.runtime.sendMessage({ type: 'CQUPT_STATUS', payload: { text, tone } }).catch(() => {});
  }

  function stopTitleFlash() {
    if (titleTimer) window.clearInterval(titleTimer);
    titleTimer = null;
    if (previousTitle) document.title = previousTitle;
  }

  function flashTitle(course) {
    stopTitleFlash();
    previousTitle = document.title;
    let visible = false;
    titleTimer = window.setInterval(() => {
      visible = !visible;
      document.title = visible ? `【发现目标】${course}` : previousTitle;
    }, 800);
  }

  function cancelRefresh() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function cancelReactiveScan() {
    if (mutationScanTimer) window.clearTimeout(mutationScanTimer);
    mutationScanTimer = null;
  }

  function scheduleReactiveScan(delayMs = 35) {
    if (!running || !COURSE_PAGE_RE.test(location.pathname)) return;
    cancelReactiveScan();
    mutationScanTimer = window.setTimeout(async () => {
      mutationScanTimer = null;
      if (!running) return;
      if (scanInProgress) {
        scheduleReactiveScan(60);
        return;
      }
      await scan();
    }, delayMs);
  }

  function installReactiveObserver() {
    if (mutationObserver || !COURSE_PAGE_RE.test(location.pathname) || !document.documentElement) return;
    mutationObserver = new MutationObserver(() => scheduleReactiveScan());
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'checked', 'aria-checked', 'value'],
    });
  }

  async function stopMonitoring(message) {
    running = false;
    cancelRefresh();
    stopTitleFlash();
    await chrome.storage.local.set({ running: false });
    if (message) sendStatus(message);
  }

  async function reloadCurrentCourseFrame() {
    refreshTimer = null;
    if (!running || !config.autoRefresh || !COURSE_PAGE_RE.test(location.pathname)) return;
    const state = await chrome.storage.local.get(['reloadCount', 'running']);
    if (!state.running) return;
    const count = Number.parseInt(state.reloadCount || '0', 10);
    if (count >= MAX_RELOADS) {
      await stopMonitoring(`已达到 ${MAX_RELOADS} 次刷新上限，监控已暂停。`);
      return;
    }
    await chrome.storage.local.set({ reloadCount: count + 1 });
    sendStatus(`正在进行第 ${count + 1} 次低频刷新…`);
    location.reload();
  }

  function scheduleRefresh() {
    if (refreshTimer || !running || !config.autoRefresh || !COURSE_PAGE_RE.test(location.pathname)) return;
    const jitter = Math.floor(Math.random() * 250);
    refreshTimer = window.setTimeout(reloadCurrentCourseFrame, config.refreshSeconds * 1000 + jitter);
  }

  async function onReady(item, signature, availableClassCount = 1) {
    cancelRefresh();
    const course = `${item.record.code} ${item.record.name}`.trim();
    sendStatus(`发现可操作目标：${course}`, 'ready');
    if (signature !== lastReadySignature) {
      chrome.runtime.sendMessage({ type: 'CQUPT_NOTIFY', course }).catch(() => {});
      flashTitle(course);
      item.record.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (item.picker) {
      const courseKey = `${item.record.code}|${item.record.name}`;
      if (courseKey !== openedCourseKey) {
        openedCourseKey = courseKey;
        try {
          pendingClassSelection = { course, startedAt: Date.now() };
          item.picker.click();
          sendStatus(`已打开“${course}”的班级列表，正在选择任一可用班…`, 'ready');
          scheduleReactiveScan(100);
          return;
        } catch {
          pendingClassSelection = null;
          sendStatus(`已精确定位“${course}”，但页面阻止了自动打开，请点击绿色课程行。`, 'warn');
        }
      }
    } else if (item.selector) {
      activateSelector(item.selector);
      sendStatus(
        availableClassCount > 1
          ? `“${course}”共有 ${availableClassCount} 个可用班，已随机勾选其中一个，请核对后手动提交。`
          : `已勾选“${course}”的唯一可用班，请核对后手动提交。`,
        'ready',
      );
    }

    running = false;
    await chrome.storage.local.set({ running: false });
  }

  async function scan({ manual = false } = {}) {
    if (!running || !COURSE_PAGE_RE.test(location.pathname) || scanInProgress) return;
    scanInProgress = true;
    try {
    if (pendingClassSelection) {
      const classSelectors = findOpenClassSelectors();
      if (classSelectors.length) {
        const course = pendingClassSelection.course;
        const alreadySelected = classSelectors.find((control) => control.checked);
        const availableSelectors = classSelectors.filter((control) => !control.checked);
        if (!alreadySelected) activateSelector(chooseRandom(availableSelectors));
        pendingClassSelection = null;
        sendStatus(
          classSelectors.length > 1
            ? `“${course}”共有 ${classSelectors.length} 个可用班，${alreadySelected ? '页面已有选中班级' : '已随机勾选其中一个'}，请核对后手动提交。`
            : `${alreadySelected ? '页面已选中' : '已勾选'}“${course}”的唯一可用班，请核对后手动提交。`,
          'ready',
        );
        running = false;
        await chrome.storage.local.set({ running: false, monitorFailureCount: 0 });
        return;
      }
      if (Date.now() - pendingClassSelection.startedAt < 8000) {
        scheduleReactiveScan(180);
        return;
      }
      pendingClassSelection = null;
      sendStatus('班级列表已打开，但暂未识别到可用班；将继续低频刷新并重试。', 'warn');
    }
    const targets = parseTargets(config.targetsText);
    if (!targets.length) {
      if (manual && COURSE_PAGE_RE.test(location.pathname)) sendStatus('请先在扩展弹窗中填写目标课程。', 'warn');
      return;
    }

    const courseTables = getCourseTables();
    if (!courseTables.length) {
      if (manual && COURSE_PAGE_RE.test(location.pathname)) sendStatus('当前页面未识别到课程表，请等待页面加载完成。', 'warn');
      scheduleRefresh();
      return;
    }

    clearMarks();
    const matches = [];
    const seenRows = new Set();

    for (const { table, headers } of courseTables) {
      const rows = Array.from(table.rows || []).slice(headers.headerRowIndex + 1);
      for (const row of rows) {
        if (seenRows.has(row)) continue;
        seenRows.add(row);
        const record = readRow(row, headers);
        for (const target of targets) {
          if (!matchesCourse(record, target)) continue;
          const picker = findClassPicker(record);
          const selector = picker ? null : findSafeLocalSelector(record);
          const closed = isClosed(record);
          const item = { target, record, picker, selector, closed };
          matches.push(item);
          markRow(record.row, (picker || selector) && !closed ? 'ready' : 'found');
        }
      }
    }

    const ready = matches.filter((item) => (item.picker || item.selector) && !item.closed);

    const signature = ready
      .map((item) => `${item.target.id}:${item.record.code}:${item.record.name}:${item.record.status}`)
      .sort()
      .join('|');

    if (ready.length) {
      const readyGroup = targets
        .map((target) => ready.filter((item) => item.target.id === target.id))
        .find((items) => items.length) || ready;
      await onReady(chooseRandom(readyGroup), signature, readyGroup.length);
    } else if (matches.length) {
      const first = matches[0].record;
      sendStatus(`已按课程编号找到：${first.code} ${first.name}；尚未出现可操作入口。`);
      scheduleRefresh();
    } else {
      sendStatus(manual ? '当前课程表中暂未找到这些课程编号。' : '监控中：暂未找到目标课程编号。');
      scheduleRefresh();
    }
    consecutiveScanFailures = 0;
    if (manual) await chrome.storage.local.set({ monitorFailureCount: 0, lastHealthyAt: Date.now() });
    lastReadySignature = signature;
    } catch (error) {
      consecutiveScanFailures += 1;
      await chrome.storage.local.set({ monitorFailureCount: consecutiveScanFailures });
      sendStatus(`监听检测异常，正在自动恢复（${consecutiveScanFailures}/3）…`, 'warn');
      cancelRefresh();
      if (consecutiveScanFailures >= 3) {
        consecutiveScanFailures = 0;
        refreshTimer = window.setTimeout(reloadCurrentCourseFrame, 1200);
      } else {
        scheduleReactiveScan(500 * consecutiveScanFailures);
      }
    } finally {
      scanInProgress = false;
    }
  }

  async function loadState() {
    const local = await chrome.storage.local.get([
      'config', 'running', 'wizardActive', 'monitorTabId', 'pendingStart', 'pendingStartTabId',
      'pendingNavigationKind', 'pendingNavigationTabId',
    ]);
    try {
      const context = await chrome.runtime.sendMessage({ type: 'CQUPT_GET_TAB_CONTEXT' });
      currentTabId = context?.tabId ?? null;
    } catch {
      currentTabId = null;
    }
    config = {
      ...DEFAULT_CONFIG,
      ...(local.config || {}),
      refreshSeconds: clampRefreshSeconds(local.config?.refreshSeconds),
    };
    monitorTabId = local.monitorTabId ?? null;
    if (local.pendingStart && local.pendingStartTabId === currentTabId && COURSE_PAGE_RE.test(location.pathname)) {
      const status = {
        tone: 'normal',
        text: `已进入选课管理；页面变化将即时检测，约每 ${config.refreshSeconds} 秒刷新。`,
        updatedAt: Date.now(),
      };
      monitorTabId = currentTabId;
      await chrome.storage.local.set({
        running: true,
        pendingStart: false,
        pendingStartTabId: null,
        monitorTabId: currentTabId,
        latestStatus: status,
      });
      local.running = true;
    }
    running = Boolean(local.running) && currentTabId !== null && monitorTabId === currentTabId;
    wizardActive = Boolean(local.wizardActive);
  }

  async function syncRunningScope() {
    const local = await chrome.storage.local.get(['running', 'monitorTabId']);
    if (currentTabId === null) {
      try {
        const context = await chrome.runtime.sendMessage({ type: 'CQUPT_GET_TAB_CONTEXT' });
        currentTabId = context?.tabId ?? null;
      } catch {
        currentTabId = null;
      }
    }
    monitorTabId = local.monitorTabId ?? null;
    const nextRunning = Boolean(local.running) && currentTabId !== null && monitorTabId === currentTabId;
    const shouldScan = nextRunning && !running;
    running = nextRunning;
    cancelRefresh();
    cancelReactiveScan();
    if (shouldScan) {
      openedCourseKey = '';
      await scan({ manual: true });
    }
  }

  function inspectMonitoringHealth() {
    let courseFrameFound = false;
    let courseFrameHealthy = false;
    let loginExpired = false;
    for (const currentDocument of getAccessibleDocuments()) {
      const bodyText = textOf(currentDocument.body).slice(0, 3000);
      let pathname = '';
      try {
        pathname = currentDocument.defaultView?.location?.pathname || '';
      } catch {
        pathname = '';
      }
      const isCourse = COURSE_PAGE_RE.test(pathname) || /课程网上选课管理/.test(`${currentDocument.title} ${bodyText}`);
      if (isCourse) {
        courseFrameFound = true;
        if (currentDocument.readyState !== 'loading' && bodyText.length > 20) courseFrameHealthy = true;
      }
      if (currentDocument.querySelector('input[type="password"], form[action*="login" i]')
        && /登录|统一认证|账号|密码/.test(bodyText)) loginExpired = true;
    }
    return { courseFrameFound, courseFrameHealthy, loginExpired };
  }

  function reloadUnhealthyCourseFrame() {
    for (const currentDocument of getAccessibleDocuments()) {
      const bodyText = textOf(currentDocument.body).slice(0, 3000);
      let pathname = '';
      try {
        pathname = currentDocument.defaultView?.location?.pathname || '';
      } catch {
        pathname = '';
      }
      const isCourse = COURSE_PAGE_RE.test(pathname) || /课程网上选课管理/.test(`${currentDocument.title} ${bodyText}`);
      if (!isCourse || (currentDocument.readyState !== 'loading' && bodyText.length > 20)) continue;
      try {
        currentDocument.defaultView.location.reload();
        return true;
      } catch {
        // Fall through to reopening the system section.
      }
    }
    return false;
  }

  async function monitorHealthTick() {
    if (window.top !== window) return;
    const local = await chrome.storage.local.get(['running', 'monitorTabId', 'monitorRecoveryCount']);
    if (!local.running || local.monitorTabId !== currentTabId) {
      missingCourseFrameChecks = 0;
      return;
    }
    const health = inspectMonitoringHealth();
    if (health.loginExpired) {
      running = false;
      await chrome.storage.local.set({ running: false, monitorTabId: null });
      chrome.runtime.sendMessage({ type: 'CQUPT_LOGIN_EXPIRED' }).catch(() => {});
      sendStatus('监听已停止：登录状态失效，请重新登录。', 'error');
      return;
    }
    if (health.courseFrameHealthy) {
      const recovered = missingCourseFrameChecks > 0;
      missingCourseFrameChecks = 0;
      if (recovered || Date.now() - lastHealthWriteAt > 15000) {
        lastHealthWriteAt = Date.now();
        await chrome.storage.local.set({ monitorFailureCount: 0, monitorRecoveryCount: 0, lastHealthyAt: lastHealthWriteAt });
      }
      return;
    }
    missingCourseFrameChecks += 1;
    await chrome.storage.local.set({ monitorFailureCount: missingCourseFrameChecks });
    if (missingCourseFrameChecks < 3) return;
    missingCourseFrameChecks = 0;
    const recoveryCount = Number.parseInt(local.monitorRecoveryCount || '0', 10);
    if (recoveryCount >= 5) {
      running = false;
      await chrome.storage.local.set({ running: false, monitorTabId: null });
      sendStatus('选课页面连续 5 次自动恢复失败，监听已暂停，请重新点击“去选课”。', 'error');
      return;
    }
    await chrome.storage.local.set({ monitorRecoveryCount: recoveryCount + 1 });
    if (health.courseFrameFound && reloadUnhealthyCourseFrame()) {
      sendStatus(`检测到选课页面白屏或加载中断，正在执行第 ${recoveryCount + 1} 次框架重载…`, 'warn');
      return;
    }
    await chrome.storage.local.set({
      running: true,
      pendingStart: true,
      pendingStartTabId: currentTabId,
      monitorTabId: currentTabId,
      pendingNavigationKind: 'course',
      pendingNavigationTabId: currentTabId,
    });
    sendStatus(`检测到选课页面加载异常，正在执行第 ${recoveryCount + 1} 次自动恢复…`, 'warn');
    await processPendingNavigation();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (window.top !== window) return;
    if (message?.type === 'CQUPT_SHOW_IMPORT_SUCCESS') {
      const codes = Array.isArray(message.codes)
        ? message.codes.map(normalizeCourseCode).filter((code) => /^[A-Z][A-Z0-9_-]{2,30}$/.test(code))
        : [];
      const creditSummary = message.creditSummary && typeof message.creditSummary === 'object'
        ? message.creditSummary
        : { available: false, items: [], allMet: false, unknownCourseCodes: [] };
      showPlanImportSuccess([...new Set(codes)], creditSummary);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== 'CQUPT_START_PLAN_GUIDE') return;
    startPlanGuide()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local' && changes.config) {
      config = {
        ...DEFAULT_CONFIG,
        ...(changes.config.newValue || {}),
        refreshSeconds: clampRefreshSeconds(changes.config.newValue?.refreshSeconds),
      };
      openedCourseKey = '';
      if (running) await scan({ manual: true });
    }

    if (areaName === 'local' && (changes.running || changes.monitorTabId)) {
      await syncRunningScope();
    }

    if (areaName === 'local' && changes.pendingNavigationKind && window.top === window) {
      navigationAttempts = 0;
      serviceGatewayOpened = false;
      cultivationGatewayOpened = false;
      if (changes.pendingNavigationKind.newValue) await processPendingNavigation();
    }

    if (areaName === 'local' && changes.wizardActive && window.top === window) {
      wizardActive = Boolean(changes.wizardActive.newValue);
      if (wizardActive) {
        ensureWizardPanel();
        if (planPageIsVisible()) {
          setWizardMessage('请在培养方案中勾选要抢的课程，完成后点击下方按钮。');
        }
      } else {
        const panel = document.getElementById(WIZARD_PANEL_ID);
        if (panel?.dataset.cquptImportSuccess !== 'true') removeWizardPanel();
      }
    }

    if (areaName === 'local' && changes.manualScanNonce && running) {
      await scan({ manual: true });
    }

    if (areaName === 'local' && changes.latestStatus?.newValue?.tone !== 'ready') {
      stopTitleFlash();
    }
  });

  window.addEventListener('focus', () => {
    stopTitleFlash();
    scheduleReactiveScan(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleReactiveScan(0);
  });
  window.addEventListener('beforeunload', () => {
    if (scanTimer) window.clearInterval(scanTimer);
    if (wizardTimer) window.clearInterval(wizardTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    if (healthTimer) window.clearInterval(healthTimer);
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = null;
    cancelReactiveScan();
    cancelRefresh();
    stopTitleFlash();
  });

  loadState().then(async () => {
    if (window.top === window) {
      const currentUrl = new URL(location.href);
      const bodyLead = textOf(document.body).slice(0, 4000);
      const loginForm = Boolean(document.querySelector('input[type="password"], form[action*="login" i]'))
        && /登录|统一认证|账号|密码/.test(bodyLead);
      const authenticatedEvidence = !loginForm && (
        COURSE_PAGE_RE.test(location.pathname)
        || (/\/Gstudent\/DefaultN\.aspx/i.test(location.pathname) && Boolean(currentUrl.searchParams.get('EID')))
        || (/研究生在线|培养方案|课程网上选课管理/.test(`${document.title} ${bodyLead}`) && bodyLead.length > 80)
      );
      chrome.runtime.sendMessage({ type: 'CQUPT_LOGIN_REACHED_GS', authenticatedEvidence }).catch(() => {});
    }
    if (running) await scan({ manual: true });
    installReactiveObserver();
    await processPendingNavigation();
    if (wizardActive && window.top === window) ensureWizardPanel();
    scanTimer = window.setInterval(() => {
      if (running) scan();
    }, SCAN_INTERVAL_MS);
    if (window.top === window) {
      healthTimer = window.setInterval(() => monitorHealthTick().catch(() => {}), 2000);
      wizardTimer = window.setInterval(() => {
        if (!wizardActive) return;
        ensureWizardPanel();
        if (planPageIsVisible()) {
          setWizardMessage('请在培养方案中勾选要抢的课程，完成后点击下方按钮。');
        }
      }, 1000);
    }
  });
})();
