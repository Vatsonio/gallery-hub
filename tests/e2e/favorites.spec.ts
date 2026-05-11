import { test, expect } from "@playwright/test";
import { loadFixture } from "./_fixture";

const fx = loadFixture();
const TOKEN = fx.token;

test.describe("favorites tab", () => {
  test("empty favorites view shows the browse CTA", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto(`/a/${TOKEN}/favorites`);
    await expect(page.getByText(/no favorites yet/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /browse album/i })).toBeVisible();
  });

  test("hearts in album appear on the favorites tab + glass dock shows", async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto(`/a/${TOKEN}`, { waitUntil: "networkidle" });
    // Scope to the desktop grid — the page renders both mobile + desktop
    // variants in the DOM with one CSS-hidden. Without scoping, each photo
    // shows up twice.
    const desktopGrid = page.locator("div.hidden.sm\\:flex").first();
    const hearts = desktopGrid.locator('button[aria-pressed]');
    await hearts.first().waitFor({ state: "attached" });
    await expect.poll(() => hearts.count()).toBeGreaterThanOrEqual(2);

    // Dispatch click events directly — overlay is absolutely positioned and
    // Playwright sometimes flags it as occluded before the lazy <img>
    // paints, even though the React onClick handler fires fine.
    await hearts.nth(0).dispatchEvent("click");
    await expect(hearts.nth(0)).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(400);
    await hearts.nth(1).dispatchEvent("click");
    await expect(hearts.nth(1)).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(400);

    // Visit the favorites tab. Two photos hearted -> two tiles -> two heart
    // toggles in the desktop grid.
    await page.goto(`/a/${TOKEN}/favorites`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /favorites/i })).toBeVisible();
    const favDesktopGrid = page.locator("div.hidden.sm\\:flex").first();
    const favHearts = favDesktopGrid.locator('button[aria-pressed]');
    await expect(favHearts).toHaveCount(2);
    await expect(favHearts.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(favHearts.nth(1)).toHaveAttribute("aria-pressed", "true");

    // The export-favorites glass dock is visible when favorites > 0.
    await expect(
      page.getByRole("button", { name: /export favorites/i }),
    ).toBeVisible();
  });

  test("glass dock is hidden when no favorites exist", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto(`/a/${TOKEN}`);
    await expect(
      page.getByRole("heading", { name: "E2E Demo Album" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /export favorites/i }),
    ).toHaveCount(0);
  });
});
