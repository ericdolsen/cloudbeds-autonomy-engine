const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://hotels.cloudbeds.com/login', {waitUntil:'networkidle'});
    console.log('initial URL:', page.url());
    await page.fill('input[name="email"]', 'ericdolsen@gmail.com');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    console.log('URL after submit:', page.url());
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => ({name: i.name, type: i.type})));
    console.log('Inputs after submit:', inputs);
    await browser.close();
})();
