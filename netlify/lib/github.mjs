// Thin GitHub REST client. The token only ever lives in the Netlify environment, never in the browser.

export const cfg = () => ({
  token: Netlify.env.get("GITHUB_TOKEN") || "",
  repo: Netlify.env.get("GITHUB_REPO") || "giriraj-mouschache/ai-agents",
  dataBranch: Netlify.env.get("DATA_BRANCH") || "data",
  codeBranch: Netlify.env.get("CODE_BRANCH") || "main",
  workflow: "research-agent.yml",
});

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(method, path, body) {
  const c = cfg();
  if (!c.token) throw new GitHubError(503, "GITHUB_TOKEN is not set in Netlify.");
  const res = await fetch(`https://api.github.com/repos/${c.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "research-digest-dashboard",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const hint = res.status === 401 ? "GitHub rejected the token (expired or wrong)."
      : res.status === 403 || res.status === 404 ? "The token cannot reach this repo or lacks Contents and Actions permission."
      : data?.message || `GitHub error ${res.status}`;
    throw new GitHubError(res.status, hint);
  }
  return data;
}

export async function getFile(path) {
  const c = cfg();
  try {
    const data = await gh("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(c.dataBranch)}`);
    return { text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export async function putFile(path, text, sha, message) {
  const c = cfg();
  try {
    const data = await gh("PUT", `/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      message, branch: c.dataBranch, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}),
      committer: { name: "dashboard", email: "dashboard@users.noreply.github.com" },
    });
    return data.content.sha;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
      throw new GitHubError(409, "Settings were changed somewhere else. Reload the page and try again.");
    }
    throw e;
  }
}

export async function dispatch(inputs) {
  const c = cfg();
  await gh("POST", `/actions/workflows/${c.workflow}/dispatches`, { ref: c.codeBranch, inputs });
}

export async function listRuns(perPage = 8) {
  const c = cfg();
  const data = await gh("GET", `/actions/workflows/${c.workflow}/runs?per_page=${perPage}`);
  return (data?.workflow_runs || []).map((r) => ({
    id: r.id, event: r.event, status: r.status, conclusion: r.conclusion, created_at: r.created_at,
  }));
}
