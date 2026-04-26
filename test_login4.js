const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://hotels.cloudbeds.com/login', {waitUntil:'networkidle'});
    
    // Step 1: Cloudbeds Login Page
    await page.fill('input[name="email"]', 'ericdolsen@gmail.com');
    await page.click('button[type="submit"]');
    
    // Step 2: Okta Identifier Page
    await page.waitForURL('**/authorize**');
    await page.waitForTimeout(2000);
    // Click submit to proceed past the username confirmation
    await page.click('input[type="submit"]');
    
    // Step 3: Okta Password Page
    await page.waitForTimeout(4000);
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => ({name: i.name, type: i.type})));
    console.log('Inputs after Okta step 2:', inputs);
    await browser.close();
})();
