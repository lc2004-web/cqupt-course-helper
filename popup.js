'use strict';

const DEFAULT_CONFIG = {
  targetsText: '',
  autoRefresh: true,
  refreshSeconds: 15,
  classPreferences: {},
};

const LOGIN_URL = 'https://ids.cqupt.edu.cn/authserver/login?service=https%3A%2F%2Fi.cqupt.edu.cn%2Flogin%23%2F';
const SCHEDULE_CATALOG_URL = 'course-schedule-2026-2027.json';
const COURSE_POLICY = globalThis.CQUPTCoursePolicy;
let scheduleCatalog = { courses: {}, courseCount: 0, classCount: 0 };
let classPreferences = {};
let autoAssignedExclusions = [];
const elements = {
  loginCard: document.getElementById('loginCard'),
  courseWorkspace: document.getElementById('courseWorkspace'),
  logout: document.getElementById('logout'),
  studentId: document.getElementById('studentId'),
  loginPassword: document.getElementById('loginPassword'),
  toggleLoginPassword: document.getElementById('toggleLoginPassword'),
  rememberCredentials: document.getElementById('rememberCredentials'),
  schoolRememberMe: document.getElementById('schoolRememberMe'),
  oneClickLogin: document.getElementById('oneClickLogin'),
  loginStatus: document.getElementById('loginStatus'),
  targets: document.getElementById('targets'),
  autoAssignedNotice: document.getElementById('autoAssignedNotice'),
  autoAssignedNoticeText: document.getElementById('autoAssignedNoticeText'),
  preferenceCard: document.getElementById('preferenceCard'),
  preferenceSummary: document.getElementById('preferenceSummary'),
  preferenceRows: document.getElementById('preferenceRows'),
  autoRefresh: document.getElementById('autoRefresh'),
  refreshSeconds: document.getElementById('refreshSeconds'),
  planGuide: document.getElementById('planGuide'),
  openPlan: document.getElementById('openPlan'),
  goCourse: document.getElementById('goCourse'),
  startListen: document.getElementById('startListen'),
  creditComparison: document.getElementById('creditComparison'),
  creditOverall: document.getElementById('creditOverall'),
  creditComparisonRows: document.getElementById('creditComparisonRows'),
  creditComparisonNote: document.getElementById('creditComparisonNote'),
  importSuccess: document.getElementById('importSuccess'),
  importSuccessText: document.getElementById('importSuccessText'),
  dismissImportSuccess: document.getElementById('dismissImportSuccess'),
  status: document.getElementById('status'),
  diagnosticOutput: document.getElementById('diagnosticOutput'),
};

function clampRefreshSeconds(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_CONFIG.refreshSeconds;
  return Math.min(600, Math.max(1, number));
}

function readConfig() {
  const codes = parseCourseCodes(elements.targets.value).codes;
  return {
    targetsText: elements.targets.value,
    autoRefresh: elements.autoRefresh.checked,
    refreshSeconds: clampRefreshSeconds(elements.refreshSeconds.value),
    classPreferences: normalizeClassPreferences(classPreferences, codes),
  };
}

function renderConfig(config) {
  elements.targets.value = config.targetsText || '';
  elements.autoRefresh.checked = Boolean(config.autoRefresh);
  elements.refreshSeconds.value = clampRefreshSeconds(config.refreshSeconds);
  classPreferences = normalizeClassPreferences(config.classPreferences);
}

function normalizeExclusions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const policyCourse = COURSE_POLICY?.findAutoAssignedCourse(raw?.code, raw?.name);
    if (!policyCourse || seen.has(policyCourse.code)) continue;
    result.push({ code: policyCourse.code, name: policyCourse.name });
    seen.add(policyCourse.code);
  }
  return result;
}

function renderAutoAssignedNotice(exclusions = autoAssignedExclusions) {
  autoAssignedExclusions = normalizeExclusions(exclusions);
  elements.autoAssignedNotice.hidden = !autoAssignedExclusions.length;
  elements.autoAssignedNoticeText.textContent = autoAssignedExclusions
    .map((course) => `${course.code} ${course.name}`)
    .join('、');
}

function parseCourseCodes(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const invalid = lines.filter((line) => !/^[A-Za-z0-9][A-Za-z0-9_-]{2,30}$/.test(line));
  const codes = [...new Set(lines.filter((line) => !invalid.includes(line)).map((line) => line.toUpperCase()))];
  return { codes, invalid };
}

function normalizeClassPreferences(value, allowedCodes = null) {
  const allowed = allowedCodes ? new Set(allowedCodes) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawCode, rawPreference] of Object.entries(value)) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,30}$/.test(code) || (allowed && !allowed.has(code))) continue;
    if (!rawPreference || typeof rawPreference !== 'object' || !rawPreference.classId) continue;
    normalized[code] = {
      classId: String(rawPreference.classId || ''),
      className: String(rawPreference.className || ''),
      teachers: Array.isArray(rawPreference.teachers)
        ? rawPreference.teachers.map((name) => String(name || '').trim()).filter(Boolean)
        : [],
      schedule: String(rawPreference.schedule || ''),
      location: String(rawPreference.location || ''),
    };
  }
  return normalized;
}

async function loadScheduleCatalog() {
  try {
    const response = await fetch(chrome.runtime.getURL(SCHEDULE_CATALOG_URL));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    if (!catalog?.courses || typeof catalog.courses !== 'object') throw new Error('排课数据格式无效');
    scheduleCatalog = catalog;
  } catch (error) {
    scheduleCatalog = { courses: {}, courseCount: 0, classCount: 0, error: String(error?.message || error) };
  }
}

function classOptionLabel(item) {
  const teachers = Array.isArray(item.teachers) && item.teachers.length
    ? item.teachers.join('、')
    : '教师待定';
  const timeMatch = String(item.schedule || '').match(/星期[一二三四五六日天]\([^)]*\)/);
  const time = timeMatch?.[0] || String(item.schedule || '').slice(0, 22) || '时间待定';
  const location = String(item.location || '').trim();
  return [item.className, teachers, time, location].filter(Boolean).join('｜');
}

function updatePreferenceSummary(codes) {
  const configured = codes.filter((code) => classPreferences[code]?.classId).length;
  elements.preferenceSummary.textContent = `${configured}/${codes.length} 门已设置`;
}

function renderPreferenceEditor(codes = parseCourseCodes(elements.targets.value).codes) {
  elements.preferenceRows.replaceChildren();
  elements.preferenceCard.hidden = !codes.length;
  if (!codes.length) return;

  for (const code of codes) {
    const course = scheduleCatalog.courses?.[code];
    const row = document.createElement('div');
    row.className = 'preference-row';
    const heading = document.createElement('div');
    heading.className = 'preference-course';
    const title = document.createElement('strong');
    title.textContent = `${code}${course?.name ? ` ${course.name}` : ''}`;
    title.title = title.textContent;
    const count = document.createElement('span');
    count.textContent = course?.classes?.length ? `${course.classes.length} 个班` : '暂无排课数据';
    heading.append(title, count);
    row.appendChild(heading);

    if (!course?.classes?.length) {
      const empty = document.createElement('div');
      empty.className = 'preference-empty';
      empty.textContent = '排课表中未找到该课程，监听时将从网页实际出现的可用班中选择。';
      row.appendChild(empty);
      elements.preferenceRows.appendChild(row);
      continue;
    }

    const select = document.createElement('select');
    select.dataset.courseCode = code;
    select.setAttribute('aria-label', `${code} 教师与班级偏好`);
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '不指定（任一可用班）';
    select.appendChild(automatic);
    for (const classItem of course.classes) {
      const option = document.createElement('option');
      option.value = classItem.id;
      option.textContent = classOptionLabel(classItem);
      select.appendChild(option);
    }
    const currentId = classPreferences[code]?.classId || '';
    select.value = course.classes.some((item) => item.id === currentId) ? currentId : '';
    if (!select.value && currentId) delete classPreferences[code];
    select.addEventListener('change', async () => {
      const selected = course.classes.find((item) => item.id === select.value);
      if (selected) {
        classPreferences[code] = {
          classId: selected.id,
          className: selected.className,
          teachers: Array.isArray(selected.teachers) ? selected.teachers : [],
          schedule: selected.schedule || '',
          location: selected.location || '',
        };
      } else {
        delete classPreferences[code];
      }
      updatePreferenceSummary(codes);
      await saveConfig(false);
    });
    row.appendChild(select);
    elements.preferenceRows.appendChild(row);
  }
  updatePreferenceSummary(codes);
}

function guideToPreferences() {
  elements.importSuccess.hidden = true;
  if (elements.preferenceCard.hidden) return;
  elements.preferenceCard.classList.remove('is-guided');
  void elements.preferenceCard.offsetWidth;
  elements.preferenceCard.classList.add('is-guided');
  elements.preferenceCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStatus(status, running) {
  const text = status?.text || (running ? '监控中…' : '已暂停。');
  const tone = status?.tone || 'normal';
  elements.status.textContent = text;
  elements.status.dataset.tone = tone;
  elements.loginStatus.textContent = text;
  elements.loginStatus.dataset.tone = tone;
  elements.goCourse.disabled = Boolean(running);
  elements.startListen.disabled = false;
  elements.startListen.textContent = running ? '停止监听' : '开始监听';
  elements.startListen.classList.toggle('primary', !running);
  elements.startListen.classList.toggle('danger', Boolean(running));
}

function renderAuthGate(authenticated) {
  elements.loginCard.hidden = Boolean(authenticated);
  elements.courseWorkspace.hidden = !authenticated;
}

function setPasswordVisibility(visible) {
  elements.loginPassword.type = visible ? 'text' : 'password';
  elements.toggleLoginPassword.setAttribute('aria-pressed', String(visible));
  elements.toggleLoginPassword.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  elements.toggleLoginPassword.title = visible ? '隐藏密码' : '显示密码';
}

function formatCredits(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1).replace(/\.0$/, '');
}

function renderCreditComparison(summary) {
  const available = Boolean(summary?.available && Array.isArray(summary.items) && summary.items.length);
  elements.creditComparison.hidden = !available;
  if (!available) return;
  elements.creditComparisonRows.replaceChildren();
  for (const item of summary.items) {
    const row = document.createElement('div');
    row.className = `credit-row ${item.met ? 'pass' : 'fail'}`;
    const label = document.createElement('strong');
    label.textContent = item.category;
    const value = document.createElement('span');
    value.className = 'credit-value';
    value.textContent = item.met
      ? `${formatCredits(item.selected)} / ${formatCredits(item.required)} 学分 ✓`
      : `${formatCredits(item.selected)} / ${formatCredits(item.required)} 学分（差 ${formatCredits(item.missing)}）`;
    row.append(label, value);
    elements.creditComparisonRows.appendChild(row);
  }
  elements.creditOverall.textContent = summary.allMet ? '已满足最低要求' : '尚未满足';
  elements.creditOverall.className = summary.allMet ? 'pass' : 'fail';
  elements.creditComparisonNote.textContent = summary.unknownCourseCodes?.length
    ? `${summary.unknownCourseCodes.length} 门课程未能识别学分或类型，未计入上方合计：${summary.unknownCourseCodes.join('、')}`
    : '按本次导入的已选课程学分与页面“最低学分要求”核对。';
}

function creditSummaryText(summary) {
  if (!summary?.available || !summary.items?.length) return '未能读取页面最低学分要求。';
  const details = summary.items.map((item) => item.met
    ? `${item.category} ${formatCredits(item.selected)}/${formatCredits(item.required)} ✓`
    : `${item.category} ${formatCredits(item.selected)}/${formatCredits(item.required)}（差 ${formatCredits(item.missing)}）`);
  return `${summary.allMet ? '已满足最低学分要求' : '尚未满足最低学分要求'}\n${details.join('；')}`;
}

function showImportSuccess(codes, creditSummary, excludedCourses = autoAssignedExclusions) {
  const preview = codes.slice(0, 8).join('、');
  const remainder = codes.length > 8 ? ` 等 ${codes.length} 门` : '';
  const targetText = codes.length
    ? `已加入 ${codes.length} 门抢课目标：\n${preview}${remainder}`
    : '暂无需要自行选择的课程。';
  const exclusionText = excludedCourses.length
    ? `\n\n已跳过学校统一分班课程：\n${excludedCourses.map((course) => `${course.code} ${course.name}`).join('、')}`
    : '';
  const nextStep = codes.length ? '\n\n下一步：设置偏好教师或教学班。' : '';
  elements.importSuccessText.textContent = `${targetText}${exclusionText}\n\n${creditSummaryText(creditSummary)}${nextStep}`;
  elements.importSuccess.hidden = false;
}

async function saveConfig(showMessage = true) {
  const config = readConfig();
  const parsed = parseCourseCodes(config.targetsText);
  if (parsed.invalid.length) {
    const status = { tone: 'warn', text: `以下内容不是有效课程编号：${parsed.invalid.join('、')}` };
    renderStatus(status, false);
    return null;
  }
  const filtered = COURSE_POLICY?.filterCourseCodes(parsed.codes)
    || { includedCodes: parsed.codes, excluded: [] };
  if (filtered.excluded.length) renderAutoAssignedNotice(filtered.excluded);
  config.targetsText = filtered.includedCodes.join('\n');
  config.classPreferences = normalizeClassPreferences(classPreferences, filtered.includedCodes);
  classPreferences = config.classPreferences;
  elements.targets.value = config.targetsText;
  elements.refreshSeconds.value = config.refreshSeconds;
  await chrome.storage.local.set({ config, autoAssignedExclusions });
  if (showMessage) {
    const status = {
      tone: filtered.excluded.length ? 'warn' : 'normal',
      text: filtered.excluded.length
        ? `已过滤 ${filtered.excluded.length} 门学校统一分班课程，其余设置已保存。`
        : '设置已保存到本机浏览器。',
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ latestStatus: status });
    const state = await chrome.storage.local.get('running');
    renderStatus(status, state.running);
  }
  return config;
}

async function activeTabIsSupported() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Boolean(tab?.url && /^https:\/\/gs\.cqupt\.edu\.cn\//i.test(tab.url));
}

async function initialize() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['config', 'running', 'latestStatus', 'loginConfig', 'creditSummary', 'autoAssignedExclusions']),
    chrome.storage.session.get('cquptLoginSession'),
    loadScheduleCatalog(),
  ]);
  renderConfig({ ...DEFAULT_CONFIG, ...(local.config || {}) });
  renderAutoAssignedNotice(local.autoAssignedExclusions);
  renderPreferenceEditor();
  const loginConfig = local.loginConfig || {};
  const loginSession = session.cquptLoginSession || {};
  elements.studentId.value = loginConfig.studentId || loginSession.studentId || '';
  elements.rememberCredentials.checked = Boolean(loginConfig.rememberCredentials);
  if (loginConfig.rememberCredentials && loginConfig.password) elements.loginPassword.value = loginConfig.password;
  elements.schoolRememberMe.checked = Boolean(loginConfig.schoolRememberMe);
  if (loginSession.password) elements.loginPassword.placeholder = '本次会话已有密码，可留空';
  let authenticated = Boolean(loginSession.authenticated);
  if (!authenticated) {
    authenticated = await synchronizeLoginState();
    if (authenticated) local.latestStatus = (await chrome.storage.local.get('latestStatus')).latestStatus;
  }
  renderAuthGate(authenticated);
  renderStatus(local.latestStatus, local.running);
  renderCreditComparison(local.creditSummary);
}

async function beginOneClickLogin() {
  const [session, local] = await Promise.all([
    chrome.storage.session.get('cquptLoginSession'),
    chrome.storage.local.get('loginConfig'),
  ]);
  const previousSession = session.cquptLoginSession || {};
  const previousConfig = local.loginConfig || {};
  const studentId = elements.studentId.value.trim() || previousSession.studentId || previousConfig.studentId || '';
  const password = elements.loginPassword.value || previousSession.password
    || (previousConfig.rememberCredentials ? previousConfig.password : '') || '';
  if (!studentId) {
    renderStatus({ tone: 'warn', text: '请先填写统一认证学号。' }, false);
    return false;
  }

  const rememberCredentials = elements.rememberCredentials.checked;
  const schoolRememberMe = elements.schoolRememberMe.checked;
  await chrome.storage.local.set({
    loginConfig: rememberCredentials ? {
      studentId,
      password,
      rememberCredentials: true,
      schoolRememberMe,
    } : { studentId: '', password: '', rememberCredentials: false, schoolRememberMe },
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const canReuse = activeTab?.id && /^https:\/\/(?:ids|i|gs)\.cqupt\.edu\.cn\//i.test(activeTab.url || '');
  // Keep a newly created placeholder tab in the background until the login
  // session is ready. Activating it here closes the extension popup on Linux
  // Edge and can destroy this script before the URL update is dispatched.
  const targetTab = canReuse ? activeTab : await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!targetTab?.id) throw new Error('无法创建学校登录标签页');

  await chrome.storage.session.set({
    cquptLoginSession: {
      studentId,
      password,
      schoolRememberMe,
      pending: true,
      pendingTabId: targetTab.id,
      attemptSubmitted: false,
      verificationRequired: false,
      authenticated: false,
      startedAt: Date.now(),
    },
  });
  await chrome.storage.session.remove('cquptLogoutSession');
  elements.loginPassword.value = '';
  const status = {
    tone: 'normal',
    text: password ? '正在打开统一认证并登录…' : '正在打开统一认证，并尝试使用 Edge 已保存的密码…',
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ latestStatus: status });
  await chrome.tabs.update(targetTab.id, { url: LOGIN_URL, active: true });
  window.close();
  return true;
}

async function beginLogout() {
  await chrome.storage.session.set({
    cquptLoginSession: {
      studentId: '',
      password: '',
      schoolRememberMe: false,
      pending: false,
      pendingTabId: null,
      attemptSubmitted: false,
      verificationRequired: false,
      authenticated: false,
    },
  });
  await chrome.storage.session.remove('cquptLogoutSession');
  const status = { tone: 'normal', text: '已退出登录，请输入新的账号和密码。', updatedAt: Date.now() };
  await chrome.storage.local.set({
    loginConfig: {
      studentId: '',
      password: '',
      rememberCredentials: false,
      schoolRememberMe: false,
    },
    creditSummary: null,
    running: false,
    pendingStart: false,
    pendingStartTabId: null,
    monitorTabId: null,
    pendingNavigationKind: null,
    pendingNavigationTabId: null,
    latestStatus: status,
  });
  elements.studentId.value = '';
  elements.loginPassword.value = '';
  elements.loginPassword.placeholder = '统一认证密码';
  setPasswordVisibility(false);
  elements.rememberCredentials.checked = false;
  elements.schoolRememberMe.checked = false;
  renderAuthGate(false);
  renderStatus(status, false);
  elements.studentId.focus();
}

function collectPlanCoursesInFrame() {
  const compact = (value) => String(value || '').trim().replace(/[\s\u3000]+/g, ' ');
  const normalized = (value) => compact(value).replace(/\s+/g, '').toUpperCase();
  const textOf = (element) => compact(element?.innerText || element?.textContent || '');
  const codePattern = /^[A-Z0-9][A-Z0-9_-]{2,30}$/;
  const categories = ['公共必修', '公共基础', '专业基础', '专业课', '自选课', '其他培养环节'];
  const categoryOf = (value) => categories.find((category) => String(value || '').includes(category)) || '';
  const numberOf = (value) => {
    const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number.parseFloat(match[0]) : null;
  };
  const headingText = Array.from(document.querySelectorAll('h1, h2, h3, legend, .title, .panel-title, .caption'))
    .slice(0, 20)
    .map(textOf)
    .join(' ');
  const pathname = location.pathname || '';
  const viewText = `${document.title || ''} ${headingText} ${pathname}`;
  const bodyLead = textOf(document.body).slice(0, 5000);
  const pageLooksCourse = /课程网上选课管理|网上选课管理|PlanCourseOnlineSel/i.test(viewText);
  const pageLooksPlan = /培养方案|培养计划/i.test(viewText) || /(?:Train|StudyPlan|PersonalPlan)/i.test(pathname)
    || (!pageLooksCourse && /培养方案|培养计划/.test(bodyLead));
  const visibleCodes = new Set();
  const selectedCodes = new Set();
  const courses = new Map();
  const requirements = {};
  const requirementTail = bodyLead.split(/最低学分要求\s*[：:]?/).slice(1).join('最低学分要求').slice(0, 500);
  if (requirementTail) {
    for (const category of categories) {
      const match = requirementTail.match(new RegExp(`${category}\\s*[：:]\\s*(\\d+(?:\\.\\d+)?)`));
      if (match) requirements[category] = Number.parseFloat(match[1]);
    }
  }
  let courseTableCount = 0;
  let selectionControlCount = 0;

  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.rows || []);
    let headerIndex = -1;
    let codeIndex = -1;
    let nameIndex = -1;
    let categoryIndex = -1;
    let creditIndex = -1;
    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 6); rowIndex += 1) {
      const labels = Array.from(rows[rowIndex].cells || []).map((cell) => normalized(textOf(cell)));
      const foundIndex = labels.findIndex((label) => /课程编号|课程代码|课程序号/.test(label));
      if (foundIndex >= 0) {
        headerIndex = rowIndex;
        codeIndex = foundIndex;
        nameIndex = labels.findIndex((label) => /课程名称|课程名/.test(label));
        categoryIndex = labels.findIndex((label) => /课程类别|课程类型/.test(label));
        creditIndex = labels.findIndex((label) => /^学分$|课程学分/.test(label));
        break;
      }
    }
    if (headerIndex < 0) continue;
    courseTableCount += 1;
    const tableContext = `${textOf(table.caption)} ${textOf(table.previousElementSibling)} ${textOf(table.parentElement?.previousElementSibling)}`;
    const tableIsSelectedList = /已选课程|已选择课程|个人培养计划|培养计划课程/.test(tableContext);
    const tableHasControls = Boolean(table.querySelector('input[type="checkbox"], input[type="radio"]'));
    if (tableHasControls) selectionControlCount += 1;

    for (const row of rows.slice(headerIndex + 1)) {
      const cells = Array.from(row.cells || []);
      const actualCodeIndex = cells.findIndex((cell) => codePattern.test(normalized(textOf(cell))));
      const code = actualCodeIndex >= 0 ? normalized(textOf(cells[actualCodeIndex])) : normalized(textOf(cells[codeIndex]));
      if (!codePattern.test(code)) continue;
      const offset = actualCodeIndex >= 0 ? actualCodeIndex - codeIndex : 0;
      const adjustedCell = (index) => index >= 0 ? cells[index + offset] : null;
      const name = textOf(adjustedCell(nameIndex));
      const category = categoryOf(textOf(adjustedCell(categoryIndex)));
      const credits = numberOf(textOf(adjustedCell(creditIndex)));
      visibleCodes.add(code);
      const rowText = textOf(row);
      const negativeState = /未选中|未选择/.test(rowText);
      const explicitlySelected = Boolean(
        row.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')
        || row.getAttribute('aria-selected') === 'true'
        || row.querySelector('[aria-selected="true"], [aria-checked="true"], [aria-pressed="true"]')
        || /(?:^|\s)(?:selected|checked|chosen)(?:\s|$)/i.test(row.className || '')
        || (!negativeState && /已选|已选择|选中|退选|移除/.test(rowText))
        || (tableIsSelectedList && !tableHasControls)
      );
      if (explicitlySelected) selectedCodes.add(code);
      const previous = courses.get(code);
      courses.set(code, {
        code,
        name: name || previous?.name || '',
        category: category || previous?.category || '',
        credits: Number.isFinite(credits) ? credits : (previous?.credits ?? null),
        selected: explicitlySelected || Boolean(previous?.selected),
      });
    }
  }

  return {
    url: location.href,
    title: document.title || '',
    pageLooksPlan,
    pageLooksCourse,
    courseTableCount,
    selectionControlCount,
    visibleCodes: [...visibleCodes],
    selectedCodes: [...selectedCodes],
    courses: [...courses.values()],
    requirements,
  };
}

function buildCreditSummary(planReports, codes) {
  const knownCategories = ['公共必修', '公共基础', '专业基础', '专业课', '自选课', '其他培养环节'];
  const requirementReport = [...planReports]
    .sort((a, b) => Object.keys(b.requirements || {}).length - Object.keys(a.requirements || {}).length)[0];
  const requirements = requirementReport?.requirements || {};
  const categories = Object.keys(requirements);
  if (!categories.length) return { available: false, items: [], allMet: false, unknownCourseCodes: [] };

  const wanted = new Set(codes);
  const courseMap = new Map();
  for (const report of planReports) {
    for (const course of report.courses || []) {
      if (!wanted.has(course.code)) continue;
      const previous = courseMap.get(course.code);
      courseMap.set(course.code, {
        code: course.code,
        category: course.category || previous?.category || '',
        credits: Number.isFinite(course.credits) ? course.credits : (previous?.credits ?? null),
      });
    }
  }
  const selectedTotals = Object.fromEntries(categories.map((category) => [category, 0]));
  const unknownCourseCodes = [];
  for (const code of codes) {
    const course = courseMap.get(code);
    if (!course || !knownCategories.includes(course.category) || !Number.isFinite(course.credits)) {
      unknownCourseCodes.push(code);
      continue;
    }
    if (categories.includes(course.category)) selectedTotals[course.category] += course.credits;
  }
  const items = categories.map((category) => {
    const selected = Number(selectedTotals[category].toFixed(2));
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

function clickSystemMenuInFrame(kind) {
  const textOf = (element) => String(
    element?.innerText || element?.textContent || element?.value || element?.title || element?.getAttribute?.('aria-label') || '',
  ).trim().replace(/\s+/g, ' ');
  const allowed = kind === 'plan'
    ? ['培养方案选择', '培养计划制定', '培养计划', '培养方案']
    : ['课程网上选课管理', '网上选课管理', '课程网上选课', '选课管理'];
  const normalizedLabel = (value) => (typeof value === 'string' ? value : textOf(value))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
    .toLowerCase();
  const labelScore = (label) => {
    const normalized = normalizedLabel(label);
    if (!normalized || /(?:通知|公告|新闻|关于|说明|指南|提醒|公示|附件|下载|详情|政策)/.test(normalized)) return 0;
    let best = 0;
    for (const item of allowed) {
      const expected = normalizedLabel(item);
      if (normalized === expected) best = Math.max(best, 100);
      else if ((normalized.startsWith(expected) || normalized.endsWith(expected)) && normalized.length - expected.length <= 8) {
        best = Math.max(best, 70 - (normalized.length - expected.length));
      }
    }
    return best;
  };
  const dangerous = /提交|确认|保存|立即选课|退选|删除|清空|撤销/;
  const isVisible = (control) => {
    if (!control || control.nodeType !== 1 || control.getClientRects().length === 0) return false;
    const currentWindow = control.ownerDocument?.defaultView;
    const style = currentWindow?.getComputedStyle?.(control);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse');
  };
  const documents = [];
  const seen = new Set();
  const visit = (currentWindow) => {
    try {
      if (!currentWindow.document || seen.has(currentWindow.document)) return;
      seen.add(currentWindow.document);
      documents.push(currentWindow.document);
      for (const child of Array.from(currentWindow.frames || [])) visit(child);
    } catch {
      // Ignore a cross-origin frame.
    }
  };
  visit(window);
  const candidates = documents.flatMap((currentDocument) =>
    Array.from(currentDocument.querySelectorAll('a, button, [role="menuitem"], [onclick]')))
    .map((control) => {
      const label = textOf(control);
      return { control, label, score: labelScore(label) };
    })
    .filter(({ control, label, score }) => label && score > 0 && !dangerous.test(label)
      && isVisible(control) && !control.disabled && control.getAttribute('aria-disabled') !== 'true')
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  if (!candidates.length) return { clicked: false, url: location.href };
  candidates[0].control.click();
  return { clicked: true, label: candidates[0].label, url: location.href };
}

function detectCoursePageInFrame() {
  const pages = [];
  const seen = new Set();
  const visit = (currentWindow) => {
    try {
      const currentDocument = currentWindow.document;
      if (!currentDocument || seen.has(currentDocument)) return;
      seen.add(currentDocument);
      const headingText = Array.from(currentDocument.querySelectorAll('h1, h2, h3, legend, .title, .panel-title, .caption'))
        .slice(0, 20)
        .map((element) => String(element.innerText || element.textContent || '').trim())
        .join(' ');
      const pathname = currentWindow.location?.pathname || '';
      const href = currentWindow.location?.href || '';
      const evidence = `${currentDocument.title || ''} ${headingText} ${pathname}`;
      const bodyText = String(currentDocument.body?.innerText || currentDocument.body?.textContent || '').trim().slice(0, 5000);
      const loginForm = Boolean(currentDocument.querySelector('input[type="password"], form[action*="login" i]'))
        && /登录|统一认证|账号|密码/.test(bodyText);
      const courseTables = Array.from(currentDocument.querySelectorAll('table')).filter((table) => {
        const lead = Array.from(table.rows || []).slice(0, 5).map((row) => String(row.innerText || row.textContent || '')).join(' ');
        return /课程编号|课程代码|课程序号/.test(lead) && /课程名称|课程名/.test(lead);
      });
      pages.push({
        isCoursePage: /PlanCourseOnlineSel/i.test(pathname) || /课程网上选课管理/.test(evidence),
        authenticatedEvidence: !loginForm && (
          /PlanCourseOnlineSel/i.test(pathname)
          || (/\/Gstudent\/DefaultN\.aspx/i.test(pathname) && /[?&]EID=[^&]+/i.test(href))
          || (/研究生在线|培养方案|课程网上选课管理/.test(`${evidence} ${bodyText}`) && bodyText.length > 80)
        ),
        loginExpired: loginForm,
        documentReady: currentDocument.readyState !== 'loading' && bodyText.length > 20,
        courseTableCount: courseTables.length,
        selectionControlCount: courseTables.reduce(
          (count, table) => count + table.querySelectorAll('input[type="checkbox"], input[type="radio"]').length,
          0,
        ),
        title: currentDocument.title || '',
        url: href,
      });
      for (const child of Array.from(currentWindow.frames || [])) visit(child);
    } catch {
      // Ignore a cross-origin frame.
    }
  };
  visit(window);
  return {
    isCoursePage: pages.some((page) => page.isCoursePage),
    authenticatedEvidence: pages.some((page) => page.authenticatedEvidence),
    loginExpired: pages.some((page) => page.loginExpired),
    documentReady: pages.some((page) => page.documentReady),
    courseTableCount: pages.reduce((total, page) => total + page.courseTableCount, 0),
    selectionControlCount: pages.reduce((total, page) => total + page.selectionControlCount, 0),
    pages,
  };
}

async function synchronizeLoginState() {
  const tabs = await chrome.tabs.query({});
  const graduateTabs = tabs.filter((tab) => tab.id && /^https:\/\/gs\.cqupt\.edu\.cn\//i.test(tab.url || ''));
  const checks = await Promise.allSettled(graduateTabs.map(async (tab) => {
    await ensureHelperInTab(tab.id);
    const results = await runInTopFrame(tab.id, detectCoursePageInFrame);
    return { tab, inspection: results[0]?.result || null };
  }));
  const authenticatedTab = checks
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .find(({ inspection }) => inspection?.authenticatedEvidence && !inspection.loginExpired);
  if (!authenticatedTab) return false;
  const stored = await chrome.storage.session.get('cquptLoginSession');
  await chrome.storage.session.set({
    cquptLoginSession: {
      ...(stored.cquptLoginSession || {}),
      pending: false,
      pendingTabId: null,
      attemptSubmitted: false,
      verificationRequired: false,
      authenticated: true,
    },
  });
  const runtime = await chrome.storage.local.get('running');
  if (!runtime.running) {
    await chrome.storage.local.set({
      latestStatus: { tone: 'ready', text: '已自动同步研究生在线登录状态。', updatedAt: Date.now() },
    });
  }
  return true;
}

function withTimeout(promise, timeoutMs, label) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = window.setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timerId));
}

async function runInAllFrames(tabId, func, args = []) {
  return withTimeout(chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func,
    args,
  }), 8000, '读取页面框架超时');
}

async function runInTopFrame(tabId, func, args = []) {
  return withTimeout(chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  }), 2500, '读取系统主页面超时');
}

async function clickSystemMenu(tabId, kind) {
  const results = await runInTopFrame(tabId, clickSystemMenuInFrame, [kind]);
  return results.map((entry) => entry.result).find((result) => result?.clicked) || null;
}

async function ensureHelperInTab(tabId) {
  try {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['course-policy.js', 'content.js'],
    }), 5000, '注入全部页面框架超时');
    return true;
  } catch {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      files: ['course-policy.js', 'content.js'],
    }), 2000, '注入系统主页面超时');
    return false;
  }
}

function shellUrlFromTabs(tabs, targetTab) {
  try {
    const source = new URL(targetTab?.url || 'https://gs.cqupt.edu.cn/Gstudent/DefaultN.aspx');
    const eid = source.searchParams.get('EID');
    const shell = new URL('/Gstudent/DefaultN.aspx', source.origin);
    if (eid) shell.searchParams.set('EID', eid);
    if (eid) return shell.href;
    const existingShell = tabs.find((tab) => /\/Gstudent\/DefaultN\.aspx/i.test(tab.url || ''));
    if (existingShell?.url) return existingShell.url;
    return shell.href;
  } catch {
    return 'https://gs.cqupt.edu.cn/Gstudent/DefaultN.aspx';
  }
}

async function navigateSystemSection(kind, { startMonitoring = false, config = DEFAULT_CONFIG } = {}) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const activeTab = tabs.find((tab) => tab.active);
  const gsTabs = tabs.filter((tab) => tab.id && /^https:\/\/gs\.cqupt\.edu\.cn\//i.test(tab.url || ''));
  const activeGsTab = gsTabs.find((tab) => tab.id === activeTab?.id);
  const shellTab = gsTabs.find((tab) => /\/Gstudent\/DefaultN\.aspx/i.test(tab.url || ''));
  const targetTab = activeGsTab || shellTab;
  if (!targetTab?.id) throw new Error('当前窗口没有已登录的研究生在线页面');

  const pendingStatus = {
    tone: 'normal',
    text: kind === 'plan' ? '正在打开培养方案…' : '正在打开课程网上选课管理…',
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({
    running: false,
    pendingStart: Boolean(startMonitoring),
    pendingStartTabId: startMonitoring ? targetTab.id : null,
    monitorTabId: startMonitoring ? targetTab.id : null,
    pendingNavigationKind: null,
    pendingNavigationTabId: null,
    reloadCount: 0,
    latestStatus: pendingStatus,
  });

  const fullyInjected = await ensureHelperInTab(targetTab.id);
  let inspection = null;
  try {
    const results = await runInTopFrame(targetTab.id, detectCoursePageInFrame);
    inspection = results[0]?.result || null;
  } catch {
    inspection = null;
  }

  if (kind === 'course' && inspection?.isCoursePage && (!startMonitoring || fullyInjected)) {
    const status = startMonitoring ? {
      tone: 'normal',
      text: `已进入选课管理；页面变化将即时检测，约每 ${config.refreshSeconds} 秒刷新。`,
      updatedAt: Date.now(),
    } : {
      tone: 'ready',
      text: '当前已经是课程网上选课管理页面。',
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({
      running: Boolean(startMonitoring),
      pendingStart: false,
      pendingStartTabId: null,
      monitorTabId: startMonitoring ? targetTab.id : null,
      pendingNavigationKind: null,
      pendingNavigationTabId: null,
      latestStatus: status,
    });
    if (targetTab.id !== activeTab?.id) await chrome.tabs.update(targetTab.id, { active: true });
    return { status, running: Boolean(startMonitoring), targetTabId: targetTab.id };
  }

  let navigation = null;
  try {
    navigation = await clickSystemMenu(targetTab.id, kind);
  } catch {
    navigation = null;
  }
  if (navigation) {
    await chrome.storage.local.set({ pendingNavigationKind: null, pendingNavigationTabId: null });
  } else if (!/\/Gstudent\/DefaultN\.aspx/i.test(targetTab.url || '')) {
    await chrome.storage.local.set({ pendingNavigationKind: kind, pendingNavigationTabId: targetTab.id });
    await chrome.tabs.update(targetTab.id, { url: shellUrlFromTabs(tabs, targetTab) });
  } else {
    await chrome.storage.local.set({ pendingNavigationKind: kind, pendingNavigationTabId: targetTab.id });
  }

  if (targetTab.id !== activeTab?.id) await chrome.tabs.update(targetTab.id, { active: true });
  const status = {
    tone: 'normal',
    text: navigation
      ? `${kind === 'plan' ? '培养方案' : '课程网上选课管理'}正在加载…`
      : `已返回研究生在线主界面，正在等待“${kind === 'plan' ? '培养方案' : '课程网上选课管理'}”菜单…`,
    updatedAt: Date.now(),
  };
  if (startMonitoring) {
    const runtimeState = await chrome.storage.local.get(['running', 'latestStatus']);
    if (runtimeState.running) {
      return {
        status: runtimeState.latestStatus || status,
        running: true,
        targetTabId: targetTab.id,
      };
    }
  }
  await chrome.storage.local.set({ latestStatus: status });
  return { status, running: false, targetTabId: targetTab.id };
}

elements.planGuide.addEventListener('click', async () => {
  elements.planGuide.disabled = true;
  const originalLabel = elements.planGuide.textContent;
  elements.planGuide.textContent = '正在打开…';
  if (!(await activeTabIsSupported())) {
    renderStatus({ tone: 'warn', text: '请先打开重庆邮电大学研究生管理系统。' }, false);
    elements.planGuide.disabled = false;
    elements.planGuide.textContent = originalLabel;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.storage.local.set({ running: false, reloadCount: 0, wizardActive: false });
    const frameResults = await runInAllFrames(tab.id, collectPlanCoursesInFrame);
    const reports = frameResults.map((entry) => entry.result).filter(Boolean);
    elements.diagnosticOutput.textContent = reports.map((report, index) => [
      `框架 ${index + 1}: ${report.title || '(无标题)'}`,
      `地址: ${report.url}`,
      `培养方案页面: ${report.pageLooksPlan ? '是' : '否'}`,
      `课程表: ${report.courseTableCount}，选择控件表: ${report.selectionControlCount}`,
      `可见编号: ${report.visibleCodes.length}，已选编号: ${report.selectedCodes.length}`,
      `最低学分要求: ${Object.entries(report.requirements || {}).map(([name, value]) => `${name}=${value}`).join('，') || '未识别'}`,
    ].join('\n')).join('\n\n') || '未获得任何可读取框架。';
    const planReports = reports.filter((report) => report.pageLooksPlan && !report.pageLooksCourse && report.courseTableCount > 0);
    const selectedCodes = [...new Set(planReports.flatMap((report) => report.selectedCodes))];
    const finalizedCodes = [...new Set(planReports
      .filter((report) => report.selectionControlCount === 0)
      .flatMap((report) => report.visibleCodes))];
    const rawCodes = selectedCodes.length ? selectedCodes : finalizedCodes;

    if (!rawCodes.length) {
      const diagnostic = reports.reduce((total, report) => total + Number(report.courseTableCount || 0), 0);
      await navigateSystemSection('plan');
      const status = {
        tone: 'normal',
        text: `正在打开培养方案（当前识别到 ${diagnostic} 个课程表）。请勾选课程后再次点击导入。`,
      };
      status.updatedAt = Date.now();
      await chrome.storage.local.set({ latestStatus: status });
      renderStatus(status, false);
      elements.planGuide.disabled = false;
      elements.planGuide.textContent = originalLabel;
      return;
    }

    const courseDetails = planReports.flatMap((report) => report.courses || []);
    const filtered = COURSE_POLICY?.filterCourseCodes(rawCodes, courseDetails)
      || { includedCodes: rawCodes, excluded: [] };
    const codes = filtered.includedCodes;
    renderAutoAssignedNotice(filtered.excluded);
    const currentConfig = readConfig();
    currentConfig.targetsText = codes.join('\n');
    currentConfig.classPreferences = normalizeClassPreferences(classPreferences, codes);
    classPreferences = currentConfig.classPreferences;
    elements.targets.value = currentConfig.targetsText;
    const creditSummary = buildCreditSummary(planReports, rawCodes);
    await chrome.storage.local.set({
      config: currentConfig,
      creditSummary,
      autoAssignedExclusions,
      running: false,
      reloadCount: 0,
    });
    renderPreferenceEditor(codes);
    renderCreditComparison(creditSummary);
    const status = {
      tone: 'ready',
      text: filtered.excluded.length
        ? `已加入 ${codes.length} 门目标，跳过 ${filtered.excluded.length} 门学校统一分班课程。`
        : `已导入 ${codes.length} 门课程。`,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ latestStatus: status });
    renderStatus(status, false);
    elements.planGuide.textContent = `已加入 ${codes.length} 门`;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CQUPT_SHOW_IMPORT_SUCCESS',
        codes,
        creditSummary,
        excludedCourses: filtered.excluded,
      });
      showImportSuccess(codes, creditSummary, filtered.excluded);
    } catch {
      showImportSuccess(codes, creditSummary, filtered.excluded);
    }
  } catch (error) {
    elements.diagnosticOutput.textContent = `错误：${String(error?.stack || error?.message || error)}`;
    await chrome.storage.local.set({ wizardActive: false });
    renderStatus({
      tone: 'error',
      text: `读取失败：${String(error?.message || error)}`,
      updatedAt: Date.now(),
    }, false);
    elements.planGuide.disabled = false;
    elements.planGuide.textContent = originalLabel;
  }
});

async function handleQuickNavigation(kind, button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在打开…';
  try {
    const result = await navigateSystemSection(kind);
    renderStatus(result.status, false);
  } catch (error) {
    renderStatus({ tone: 'error', text: `导航失败：${String(error?.message || error)}` }, false);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

elements.openPlan.addEventListener('click', () => handleQuickNavigation('plan', elements.openPlan));
elements.goCourse.addEventListener('click', () => handleQuickNavigation('course', elements.goCourse));
elements.toggleLoginPassword.addEventListener('click', () => {
  const visible = elements.loginPassword.type === 'password';
  setPasswordVisibility(visible);
  elements.loginPassword.focus({ preventScroll: true });
});
elements.targets.addEventListener('input', () => {
  renderAutoAssignedNotice([]);
  renderCreditComparison(null);
  renderPreferenceEditor();
  chrome.storage.local.remove('creditSummary').catch(() => {});
});
elements.oneClickLogin.addEventListener('click', async () => {
  elements.oneClickLogin.disabled = true;
  elements.oneClickLogin.textContent = '正在登录…';
  let loginStarted = false;
  try {
    loginStarted = await beginOneClickLogin();
  } catch (error) {
    renderStatus({ tone: 'error', text: `登录启动失败：${String(error?.message || error)}` }, false);
  } finally {
    // Validation failures keep the popup open, so the button must immediately
    // return to its normal state. A successful start closes this popup.
    if (!loginStarted) {
      elements.oneClickLogin.disabled = false;
      elements.oneClickLogin.textContent = '一键登录研究生在线';
    }
  }
});
elements.logout.addEventListener('click', async () => {
  elements.logout.disabled = true;
  elements.logout.textContent = '正在退出…';
  try {
    await beginLogout();
  } catch (error) {
    renderStatus({ tone: 'error', text: `退出失败：${String(error?.message || error)}` }, false);
  } finally {
    elements.logout.disabled = false;
    elements.logout.textContent = '退出登录';
  }
});
elements.dismissImportSuccess.addEventListener('click', () => {
  guideToPreferences();
});

async function startListening() {
  const config = await saveConfig(false);
  if (!config) return false;
  if (!parseCourseCodes(config.targetsText).codes.length) {
    renderStatus({ tone: 'warn', text: '请至少填写一个准确课程编号。' }, false);
    return false;
  }
  if (!(await activeTabIsSupported())) {
    renderStatus({ tone: 'warn', text: '请先切换到研究生管理系统的选课页面。' }, false);
    return false;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  await ensureHelperInTab(tab.id);
  const results = await runInTopFrame(tab.id, detectCoursePageInFrame);
  const inspection = results[0]?.result || null;
  if (!inspection?.isCoursePage) {
    const status = {
      tone: 'warn',
      text: '当前还不是“课程网上选课管理”页面。请先点击左侧“去选课”，页面打开后再开始监听。',
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({
      running: false,
      pendingStart: false,
      pendingStartTabId: null,
      monitorTabId: null,
      latestStatus: status,
    });
    renderStatus(status, false);
    return false;
  }
  if (inspection.loginExpired || !inspection.authenticatedEvidence) {
    const session = await chrome.storage.session.get('cquptLoginSession');
    await chrome.storage.session.set({
      cquptLoginSession: { ...(session.cquptLoginSession || {}), authenticated: false, pending: false },
    });
    const status = { tone: 'error', text: '监听体检未通过：研究生在线登录状态已失效，请重新登录。', updatedAt: Date.now() };
    await chrome.storage.local.set({ running: false, monitorTabId: null, latestStatus: status });
    renderAuthGate(false);
    renderStatus(status, false);
    return false;
  }
  if (!inspection.documentReady) {
    const status = { tone: 'warn', text: '监听体检未通过：选课页面仍在加载或暂时白屏，请稍后重试。', updatedAt: Date.now() };
    await chrome.storage.local.set({ running: false, monitorTabId: null, latestStatus: status });
    renderStatus(status, false);
    return false;
  }

  const status = {
    tone: 'normal',
    text: inspection.courseTableCount
      ? `体检通过：已识别 ${inspection.courseTableCount} 个课程表、${inspection.selectionControlCount} 个选择控件；监听已启动。`
      : `体检通过：登录和选课页面正常；课程表尚未开放，将约每 ${config.refreshSeconds} 秒自动恢复检查。`,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({
    config,
    running: true,
    pendingStart: false,
    pendingStartTabId: null,
    monitorTabId: tab.id,
    reloadCount: 0,
    monitorFailureCount: 0,
    monitorRecoveryCount: 0,
    lastHealthyAt: Date.now(),
    latestStatus: status,
  });
  renderStatus(status, true);
  return true;
}

async function stopListening() {
  const status = { tone: 'normal', text: '监听已停止。', updatedAt: Date.now() };
  await chrome.storage.local.set({
    running: false,
    pendingStart: false,
    pendingStartTabId: null,
    monitorTabId: null,
    monitorFailureCount: 0,
    monitorRecoveryCount: 0,
    latestStatus: status,
  });
  renderStatus(status, false);
}

elements.startListen.addEventListener('click', async () => {
  const local = await chrome.storage.local.get('running');
  elements.startListen.disabled = true;
  elements.startListen.textContent = local.running ? '正在停止…' : '正在启动…';
  try {
    if (local.running) await stopListening();
    else await startListening();
  } catch (error) {
    const status = { tone: 'error', text: `监听操作失败：${String(error?.message || error)}`, updatedAt: Date.now() };
    await chrome.storage.local.set({ running: false, monitorTabId: null, latestStatus: status });
    renderStatus(status, false);
  } finally {
    const state = await chrome.storage.local.get(['running', 'latestStatus']);
    renderStatus(state.latestStatus, state.running);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    chrome.storage.local.get(['running', 'latestStatus']).then((local) => {
      renderStatus(local.latestStatus, local.running);
    });
    if (changes.creditSummary) renderCreditComparison(changes.creditSummary.newValue);
    if (changes.autoAssignedExclusions) renderAutoAssignedNotice(changes.autoAssignedExclusions.newValue);
  }
  if (areaName === 'session' && changes.cquptLoginSession) {
    renderAuthGate(Boolean(changes.cquptLoginSession.newValue?.authenticated));
  }
});

initialize();
