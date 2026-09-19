import base from '../playwright.config';
export default { ...base, testDir: '.', projects: [
  { name: 'setup', testMatch: /auth\.setup\.ts/ },
  { name: 'tmp', testMatch: /tmp-cost\.spec\.ts/, dependencies: ['setup'] }] };
