const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://hotels.cloudbeds.com/login', {waitUntil:'networkidle'});
    const html = await page.content();
    console.log("Email field:", html.includes('name="email"'));
    console.log("Password field:", html.includes('name="password"'));
    console.log("User Email field:", html.includes('name="user_email"'));
    console.log("User Password field:", html.includes('name="user_password"'));
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => i.name));
    console.log("All input names:", inputs);
    await browser.close();
})();
