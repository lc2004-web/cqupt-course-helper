'use strict';

(() => {
  if (window.top !== window) return;

  const visible = (element) => {
    if (!element || element.nodeType !== 1 || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  };

  const waitFor = async (selector, timeoutMs = 5000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = Array.from(document.querySelectorAll(selector)).find(visible);
      if (element) return element;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  };

  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const sendStatus = (code) => chrome.runtime.sendMessage({ type: 'CQUPT_LOGIN_STATUS', code }).catch(() => {});

  (async () => {
    const credentials = await chrome.runtime.sendMessage({ type: 'CQUPT_GET_LOGIN_CREDENTIALS' });
    if (!credentials?.ok) return;

    const accountTab = document.querySelector('#userNameLogin_a, [data-login-type="account"]');
    const usernameAlreadyVisible = Array.from(document.querySelectorAll('#pwdFromId input[name="username"], #pwdLoginDiv input[name="username"]')).some(visible);
    const accountMode = new URL(location.href).searchParams.get('type') === 'userNameLogin';
    if (!accountMode && !usernameAlreadyVisible && accountTab && visible(accountTab)) accountTab.click();

    const username = await waitFor('#pwdFromId input[name="username"], #pwdLoginDiv input[name="username"]');
    const password = await waitFor('#pwdFromId #password, #pwdFromId input[name="passwordText"], #pwdFromId input[type="password"]');
    const submit = await waitFor('#pwdFromId #login_submit, #pwdFromId .login-btn, #pwdFromId button[type="submit"], #pwdFromId input[type="submit"]');
    if (!username || !password || !submit) {
      await sendStatus('waiting_password');
      return;
    }

    setInputValue(username, credentials.studentId);
    if (credentials.password) setInputValue(password, credentials.password);

    const remember = document.querySelector('#pwdFromId #rememberMe, #pwdFromId #myRememberMe, #pwdFromId input[name="rememberMe"]');
    if (remember && remember.checked !== credentials.schoolRememberMe) {
      remember.checked = credentials.schoolRememberMe;
      remember.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (!password.value) {
      const startedAt = Date.now();
      while (!password.value && Date.now() - startedAt < 3500) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    }
    if (!password.value) {
      password.focus();
      await sendStatus('waiting_password');
      return;
    }

    await sendStatus('submitted');
    submit.click();

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      const sliderControl = document.querySelector('#sliderCaptchaDiv');
      const verificationVisible = Array.from(document.querySelectorAll(
        '#pwdFromId #captchaDiv, #pwdFromId input[name="captcha"]',
      )).some(visible) || (visible(sliderControl) && sliderControl.childElementCount > 0);
      if (verificationVisible) {
        await sendStatus('verification_required');
        return;
      }
      const errorTip = document.querySelector('#formErrorTip, #showErrorTip, .form-error, .login-error');
      if (errorTip && visible(errorTip) && String(errorTip.textContent || '').trim()) {
        await sendStatus('login_failed');
        return;
      }
    }
  })().catch(() => {});
})();
