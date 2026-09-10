'use strict';

const path = require('path');
const policy = require(path.resolve(__dirname, '..', 'course-policy.js'));

const expected = new Map([
  ['M1410001', '通用学术英语'],
  ['M1410002', 'ICT学术英语'],
  ['T1510001', '自然辩证法概论'],
  ['T1510003', '马克思主义与社会科学方法论'],
]);

if (policy.MAIN_CAMPUS_MASTER_AUTO_ASSIGNED.length !== expected.size) {
  throw new Error('only the four main-campus full-time master courses should be configured');
}
for (const [code, name] of expected) {
  const match = policy.findAutoAssignedCourse(code);
  if (!match || match.name !== name) throw new Error(`${code} policy entry is missing`);
}
if (policy.findAutoAssignedCourse('', '博士生学术英语')) {
  throw new Error('doctoral courses must not be filtered');
}
if (policy.findAutoAssignedCourse('', '新时代中国特色社会主义理论与实践')) {
  throw new Error('branch-campus courses must not be filtered');
}

const filtered = policy.filterCourseCodes(
  ['M1410001', 'M0130005', 'UNKNOWN001'],
  [{ code: 'UNKNOWN001', name: '《马克思主义与社会科学方法论》' }],
);
if (filtered.includedCodes.join(',') !== 'M0130005') throw new Error('selectable course filtering is incorrect');
if (filtered.excluded.length !== 2) throw new Error('code and name based exclusions should both work');

console.log('PASS: main-campus master auto-assigned course filtering');
