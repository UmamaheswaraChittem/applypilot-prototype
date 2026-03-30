try {
  require('./src/apply/linkedin');
  console.log('linkedin.js: OK');
} catch (e) {
  console.error('linkedin.js:', e.message);
}
try {
  require('./src/apply/naukri');
  console.log('naukri.js: OK');
} catch (e) {
  console.error('naukri.js:', e.message);
}
