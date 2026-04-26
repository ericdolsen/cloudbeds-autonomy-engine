const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://hotels.cloudbeds.com/login', {waitUntil:'networkidle'});
    await page.fill('input[name="email"]', 'ericdolsen@gmail.com');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
    const html = await page.content();
    console.log("Password field:", html.includes('name="password"'));
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => i.name));
    console.log("All input names after submit:", inputs);
    await browser.close();
})();
