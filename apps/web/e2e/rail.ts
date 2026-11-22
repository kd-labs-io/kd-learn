import { expect, type Page } from '@playwright/test';

/**
 * Checks who is using the app. The account menu sits at the bottom of the left rail; on a phone the
 * rail is a drawer behind the menu button, so it is opened for the check and closed again.
 */
export async function expectWho(page: Page, text: string) {
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.getByTestId('who').filter({ visible: true })).toHaveText(text);
    await page.keyboard.press('Escape');
  } else {
    await expect(page.getByTestId('who')).toHaveText(text);
  }
}
