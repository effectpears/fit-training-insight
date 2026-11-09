import { test, expect, type Page } from '@playwright/test';

/**
 * Optional checks against real FIT recordings.
 *
 * The repository intentionally contains no FIT files. To run these scenarios,
 * point the environment variables at local recordings with the matching
 * characteristics. Unset scenarios are skipped.
 */
const SAMPLES = {
  flatRide: process.env.FIT_SAMPLE_FLAT_RIDE,
  tempoBlock: process.env.FIT_SAMPLE_TEMPO_BLOCK,
  longBlocks: process.env.FIT_SAMPLE_LONG_BLOCKS,
  shortSets: process.env.FIT_SAMPLE_SHORT_SETS,
  overUnders: process.env.FIT_SAMPLE_OVER_UNDERS,
  sixtySixty: process.env.FIT_SAMPLE_60_60,
};

async function loadFit(page: Page, filePath: string) {
  const fileInput = page.locator('input#file-input');
  await fileInput.setInputFiles(filePath);
  await page.waitForTimeout(600);
}

async function expectIntervalCount(page: Page, count: number) {
  const rows = page.locator('table tbody tr:has(.set-chip)');
  await expect(rows).toHaveCount(count);
}

async function expectSetCount(page: Page, count: number) {
  const sets = page.locator('.set-card');
  await expect(sets).toHaveCount(count);
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

test.describe('sample detection scenarios', () => {
  for (const [label, path] of [
    ['flat ride produces no intervals', SAMPLES.flatRide],
    ['tempo block', SAMPLES.tempoBlock],
    ['long blocks', SAMPLES.longBlocks],
    ['short sets', SAMPLES.shortSets],
    ['over-unders', SAMPLES.overUnders],
    ['60/60 intervals', SAMPLES.sixtySixty],
  ] as const) {
    test(label, async ({ page }) => {
      if (!path) {
        test.skip(true, 'sample recording not configured');
        return;
      }
      const errors = collectConsoleErrors(page);
      await page.goto('/');
      await loadFit(page, path);
      expect(errors.join('\n')).toBe('');
    });
  }
});

test('tempo block yields 1 interval', async ({ page }) => {
  test.skip(!SAMPLES.tempoBlock, 'FIT_SAMPLE_TEMPO_BLOCK not configured');
  if (!SAMPLES.tempoBlock) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.tempoBlock);
  expect(errors.join('\n')).toBe('');
  await expectIntervalCount(page, 1);
});

test('flat ride yields 0 intervals', async ({ page }) => {
  test.skip(!SAMPLES.flatRide, 'FIT_SAMPLE_FLAT_RIDE not configured');
  if (!SAMPLES.flatRide) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.flatRide);
  expect(errors.join('\n')).toBe('');
  await expectIntervalCount(page, 0);
});

test('long blocks yield 2 sets / 30 intervals', async ({ page }) => {
  test.skip(!SAMPLES.longBlocks, 'FIT_SAMPLE_LONG_BLOCKS not configured');
  if (!SAMPLES.longBlocks) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.longBlocks);
  expect(errors.join('\n')).toBe('');
  await expectSetCount(page, 2);
  await expectIntervalCount(page, 30);
});

test('short sets yield 3 sets / 3 intervals', async ({ page }) => {
  test.skip(!SAMPLES.shortSets, 'FIT_SAMPLE_SHORT_SETS not configured');
  if (!SAMPLES.shortSets) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.shortSets);
  expect(errors.join('\n')).toBe('');
  await expectSetCount(page, 3);
  await expectIntervalCount(page, 3);
});

test('demo yields 3 sets / 13 intervals', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await page.click('button#demo-btn');
  await page.waitForTimeout(600);
  expect(errors.join('\n')).toBe('');
  await expectSetCount(page, 3);
  await expectIntervalCount(page, 13);
});

test('over-unders yield 1 set / 6 reps (11 intervals)', async ({ page }) => {
  test.skip(!SAMPLES.overUnders, 'FIT_SAMPLE_OVER_UNDERS not configured');
  if (!SAMPLES.overUnders) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.overUnders);
  expect(errors.join('\n')).toBe('');
  await expectSetCount(page, 1);
  await expectIntervalCount(page, 11);
  await expect(page.locator('.set-kind-badge')).toContainText('Over-Under');
});

test('60/60 yields 1 set / 10 intervals', async ({ page }) => {
  test.skip(!SAMPLES.sixtySixty, 'FIT_SAMPLE_60_60 not configured');
  if (!SAMPLES.sixtySixty) return;
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await loadFit(page, SAMPLES.sixtySixty);
  expect(errors.join('\n')).toBe('');
  await expectSetCount(page, 1);
  await expectIntervalCount(page, 10);
});

test('PNG export produces a file', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await page.click('button#demo-btn');
  await page.waitForTimeout(600);
  expect(errors.join('\n')).toBe('');
  const downloadPromise = page.waitForEvent('download');
  await page.click('button#export-btn');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
});

test('mobile viewport renders without layout breakage', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 390 });
  await page.goto('/');
  await page.click('button#demo-btn');
  await page.waitForTimeout(600);
  expect(errors.join('\n')).toBe('');
  await expect(page.locator('.dashboard')).toBeVisible();
});
