# Nathan — Onboarding (Player)

GitHub: `nathanywang2003-bit` · Member ID: `nathan`

> You can log in (check in) **right away, without an invite** — the repository is public. The invite is only needed when you push (e.g. marking a mission done).

## 1. Install (once)

| You need | Check | If missing |
| --- | --- | --- |
| git | `git --version` in a terminal | Mac: `xcode-select --install` · Windows: git-scm.com |
| Node 18+ | `node -v` | Install the LTS from nodejs.org |
| Claude Code | `claude --version` | Mac: `curl -fsSL https://claude.ai/install.sh \| bash` · Windows (PowerShell): `irm https://claude.ai/install.ps1 \| iex` |

Then run `claude` in a terminal and sign in with your Claude account.

## 2. First login — paste all of this into Claude Code

```
nathan https://github.com/newcode135-prog/mimic-note

I'm Nathan, a player in Mimic Note. My GitHub ID is nathanywang2003-bit. Please always reply to me in English.
1) If the repo isn't on this computer, git clone it to ~/mimic-note; otherwise git pull.
2) Follow rule 0 in the repo's CLAUDE.md: run `node mimic-note/checkin.mjs nathan`.
3) Show me (1) the Premise first, then (2) my missions — translated into English without changing the meaning.
4) Follow the Premise for this whole session.
5) If a push fails, I probably haven't accepted the GitHub invite yet — tell me how, and help with `gh auth login`.
```

After the first time, just send the first line: `nathan https://github.com/newcode135-prog/mimic-note`

## 3. Accept the invite (after Changmin sends it)

From the email, or https://github.com/newcode135-prog/mimic-note/invitations → **Accept**.

## Key rules in short (the full Premise is shown at check-in)

- Only do and complete **your own** missions; mark done only what you really finished.
- Write only in your own folder: `mimic-note/data/players/nathan/`.
- This repo is **public** — never put tokens, passwords, chat IDs or contact details in files.

## For Changmin (창민님이 할 일)

https://github.com/newcode135-prog/mimic-note/settings/access → **Add people** → `nathanywang2003-bit` → **Write**
