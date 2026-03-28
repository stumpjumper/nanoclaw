# Groups and Tasks

This guide covers how to create groups, add scheduled tasks, and keep behavior well-organized using NanoClaw's CLAUDE.md design pattern.

---

## The Design Philosophy

Every group has a folder at `groups/<folder>/CLAUDE.md`. This file is the single source of truth for how Andy behaves in that group — his persona, what data sources to use, how to format output, what commands Alfred can send, and how to handle them.

**CLAUDE.md owns the "how."** Scheduled task prompts own the "what, right now." This separation keeps behavior easy to find, read, and change without touching the database.

| Belongs in CLAUDE.md | Belongs in the task prompt |
|----------------------|---------------------------|
| Persona and tone | "Send Alfred his morning status." |
| Data sources and file paths | "It's 11am — check and nag if needed." |
| Output format and formatting rules | "Run the YouTube channel check." |
| Command parsing and response rules | |
| Skip rules, urgency scales, edge cases | |

**Why this matters:** A task prompt buried in a SQLite database is hard to find, easy to forget, and tends to go stale (hardcoded months, URLs, etc.). A CLAUDE.md file is a plain text file you can open, read, and edit — and it's backed up to your private repo automatically.

---

## Creating a New Group

### Step 1 — Create the channel group

For Telegram: create a new group and add your bot to it.

### Step 2 — Get the group's JID

Send `/chatid` in the new group. The bot replies with the JID (e.g. `tg:-1234567890`).

### Step 3 — Register the group with Andy

From your **main channel** (self-chat):

```
@Andy register the group tg:-1234567890 as "MyGroup" in folder telegram_mygroup
```

Andy creates the folder at `groups/telegram_mygroup/`, initializes a CLAUDE.md from the global template, and confirms registration. You can also set whether the group requires a trigger word:

```
@Andy register tg:-1234567890 as "MyGroup" folder telegram_mygroup — no trigger required
```

### Step 4 — Write the CLAUDE.md

This is the most important step. The CLAUDE.md should cover everything Andy needs to know to behave correctly in this group. See [Writing the CLAUDE.md](#writing-the-claudemd) below for your three options.

### Step 5 — Verify

Ask Claude Code (this CLI):

```
Check that the group telegram_mygroup is registered correctly and its CLAUDE.md covers
the right things for [describe what the group is for].
```

Or ask Andy from the main channel:

```
@Andy describe the telegram_mygroup group — what's it for, what tasks does it have,
and what does its CLAUDE.md cover?
```

---

## Writing the CLAUDE.md

You have three options depending on how complex the group is and what's easiest in the moment.

### Option A — Ask Andy in the group (recommended for most cases)

Once the group is registered, just describe what you want from within the group:

```
@Andy this group is for tracking my daily blood pressure readings.
I'll log readings here each day. You should remind me if I haven't logged by 8pm,
and give me a weekly summary every Sunday morning. Set yourself up for this —
update your CLAUDE.md with whatever you need and create the tasks.
```

Andy will write the CLAUDE.md and create the tasks in one shot. He has Read, Write, Edit, and TaskCreate tools available.

### Option B — Ask Andy from the main channel

Useful when you want to set up a group before you've sent any messages there:

```
@Andy set up the telegram_mygroup group. It's for [describe purpose].
Update its CLAUDE.md with instructions for [describe behavior],
then create a daily task at 9am to [describe task].
```

From the main channel Andy can manage any group.

### Option C — Write it here in Claude Code

Best for complex groups where you want to draft carefully. Open the file and write it directly, or describe what you want:

```
Write a CLAUDE.md for groups/telegram_mygroup/ covering [describe everything].
```

Claude Code can also inspect existing groups (like the exercise or news groups) for reference on style and structure.

**Good CLAUDE.md sections to include:**
- A short description of what this group is for
- File paths the agent will read/write (e.g. `/workspace/group/mydata.json`)
- How to handle Alfred's messages and commands
- Output format (Telegram formatting rules, emoji use, length)
- Edge cases ("if no data is available, say X")
- Anything that would otherwise get hardcoded in a task prompt

---

## Adding a Scheduled Task

### Option A — Ask Andy in the group (recommended)

```
@Andy create a daily task at 8pm to check if I've logged my blood pressure today.
If not, send me a reminder. Add whatever you need to your CLAUDE.md first.
```

Andy writes the task prompt (a simple trigger), updates CLAUDE.md if needed, and schedules it.

### Option B — Ask Andy from the main channel

```
@Andy add a task to the telegram_mygroup group: every Sunday at 9am,
send a weekly summary of blood pressure readings from the log file.
```

### Option C — From Claude Code

For complex setups, create the task here and insert it into the database:

```sql
INSERT INTO scheduled_tasks (id, group_folder, schedule_type, schedule_value, status, prompt)
VALUES ('task-mygroup-daily', 'telegram_mygroup', 'cron', '0 20 * * *', 'active',
        'Check if Alfred has logged his blood pressure today. Remind him if not.');
```

Or just describe it and Claude Code will handle the SQL.

**Remember:** The task prompt should be one line. All the behavior detail goes in CLAUDE.md.

---

## Verifying Everything Is Correct

After setting up a group or adding tasks, ask Claude Code to check your work:

**Check group registration:**
```
Is telegram_mygroup registered correctly? Show me its DB entry.
```

**Check the CLAUDE.md is complete:**
```
Read groups/telegram_mygroup/CLAUDE.md and tell me if anything looks missing or
inconsistent with how the group is supposed to work.
```

**Check tasks are scheduled correctly:**
```
Show me all active tasks for telegram_mygroup and confirm the prompts follow
the one-liner pattern (no hardcoded dates, months, or URLs that belong in CLAUDE.md).
```

**Check nothing is hardcoded that shouldn't be:**
```
Look at the tasks and CLAUDE.md for telegram_mygroup — are there any hardcoded
values (months, years, specific URLs) that could go stale?
```

**Full sanity check — ask Andy directly** (from the group or main channel):

```
@Andy describe how you work in this group — what's your CLAUDE.md say,
what tasks are scheduled, and when do they run?
```

If Andy can answer that clearly and accurately, everything is wired up correctly.

---

## Checklist

When setting up a new group or task, run through this before calling it done:

- [ ] Group is registered and folder exists at `groups/<folder>/`
- [ ] `CLAUDE.md` exists and covers persona, data sources, output format, commands, and edge cases
- [ ] No behavior is hardcoded in task prompts that could go stale (dates, months, URLs)
- [ ] Task prompts are short triggers — one or two lines
- [ ] Asked Andy to describe the group and got a sensible answer
- [ ] If the group has data files (JSON, markdown trackers), they exist and have the right initial content
- [ ] Private backup repo is current (runs automatically on each `git commit`, or run `~/.nanoclaw-private/sync.sh` manually)

---

## Reference: Existing Groups

These groups are already set up and can serve as examples:

| Group | Folder | What to look at |
|-------|--------|-----------------|
| Exercise | `telegram_exercise` | Urgency scale, file-based state tracking, monthly reset handling |
| Weather | `telegram_weather` | External data sources, strict output format, secondary task (alerts) |
| News | `telegram_news` | Command parsing, API calls, keyword/model selection |
| YouTube | `telegram_youtube` | Browser automation, skip rules, conditional summaries |
| Gmail | `telegram_gmail` | Context injection, feedback command handling |
