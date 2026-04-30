const fs = require('fs');
const jsdom = require('jsdom');
const html = fs.readFileSync('c:/Users/erico/Desktop/Cloudbeds-Autonomy-Engine/cloudbeds_dom_dump.html', 'utf8');
const dom = new jsdom.JSDOM(html);
const doc = dom.window.document;

let output = "# Cloudbeds Reservation DOM Structure\n\n";

output += "## Tabs\n";
doc.querySelectorAll('[role="tab"]').forEach(el => {
  output += `- ${el.textContent.trim()} (ID: ${el.id}, aria-controls: ${el.getAttribute('aria-controls')})\n`;
});

output += "\n## Buttons (First 50)\n";
Array.from(doc.querySelectorAll('button, [role="button"]'))
  .filter(b => b.textContent.trim().length > 0)
  .slice(0, 50)
  .forEach(b => {
    output += `- ${b.textContent.trim().replace(/\n/g, ' ')}\n`;
  });

output += "\n## Inputs\n";
Array.from(doc.querySelectorAll('input'))
  .filter(i => i.type !== 'hidden')
  .forEach(i => {
    output += `- Type: ${i.type}, Name: ${i.name}, ID: ${i.id}, Placeholder: ${i.placeholder}\n`;
  });

fs.writeFileSync('c:/Users/erico/Desktop/Cloudbeds-Autonomy-Engine/reservation_analysis.md', output);
console.log("Wrote analysis.");
