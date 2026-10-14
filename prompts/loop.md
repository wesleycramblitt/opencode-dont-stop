# Loop Prompt Template

Start here when running a dont-stop loop. Describe your task or question clearly. The loop keeps working until **you halt it** — it never stops on its own.

Example: "Read this document and summarize the main arguments."

The loop retires a session and continues in a fresh one when a unit of work is finished, after a stretch of turns, or when the context gets full. The work is on disk — plans, task files, the codebase index — so nothing is carried between sessions; the plugin tells the model to re-read the state before continuing. A long-running session is compacted and its mission restated periodically, so the model stays on task without you intervening.

The model is never asked to declare the work done — there is no completion token to emit and no way for the model to stop the loop. You decide when the work is finished:

- `/dont-stop-set stop` — halt the loop for this session
- `/dont-stop-halt` — the TUI key for the same thing
