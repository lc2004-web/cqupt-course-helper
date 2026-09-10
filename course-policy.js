'use strict';

(() => {
  const MAIN_CAMPUS_MASTER_AUTO_ASSIGNED = Object.freeze([
    Object.freeze({ code: 'M1410001', name: '通用学术英语' }),
    Object.freeze({ code: 'M1410002', name: 'ICT学术英语' }),
    Object.freeze({ code: 'T1510001', name: '自然辩证法概论' }),
    Object.freeze({ code: 'T1510003', name: '马克思主义与社会科学方法论' }),
  ]);

  const normalizeCode = (value) => String(value ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .toUpperCase();

  const normalizeName = (value) => String(value ?? '')
    .trim()
    .replace(/[\s\u3000《》【】\[\]（）()]/g, '')
    .toUpperCase();

  const byCode = new Map(MAIN_CAMPUS_MASTER_AUTO_ASSIGNED.map((course) => [course.code, course]));
  const byName = new Map(MAIN_CAMPUS_MASTER_AUTO_ASSIGNED.map((course) => [normalizeName(course.name), course]));

  function findAutoAssignedCourse(code, name = '') {
    return byCode.get(normalizeCode(code)) || byName.get(normalizeName(name)) || null;
  }

  function filterCourseCodes(codes, courseDetails = []) {
    const detailsByCode = new Map(courseDetails.map((course) => [normalizeCode(course?.code), course]));
    const includedCodes = [];
    const excluded = [];
    const seenIncluded = new Set();
    const seenExcluded = new Set();

    for (const rawCode of codes || []) {
      const code = normalizeCode(rawCode);
      if (!code) continue;
      const detail = detailsByCode.get(code) || {};
      const policyCourse = findAutoAssignedCourse(code, detail.name);
      if (policyCourse) {
        if (!seenExcluded.has(policyCourse.code)) {
          excluded.push({ code, name: policyCourse.name });
          seenExcluded.add(policyCourse.code);
        }
      } else if (!seenIncluded.has(code)) {
        includedCodes.push(code);
        seenIncluded.add(code);
      }
    }
    return { includedCodes, excluded };
  }

  const api = Object.freeze({
    MAIN_CAMPUS_MASTER_AUTO_ASSIGNED,
    normalizeCode,
    normalizeName,
    findAutoAssignedCourse,
    filterCourseCodes,
  });

  globalThis.CQUPTCoursePolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
