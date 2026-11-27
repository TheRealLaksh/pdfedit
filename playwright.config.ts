import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PDFEDIT_E2E_PORT ?? 5180);
/** set to test an already running or deployed build, for example http://localhost:4180 after `npm run preview` */
const external = process.env.PDFEDIT_E2E_URL;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "pixel7", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 14"] } },
  ],
  webServer: external
    ? undefined
    : {
        // --bypass-lock: another dev server for this project may already be running on a different port
        command: `npm run dev -- --port ${port} --bypass-lock`,
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
