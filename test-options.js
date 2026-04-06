const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('extension/options.html', 'utf-8');
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });

dom.window.chrome = {
  runtime: {
    getManifest: () => ({ version: "1.0.0" }),
    sendMessage: async () => ({})
  }
};

const scriptCode = fs.readFileSync('extension/options.js', 'utf-8');
const scriptEl = dom.window.document.createElement('script');
scriptEl.textContent = scriptCode;
dom.window.document.body.appendChild(scriptEl);

dom.window.addEventListener('error', event => {
  console.error("DOM Window Error:", event.error);
});

setTimeout(() => {
  // Let DOMContentLoaded trigger manually since we inject script after parsing
  const event = dom.window.document.createEvent('Event');
  event.initEvent('DOMContentLoaded', true, true);
  dom.window.document.dispatchEvent(event);
  console.log("DOMContentLoaded dispatched");
  
  setTimeout(() => console.log('Test complete'), 1000);
}, 500);
