'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');
const marker = 'function buildCreditSummary(';
const start = source.indexOf(marker);
if (start < 0) throw new Error('buildCreditSummary not found');
const brace = source.indexOf('{', start);
let depth = 0;
let end = -1;
for (let index = brace; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1;
  if (source[index] === '}') depth -= 1;
  if (depth === 0) {
    end = index + 1;
    break;
  }
}
vm.runInThisContext(source.slice(start, end));

const summary = buildCreditSummary([{
  requirements: { 公共必修: 9, 公共基础: 3, 专业基础: 3, 专业课: 5, 其他培养环节: 7 },
  courses: [
    { code: 'A001', category: '公共必修', credits: 9 },
    { code: 'A002', category: '公共基础', credits: 3 },
    { code: 'A003', category: '专业基础', credits: 2 },
    { code: 'A004', category: '专业课', credits: 5 },
    { code: 'A005', category: '其他培养环节', credits: 7 },
    { code: 'A006', category: '自选课', credits: 1 },
  ],
}], ['A001', 'A002', 'A003', 'A004', 'A005', 'A006']);

if (!summary.available || summary.allMet) throw new Error('overall result is incorrect');
const foundation = summary.items.find((item) => item.category === '专业基础');
if (!foundation || foundation.selected !== 2 || foundation.required !== 3 || foundation.missing !== 1 || foundation.met) {
  throw new Error('category comparison is incorrect');
}
if (summary.unknownCourseCodes.length) throw new Error('optional course should not be reported as unknown');
console.log('PASS: credit summary aggregation and deficit calculation');
