'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');
const popupSource = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');

function extractFunction(name, sourceText = source) {
  const marker = `function ${name}(`;
  const start = sourceText.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  const brace = sourceText.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < sourceText.length; index += 1) {
    if (sourceText[index] === '{') depth += 1;
    if (sourceText[index] === '}') depth -= 1;
    if (depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}

vm.runInThisContext([
  extractFunction('normalize'),
  extractFunction('navigationLabelScore'),
].join('\n'));

if (navigationLabelScore('plan', '培养方案') !== 100) throw new Error('exact plan menu should rank highest');
if (navigationLabelScore('plan', ' 培养方案选择 ') !== 100) throw new Error('spaced exact plan menu should match');
if (navigationLabelScore('plan', '培养方案选择 进入') <= 0) throw new Error('short decorated plan menu should match');
if (navigationLabelScore('plan', '关于调整培养方案的通知') !== 0) throw new Error('notification link must not match');
if (navigationLabelScore('plan', '培养方案填写说明') !== 0) throw new Error('help article must not match');
if (navigationLabelScore('course', '课程网上选课管理') !== 100) throw new Error('exact course menu should match');

const clickSystemMenuInFrame = vm.runInThisContext(`(${extractFunction('clickSystemMenuInFrame', popupSource)})`);
let clickedLabel = '';
const controls = ['关于调整培养方案的通知', '服务', '培养方案选择 进入'].map((label) => ({
  nodeType: 1,
  innerText: label,
  disabled: false,
  ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
  getClientRects: () => [1],
  getAttribute: () => null,
  click: () => { clickedLabel = label; },
}));
global.document = { querySelectorAll: () => controls };
global.window = { document: global.document, frames: [] };
global.location = { href: 'https://gs.cqupt.edu.cn/Gstudent/DefaultN.aspx?EID=test' };
const clickResult = clickSystemMenuInFrame('plan');
if (!clickResult.clicked || clickedLabel !== '培养方案选择 进入') {
  throw new Error(`popup navigation clicked the wrong control: ${clickedLabel || '(none)'}`);
}

console.log('PASS: exact system navigation labels avoid notification links');
