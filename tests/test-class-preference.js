'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}

vm.runInThisContext([
  extractFunction('normalize'),
  extractFunction('chooseRandom'),
  extractFunction('preferenceMatchScore'),
  extractFunction('choosePreferred'),
].join('\n'));

const preference = {
  classId: 'M0130005:通信网理论2',
  className: '通信网理论2',
  teachers: ['鲜永菊'],
  schedule: '星期五(9-11节)[2-17周,教师:鲜永菊,地点:第三教学楼3308]',
  location: '第三教学楼3308',
};
const preferred = { text: '通信网理论2 任课教师 鲜永菊 星期五(9-11节) 第三教学楼3308' };
const fallback = { text: '通信网理论1 任课教师 刘焕淋 星期一(9-11节) 第九教学楼9403' };

if (preferenceMatchScore(preferred.text, preference) <= preferenceMatchScore(fallback.text, preference)) {
  throw new Error('preferred class should have a higher score');
}
const result = choosePreferred([fallback, preferred], preference, (item) => item.text);
if (result.item !== preferred || !result.matched) throw new Error('preferred class was not selected');
const unavailable = choosePreferred([fallback], preference, (item) => item.text);
if (unavailable.item !== fallback || unavailable.matched) throw new Error('fallback behavior is incorrect');

console.log('PASS: preferred class scoring and fallback selection');
