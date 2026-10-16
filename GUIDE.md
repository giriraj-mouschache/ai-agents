# Your research agent: plain-language guide

## Everyday use
Open the dashboard and unlock it with your access key.
- **Results**: what the agent found, and every past run.
- **Settings**: topics, days and times, who gets the email, how picky it is. Press **Save changes**.
- **Health**: press **Check my setup** if anything looks wrong. It says which key or setting to fix.
- **Run now** starts a run immediately. **Pause** stops everything until you press **Resume**.

## Writing good topics
- *What counts as a good result?* Describe the reader, not keywords: "New releases and techniques a working engineer can use. Skip hype and funding news."
- *What should it search for?* Short phrases like you would type into Google, one per line.
- For leads (jobs, clients), say what you can do and what you want: the agent then pulls out pay, date and how to apply when the page says so.
- If you get too few results, lower **Minimum relevance**. Too many weak ones, raise it.

## When something stops working
1. Open **Health** and press **Check my setup**.
2. Fix what it marks with a red cross. All keys live in GitHub: your repo, Settings, Secrets and variables, Actions.
   - Gmail refuses login: create a new App Password for the sending account, update `GMAIL_APP_PASSWORD`.
   - AI problem: make a new key at Google AI Studio or Groq, update `GEMINI_API_KEY` or `GROQ_API_KEY`.
   - Search empty: add a free `TAVILY_API_KEY`.
3. Press **Check my setup** again, then **Run now**.

## Changing keys safely
Never paste keys into the dashboard, into chat, or into files in the repo. If one leaks, delete it at the provider and add a new one in GitHub Secrets. To rotate the dashboard's own keys: change `ADMIN_KEY` or `GITHUB_TOKEN` in Netlify, then redeploy.

## Moving it to another account
1. Copy (fork) the repo to the new GitHub account and keep its `data` branch.
2. Add the same secrets there (Gmail, AI keys, optional Tavily).
3. Create a fine-grained GitHub token for the new repo (Contents and Actions: read and write).
4. In Netlify, import the new repo and set `GITHUB_TOKEN`, `ADMIN_KEY` and `GITHUB_REPO` (owner/repo), then deploy.

## What it costs
Nothing: GitHub Actions, Netlify and the free AI tiers cover it. Free tiers have daily limits; if one runs out the agent tries the next AI you have a key for.
