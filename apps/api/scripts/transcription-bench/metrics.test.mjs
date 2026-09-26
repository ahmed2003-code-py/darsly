// node --test scripts/transcription-bench/metrics.test.mjs  (no network, no cost)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAll, normalizeArabic, toAsciiDigits } from './metrics.mjs';

test('normalisation folds Arabic letter forms, diacritics and digits', () => {
  assert.equal(normalizeArabic('إِنَّ المدرسةَ'), 'ان المدرسه');
  assert.equal(toAsciiDigits('٣ و ٤٥'), '3 و 45');
});

test('a perfect transcript scores perfectly', () => {
  const ref = 'النهارده هنشرح الـ derivative بتاع الـ function، يعني 3 أمثلة.';
  const s = scoreAll(ref, ref);
  assert.equal(s.wer, 0);
  assert.equal(s.cer, 0);
  assert.equal(s.englishTermRecall, 1);
  assert.equal(s.numberRecall, 1);
  assert.equal(s.punctuationRatio, 1);
});

test('English terms and numbers are scored on their own', () => {
  const ref = 'هنشرح الـ derivative للـ function في 3 أمثلة';
  // English term transliterated into Arabic, digit written as a word.
  const hyp = 'هنشرح الديريفاتيف للـ function في تلات أمثلة';
  const s = scoreAll(ref, hyp);
  assert.equal(s.englishTermRecall, 0.5);
  assert.equal(s.numberRecall, 0);
  assert.ok(s.wer > 0);
});

test('Arabic-Indic digits in the output count as the same number', () => {
  const s = scoreAll('المسألة رقم 12', 'المسألة رقم ١٢');
  assert.equal(s.numberRecall, 1);
  assert.equal(s.wer, 0);
});

test('Egyptian dialect is scored as dialect: "corrected" to MSA is a miss', () => {
  const ref = 'دلوقتي هنشوف ازاي الـ function بتشتغل عشان كده';
  assert.equal(scoreAll(ref, ref).dialectRecall, 1);
  const msa = scoreAll(ref, 'الآن سنرى كيف تعمل الـ function لذلك');
  assert.ok(msa.dialectRecall < 0.3, String(msa.dialectRecall));
  // No dialect in the reference: not scored.
  assert.equal(scoreAll('الدالة تعمل', 'الدالة تعمل').dialectRecall, null);
});
