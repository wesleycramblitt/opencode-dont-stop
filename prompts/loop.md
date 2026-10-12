# Loop Prompt Template

Start here when running a dont-stop loop. Describe your task or question clearly. The loop keeps working until **you halt it** — it never stops on its own.

Example: "Read this document and summarize the main arguments."

The loop retires a session and continues in a fresh one when a unit of work is finished, after a stretch of turns, or when the context gets full. The work is on disk — plans, task files, the codebase index — so nothing is carried between sessions; the plugin tells the model to re-read the state before continuing.

When the model believes the whole task is done it may reply `<loop-complete/>`; that is only a report, never a stop. The loop keeps going (usually in a fresh session), so you decide when the work is finished:

- `/dont-stop-set stop` — halt the loop for this session
- `/dont-stop-halt` — the TUI key for the same thing
