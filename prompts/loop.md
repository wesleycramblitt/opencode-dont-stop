# Loop Prompt Template

Start here when running a dont-stop loop. Describe your task or question clearly. The loop keeps working until **you halt it** — it never stops on its own.

Example: "Read this document and summarize the main arguments."

When the model believes the work is done it may reply `<loop-complete/>`; that is only a report. The loop acknowledges it and continues, so you decide when the work is finished:

- `/dont-stop-set stop` — halt the loop for this session
- `/dont-stop-halt` — the TUI key for the same thing
