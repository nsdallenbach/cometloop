import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Tests ───────────────────────────────────────────────────────────────────

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

// Engagements are live user data (created/deleted in the app), so tests
// discover the current portfolio via the API instead of assuming seed rows.
async function firstEngagement(request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> }) {
  const rows = (await (await request.get('/api/engagements')).json()) as { id: string; name: string }[];
  return rows[0] ?? null;
}

test('smoke test - portfolio loads', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('COMETLOOP', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page.getByText('ACTIVE ·', { exact: false })).toBeVisible();
});

test('smoke test - workspace board loads with tickets', async ({ page, request }) => {
  const eng = await firstEngagement(request);
  test.skip(!eng, 'no engagements in database');

  await page.goto('/');
  await page.getByText(eng!.name).first().click();

  // Engagement header + tabs
  await expect(page.getByRole('heading', { name: eng!.name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Roadmap' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Status Feed' })).toBeVisible();

  // Kanban columns
  await expect(page.getByText('BACKLOG', { exact: true })).toBeVisible();
  await expect(page.getByText('IN PROGRESS', { exact: true })).toBeVisible();
});

test('smoke test - roadmap tab renders', async ({ page, request }) => {
  const eng = await firstEngagement(request);
  test.skip(!eng, 'no engagements in database');

  await page.goto('/');
  await page.getByText(eng!.name).first().click();
  await page.getByRole('button', { name: 'Roadmap' }).click();

  await expect(page.getByText('DERIVED FROM SOW', { exact: false })).toBeVisible();
});

test('smoke test - settings page shows staffing matrix', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'SETTINGS' }).click();

  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByText('TEAM ASSIGNMENT', { exact: false })).toBeVisible();
  await expect(page.getByText('ADD TEAM MEMBER')).toBeVisible();

  // Team members are live data — assert on whatever the API currently returns
  // rather than a seeded name.
  const admin = (await (await request.get('/api/admin')).json()) as { members: { name: string }[] };
  if (admin.members.length > 0) {
    await expect(page.getByText(admin.members[0].name).first()).toBeVisible();
  }
});

test('smoke test - /projects deep link renders portfolio', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
});

test('smoke test - project detail deep link renders board', async ({ page, request }) => {
  const eng = await firstEngagement(request);
  test.skip(!eng, 'no engagements in database');

  await page.goto(`/projects/${eng!.id}`);
  await expect(page.getByRole('heading', { name: eng!.name })).toBeVisible();
  await expect(page.getByText('BACKLOG', { exact: true })).toBeVisible();
});

test('smoke test - project tickets tab and ticket deep link render', async ({ page, request }) => {
  const eng = await firstEngagement(request);
  test.skip(!eng, 'no engagements in database');

  await page.goto(`/projects/${eng!.id}/tickets`);
  await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();

  const tickets = (await (await request.get('/api/tickets')).json()) as { key: string }[];
  test.skip(tickets.length === 0, 'no tickets in database');

  await page.goto(`/tickets/${tickets[0].key}`);
  await expect(page.getByText(tickets[0].key).first()).toBeVisible();
});

test('smoke test - browser back returns from project to portfolio', async ({ page, request }) => {
  const eng = await firstEngagement(request);
  test.skip(!eng, 'no engagements in database');

  await page.goto('/projects');
  await page.getByText(eng!.name).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${eng!.id}$`));

  await page.goBack();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
});

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  // Create temp directory for test artifacts
  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  // Capture console logs and errors (including React errors)
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();

    // Skip empty lines and formatting placeholders
    if (!text.trim() || /^%[osd]$/.test(text.trim())) {
      return;
    }

    // Get stack trace for errors if available
    const location = msg.location();
    const locationStr = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';

    consoleLogs.push(`[${type}] ${text}${locationStr}`);

    // Separately track error messages (React errors appear here)
    if (type === 'error') {
      consoleErrors.push(`${text}${locationStr}`);
    }
  });

  // Capture page errors with full stack trace
  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    // Also log to console for immediate visibility
    console.error('Page error detected:', errorDetails);
  });

  // Capture failed requests
  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  // Always capture artifacts, even if test fails
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors);
  }
  if (pageErrors.length > 0) {
    console.log('Page errors detected:', pageErrors);
  }
  if (failedRequests.length > 0) {
    console.log('Failed requests detected:', failedRequests);
  }

  await page.close();
});
