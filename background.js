'use strict';

const DEFAULT_CONFIG = {
  targetsText: '',
  autoRefresh: true,
  refreshSeconds: 15,
};

const LOGIN_SESSION_KEY = 'cquptLoginSession';

async function readLoginSession() {
  const stored = await chrome.storage.session.get(LOGIN_SESSION_KEY);
  return stored[LOGIN_SESSION_KEY] || null;
}

async function updateLoginSession(patch) {
  const current = await readLoginSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  await chrome.storage.session.set({ [LOGIN_SESSION_KEY]: next });
  return next;
}

async function setLoginStatus(tone, text) {
  await chrome.storage.local.set({ latestStatus: { tone, text, updatedAt: Date.now() } });
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('config');
  if (!stored.config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  else if (Object.prototype.hasOwnProperty.call(stored.config, 'parallelTest')) {
    const cleanedConfig = { ...stored.config };
    delete cleanedConfig.parallelTest;
    await chrome.storage.local.set({ config: cleanedConfig });
  }
  await chrome.storage.local.remove('parallelTestStats');
  await chrome.storage.local.set({
    running: false,
    pendingStart: false,
    pendingStartTabId: null,
    monitorTabId: null,
    pendingNavigationKind: null,
    pendingNavigationTabId: null,
    wizardActive: false,
    reloadCount: 0,
    monitorFailureCount: 0,
    monitorRecoveryCount: 0,
    latestStatus: {
      tone: 'normal',
      text: '扩展已安装，请打开选课页面并配置目标课程。',
      updatedAt: Date.now(),
    },
  });
  await chrome.storage.session.remove('cquptLogoutSession');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({
    running: false,
    pendingStart: false,
    pendingStartTabId: null,
    monitorTabId: null,
    pendingNavigationKind: null,
    pendingNavigationTabId: null,
    reloadCount: 0,
    monitorFailureCount: 0,
    monitorRecoveryCount: 0,
  }).catch(() => {});
  chrome.storage.session.remove('cquptLogoutSession').catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  const url = changeInfo.url || '';
  if (!/^https:\/\/ids\.cqupt\.edu\.cn\/authserver\/login/i.test(url)) return;
  readLoginSession().then((session) => {
    if (!session?.authenticated || session.pending) return;
    return chrome.storage.session.set({
      [LOGIN_SESSION_KEY]: {
        ...session,
        authenticated: false,
        pending: false,
        pendingTabId: null,
      },
    });
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'CQUPT_GET_LOGIN_CREDENTIALS') {
    (async () => {
      const session = await readLoginSession();
      const senderUrl = sender.tab?.url || sender.url || '';
      const authorized = session?.pending && session.pendingTabId === sender.tab?.id
        && /^https:\/\/ids\.cqupt\.edu\.cn\/authserver\/login/i.test(senderUrl);
      if (!authorized) {
        sendResponse({ ok: false });
        return;
      }
      if (session.attemptSubmitted && !session.verificationRequired) {
        await setLoginStatus('warn', '自动登录未成功，已停止重复尝试。请检查统一认证页面提示后重新点击“一键登录”。');
        sendResponse({ ok: false, reason: 'already_attempted' });
        return;
      }
      sendResponse({
        ok: true,
        studentId: String(session.studentId || ''),
        password: String(session.password || ''),
        schoolRememberMe: Boolean(session.schoolRememberMe),
      });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'CQUPT_GET_LOGIN_STATE') {
    (async () => {
      const session = await readLoginSession();
      const isPortal = /^https:\/\/i\.cqupt\.edu\.cn\//i.test(sender.tab?.url || sender.url || '');
      const active = Boolean(session?.pending && isPortal);
      if (active && session.pendingTabId !== sender.tab?.id) {
        await updateLoginSession({ pendingTabId: sender.tab?.id });
      }
      sendResponse({ ok: active });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'CQUPT_LOGIN_STATUS') {
    (async () => {
      const session = await readLoginSession();
      if (!session?.pending || session.pendingTabId !== sender.tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      const code = String(message.code || '');
      if (code === 'submitted') {
        await updateLoginSession({ attemptSubmitted: true, verificationRequired: false });
        await setLoginStatus('normal', '统一认证信息已提交，正在等待登录结果…');
      } else if (code === 'verification_required') {
        await updateLoginSession({ attemptSubmitted: false, verificationRequired: true });
        await setLoginStatus('warn', '学校要求验证码或安全验证。账号和密码已填写，请在页面手动完成验证并登录。');
      } else if (code === 'waiting_password') {
        await setLoginStatus('warn', '未取得密码。请使用 Edge 密码管理器自动填充，或重新打开扩展输入密码。');
      } else if (code === 'login_failed') {
        await updateLoginSession({ attemptSubmitted: true, verificationRequired: false, authenticated: false });
        await setLoginStatus('error', '统一认证未登录成功。请检查学号、密码或登录页错误提示，然后重新点击“一键登录”。');
      } else if (code === 'portal_locating') {
        await setLoginStatus('normal', '统一认证成功，正在门户中查找“研究生在线”…');
      } else if (code === 'portal_opening') {
        await setLoginStatus('normal', '正在打开研究生在线…');
      } else if (code === 'portal_not_found') {
        await setLoginStatus('warn', '已进入学校门户，但未自动找到“研究生在线”入口。请在门户中手动点击一次。');
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'CQUPT_LOGIN_REACHED_GS') {
    (async () => {
      const session = await readLoginSession();
      const isGraduateHost = /^https:\/\/gs\.cqupt\.edu\.cn\//i.test(sender.tab?.url || '');
      if (!isGraduateHost || (!session?.pending && !message.authenticatedEvidence)) return;
      await chrome.storage.session.set({ [LOGIN_SESSION_KEY]: {
        ...(session || {}),
        pending: false,
        pendingTabId: null,
        attemptSubmitted: false,
        verificationRequired: false,
        authenticated: true,
      } });
      await setLoginStatus('ready', '登录成功，已进入研究生在线。');
    })().catch(() => {});
    return;
  }

  if (message.type === 'CQUPT_LOGIN_EXPIRED') {
    (async () => {
      const session = await readLoginSession();
      await chrome.storage.session.set({ [LOGIN_SESSION_KEY]: {
        ...(session || {}),
        pending: false,
        pendingTabId: null,
        authenticated: false,
      } });
      await setLoginStatus('error', '研究生在线登录状态已失效，请重新登录。');
    })().catch(() => {});
    return;
  }

  if (message.type === 'CQUPT_GET_TAB_CONTEXT') {
    sendResponse({ tabId: sender.tab?.id ?? null, frameId: sender.frameId ?? 0 });
    return;
  }

  if (message.type === 'CQUPT_STATUS') {
    const payload = {
      tone: String(message.payload?.tone || 'normal'),
      text: String(message.payload?.text || ''),
      pageUrl: String(sender.frameId === 0 ? sender.tab?.url || '' : ''),
      updatedAt: Date.now(),
    };
    chrome.storage.local.set({ latestStatus: payload });

    if (payload.tone === 'ready' && sender.tab?.id) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: '!' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#16a34a' }).catch(() => {});
    } else if (sender.tab?.id) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' }).catch(() => {});
    }
  }

  if (message.type === 'CQUPT_NOTIFY') {
    const course = String(message.course || '目标课程');
    chrome.notifications.create(`cqupt-course-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: '发现目标课程',
      message: `${course} 已出现可操作班级入口，请回到页面核对并手动确认。`,
      priority: 2,
    }).catch(() => {});
  }

  if (message.type === 'CQUPT_CLEAR_BADGE' && sender.tab?.id) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' }).catch(() => {});
  }
});
