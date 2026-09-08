// create-pr-49.mjs — open the PR for fix/49-dashboard-a11y (issue #49)
// Token is read from the origin remote URL and never printed.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
const m = url.match(/^https:\/\/([^@]+)@github\.com\//);
if (!m) { console.error('no embedded credential in remote url'); process.exit(1); }
const TOKEN = decodeURIComponent(m[1]).replace(/^.*:/, '');
if (!TOKEN) { console.error('no token found'); process.exit(1); }

const REPO = 'Roy-Wanyoike/bridge';
const body = readFileSync('/home/z/my-project/scripts/pr-body-49.md', 'utf8');

const res = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
  method: 'POST',
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'bridge-task-agent',
  },
  body: JSON.stringify({
    title: 'fix(dashboard): keyboard-accessible tabs, compliant dialog, contrast + graph roles, scope sync',
    head: 'fix/49-dashboard-a11y',
    base: 'main',
    body,
  }),
});
const j = await res.json();
if (res.status === 201) {
  console.log(`PR #${j.number} created: ${j.html_url}`);
} else {
  console.error(`FAILED ${res.status}: ${JSON.stringify(j).slice(0, 500)}`);
  process.exit(1);
}
