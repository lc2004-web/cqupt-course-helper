'use strict';

const fs = require('fs');
const path = require('path');

const catalog = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'course-schedule-2026-2027.json'),
  'utf8',
));

if (catalog.courseCount !== 219) throw new Error(`expected 219 courses, got ${catalog.courseCount}`);
if (catalog.classCount !== 302) throw new Error(`expected 302 classes, got ${catalog.classCount}`);
if (Object.keys(catalog.courses).length !== catalog.courseCount) throw new Error('course count mismatch');

const ids = new Set();
let classCount = 0;
for (const [code, course] of Object.entries(catalog.courses)) {
  if (!/^[A-Z0-9][A-Z0-9_-]{2,30}$/.test(code)) throw new Error(`invalid course code ${code}`);
  if (!course.name || !Array.isArray(course.classes) || !course.classes.length) {
    throw new Error(`invalid course entry ${code}`);
  }
  for (const item of course.classes) {
    classCount += 1;
    if (!item.id || ids.has(item.id)) throw new Error(`duplicate class id ${item.id}`);
    ids.add(item.id);
  }
}
if (classCount !== catalog.classCount) throw new Error('class count mismatch');

const communicationTheory = catalog.courses.M0130005;
if (communicationTheory.classes.length !== 2) throw new Error('M0130005 should contain two classes');
if (!communicationTheory.classes.some((item) => item.teachers.includes('鲜永菊'))) {
  throw new Error('M0130005 teacher data is missing');
}
if (!catalog.courses['10231304']) throw new Error('numeric course codes should be supported');

console.log('PASS: schedule catalog structure, counts, and representative courses');
