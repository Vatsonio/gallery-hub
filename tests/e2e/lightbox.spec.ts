import { test, expect } from "@playwright/test";
import { loadFixture } from "./_fixture";

const fx = loadFixture();
const TOKEN = fx.token;
const PHOTO0 = fx.photoIds[0];
const PHOTO1 = fx.photoIds[1];

test.describe("lightbox keyboard navigation", () => {
  test("arrow-right advances, Escape closes back to the album", async ({
    page,
  }) => {
    await page.goto(`/a/${TOKEN}/p/${PHOTO0}`);

    // The hero image renders inside the lightbox.
    await expect(page.locator("img").first()).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await page.waitForURL(`**/a/${TOKEN}/p/${PHOTO1}`, { timeout: 5000 });

    await page.keyboard.press("Escape");
    await page.waitForURL(new RegExp(`/a/${TOKEN}/?$`), { timeout: 5000 });
  });

  test("the F key toggles the like state in the lightbox", async ({ page }) => {
    await page.goto(`/a/${TOKEN}/p/${PHOTO0}`);
    // Wait for the lightbox like button (aria-pressed on the heart toggle).
    const heart = page.locator('button[aria-pressed]').first();
    await heart.waitFor();
    const before = await heart.getAttribute("aria-pressed");

    await page.keyboard.press("f");
    // Optimistic UI flips synchronously.
    await expect
      .poll(async () => heart.getAttribute("aria-pressed"))
      .not.toBe(before);
  });
});
