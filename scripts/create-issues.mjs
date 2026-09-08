// create-issues.mjs — batch-create the BRIDGE audit issues
import { issues1 } from "./issues-data-1.mjs";
import { issues2 } from "./issues-data-2.mjs";

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error("GH_TOKEN required"); process.exit(1); }
const REPO = "Roy-Wanyoike/bridge";
const all = [...issues1, ...issues2];

async function createIssue(it) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "bridge-audit-bot",
    },
    body: JSON.stringify({ title: it.title, body: it.body, labels: it.labels }),
  });
  const j = await res.json();
  if (res.status === 201) return { n: j.number, title: it.title };
  return { n: null, title: it.title, error: `${res.status} ${JSON.stringify(j).slice(0, 200)}` };
}

const results = [];
for (const it of all) {
  const r = await createIssue(it);
  results.push(r);
  console.log(r.n ? `#${r.n} created: ${it.title.slice(0, 80)}` : `FAILED ${r.error}: ${it.title.slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, 300));
}
const ok = results.filter((r) => r.n);
console.log(`\n${ok.length}/${all.length} issues created`);
console.log(JSON.stringify(results.map((r) => ({ issue: r.n, title: r.title.slice(0, 60) })), null, 0));
