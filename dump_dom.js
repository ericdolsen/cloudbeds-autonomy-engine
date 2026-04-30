const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log("Connecting to running browser on port 9222...");
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  let page = pages.find(p => p.url().includes('us2.cloudbeds.com'));
  if (!page) {
    console.log("Could not find cloudbeds page, using first page");
    page = pages[0];
  }
  
  console.log("Using page with URL:", page.url());
  
  console.log("Waiting for network idle...");
  await page.waitForLoadState('networkidle').catch(() => {});
  
  console.log("Dumping DOM...");
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  
  const outPath = path.join(__dirname, 'cloudbeds_dom_dump.html');
  fs.writeFileSync(outPath, html);
  console.log("Saved DOM to", outPath);
  
  // also grab a snapshot of all frames
  const frames = page.frames();
  let frameLog = "";
  for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      frameLog += `Frame ${i}: Name: ${f.name()}, URL: ${f.url()}\n`;
      try {
        const fHtml = await f.evaluate(() => document.documentElement.outerHTML);
        fs.writeFileSync(path.join(__dirname, `cloudbeds_frame_${i}.html`), fHtml);
      } catch (e) {
        frameLog += `  Failed to get HTML for frame ${i}: ${e.message}\n`;
      }
  }
  fs.writeFileSync(path.join(__dirname, 'cloudbeds_frames.txt'), frameLog);
  console.log("Saved frame list and frame HTMLs.");

  // IMPORTANT: We do not close the browser here, just disconnect
  await browser.close(); 
})();
