const fs = require('fs');
const path = 'extension/content.js';
let content = fs.readFileSync(path, 'utf8');
const oldStr = '    style.textContent = \n      /* 关键动画：避免 content.css 加载完成前出现生硬闪烁 */\n      @keyframes yuxtrans-slideIn {\n        from { opacity: 0; transform: translateY(8px); }\n        to { opacity: 1; transform: translateY(0); }\n      }\n      @keyframes yuxtrans-fadeIn {\n        from { opacity: 0; }\n        to { opacity: 1; }\n      }\n      @keyframes yuxtrans-spin {\n        to { transform: rotate(360deg); }\n      }\n    ;\n    document.head.appendChild(style);';
const newStr = '    style.textContent = `\n      /* 关键动画：避免 content.css 加载完成前出现生硬闪烁 */\n      @keyframes yuxtrans-slideIn {\n        from { opacity: 0; transform: translateY(8px); }\n        to { opacity: 1; transform: translateY(0); }\n      }\n      @keyframes yuxtrans-fadeIn {\n        from { opacity: 0; }\n        to { opacity: 1; }\n      }\n      @keyframes yuxtrans-spin {\n        to { transform: rotate(360deg); }\n      }\n    `;\n    document.head.appendChild(style);';
if (!content.includes(oldStr)) {
  console.error('oldStr not found');
  process.exit(1);
}
content = content.replace(oldStr, newStr);
fs.writeFileSync(path, content);
console.log('backticks fixed');
