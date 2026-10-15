# ai-agents: scheduled research agent that emails you

A small agent that runs on a schedule (GitHub Actions, free), searches the web for the topics in
`config.yaml`, reads the pages, has a free-tier LLM score and summarize them, and emails you a digest
through Gmail SMTP. It remembers what it already sent, so you never get the same link twice.

```
cron (GitHub Actions) -> search (Tavily or DuckDuckGo) -> fetch pages (trafilatura)
   -> LLM scores + summarizes (Gemini / Groq / OpenRouter, free tiers) -> follow-up round
   -> HTML digest -> Gmail SMTP -> you     (state/seen.json commits back to the repo)
```

## Setup (about 10 minutes)

1. **Keep this repo private.** The agent stores nothing secret in it, but there is no reason to expose your topics.
2. **Gmail App Password.** Turn on 2-step verification for your Google account, then create an App Password at
   <https://myaccount.google.com/apppasswords>. Use that 16-character password, not your normal one.
3. **At least one free LLM key** (more than one gives automatic fallback when a free quota runs out):
   - Gemini: <https://aistudio.google.com/apikey>
   - Groq: <https://console.groq.com/keys>
   - OpenRouter: <https://openrouter.ai/keys>
4. **Add GitHub secrets**: repo *Settings -> Secrets and variables -> Actions -> New repository secret*.

   | Secret | Required | Notes |
   |---|---|---|
   | `GMAIL_USER` | yes | the Gmail address that sends the digest |
   | `GMAIL_APP_PASSWORD` | yes | the App Password from step 2 |
   | `MAIL_TO` | no | where the digest goes; defaults to `GMAIL_USER` |
   | `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | at least one | free-tier LLM keys |
   | `TAVILY_API_KEY` | no | cleaner search results than DuckDuckGo (free tier available) |

5. **Edit `config.yaml`**: replace the starter topics with what you want tracked.
6. **Test it**: *Actions -> research-agent -> Run workflow*. Tick **dry_run** first to download a sample digest
   without emailing anything; run it again unticked to get the real email.

Never put the Gmail password or API keys in `config.yaml`, in code, or in chat. Secrets belong only in GitHub Secrets
(or a local `.env`, which is git-ignored).

## Schedule

The cron line in `.github/workflows/research-agent.yml` is in UTC. The default `30 2 * * *` is 08:00 IST daily.
Examples: every 3 hours `0 */3 * * *`, weekdays 09:00 IST `30 3 * * 1-5`. GitHub can delay scheduled runs by several
minutes at busy times, and it is not a real-time listener.

## Configure topics

```yaml
topics:
  - name: AI and LLM engineering
    goal: What counts as relevant, in plain words. The LLM uses this to score results.
    timelimit: w            # optional per-topic override: d, w, m, y
    mode: text              # optional: "news" uses DuckDuckGo/Tavily news search
    min_score: 7            # optional per-topic override
    queries:
      - search phrase one
      - search phrase two
```

How a run works per topic: your queries are searched, new pages are read, the LLM scores each 0-10 against your
`goal`, and it may propose up to three follow-up queries for a second round (`research.max_rounds`). Only items at
or above `min_score` are emailed.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # fill in values; .env is git-ignored
python -m agent.main --test-email   # checks Gmail SMTP only
python -m agent.main --dry-run      # writes out/digest.html, no email, no state saved
python -m agent.main                # real run
pytest                              # unit tests (no network or keys needed)
```

Flags: `--topic "AI and LLM engineering"` runs one topic, `--config other.yaml` uses another config.

## Notes and limits

- **Free quotas.** Free LLM tiers have per-minute and per-day limits. The client retries, then falls back to the next
  provider you have a key for. If every LLM is unavailable, you still get raw links marked "unranked".
- **Model names drift.** If a provider returns "model not found", set `llm.models` in `config.yaml`.
- **DuckDuckGo** is unofficial and can rate-limit GitHub's shared IPs. Adding a free Tavily key makes search much steadier.
- **Failures are visible.** A failed run turns the workflow red and GitHub emails you; partial problems are listed at the
  bottom of the digest. A failed email send does not mark links as seen, so the next run retries them.
- **Scheduled workflows can pause.** GitHub disables scheduled runs on repos with no activity for 60 days (public repos).
  The state commit counts as activity in most cases, but if emails stop, check the Actions tab.
- **Prompt-injection safety.** Web pages are treated as untrusted data. The agent has no tools that act on your behalf
  (it cannot send email to anyone but you, run code, or visit private addresses), and links in the digest come from the
  search results, never from model output.
- **State.** `state/seen.json` holds hashed URLs and titles from the last 90 days. Delete its contents to reset.
