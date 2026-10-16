// In-memory stand-in for the parts of the GitHub REST API the functions use. Test and dev only.
export function installFakeGitHub({ repo = "owner/repo", token = "ghp_test", env = {} } = {}) {
  const files = new Map();
  const dispatches = [];
  const runs = [];
  const pushes = [];
  const pushState = { status: 201 };
  let n = 0;
  const sha = () => `sha${++n}`;
  const realFetch = globalThis.fetch;
  const vars = { GITHUB_TOKEN: token, GITHUB_REPO: repo, ADMIN_KEY: "correct-horse-battery", ...env };
  globalThis.Netlify = { env: { get: (k) => vars[k] } };

  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "fcm.googleapis.com") {
      pushes.push({ url: url.href, headers: init.headers, body: Buffer.from(init.body) });
      return new Response(null, { status: pushState.status });
    }
    if (url.hostname !== "api.github.com") return realFetch(input, init);
    if (init.headers?.Authorization !== `Bearer ${token}`) return reply(401, { message: "Bad credentials" });
    const path = url.pathname.replace(`/repos/${repo}`, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if ((m = path.match(/^\/contents\/(.+)$/))) {
      const name = decodeURIComponent(m[1]);
      if (method === "GET") {
        if (url.searchParams.get("ref") !== "data") return reply(404, { message: "Not Found" });
        const f = files.get(name);
        return f ? reply(200, { content: Buffer.from(f.text).toString("base64"), sha: f.sha }) : reply(404, { message: "Not Found" });
      }
      if (method === "PUT") {
        const f = files.get(name);
        if (f && !body.sha) return reply(422, { message: "sha wasn't supplied" });
        if (f && f.sha !== body.sha) return reply(409, { message: "does not match" });
        const next = { text: Buffer.from(body.content, "base64").toString("utf8"), sha: sha() };
        files.set(name, next);
        return reply(200, { content: { sha: next.sha } });
      }
    }
    if (path.endsWith("/dispatches") && method === "POST") {
      dispatches.push(body.inputs);
      runs.unshift({ id: ++n, event: "workflow_dispatch", status: "queued", conclusion: null, created_at: new Date().toISOString() });
      return reply(204);
    }
    if (path.startsWith("/actions/workflows/") && path.includes("/runs") && method === "GET") return reply(200, { workflow_runs: runs.slice(0, 10) });
    return reply(404, { message: `unhandled ${method} ${path}` });
  };

  return {
    files, dispatches, runs, vars, pushes, pushState,
    put: (name, text) => files.set(name, { text, sha: sha() }),
    restore: () => { globalThis.fetch = realFetch; },
  };
}
