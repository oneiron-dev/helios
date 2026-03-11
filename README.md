# Helios

> [!CAUTION]
> **Important:** Helios does not currently have a permissions/security model. The agent runs basically unrestricted. You are responsible for any losses of data/other adverse outcomes from running it. If you have stuff you care about, then back it up (whether or not you use Helios, backing up is a good idea!), run Helios in a container, or wait until it has a permissions system.

![Helios screenshot](https://raw.githubusercontent.com/snoglobe/helios/main/media/screnshot.png)

An autonomous research agent inspired by [Andrej Karpathy's 'autoresearch'](https://github.com/karpathy/autoresearch). Autoresearch works very well within Helios, just have to tune the prompt slightly.

It can operate seamlessly over SSH (even multiple machines), keeps the model in a loop, has tools to view/compare metrics, shows metrics directly in the UI, and has a memory system. 

You can leave it to work overnight and don't have to worry about it exiting the loop early to stupidly ask you something or because it has to wait for something. And hopefully you'll wake up to results.

## Install

```bash
npm install -g @snoglobe/helios
```

Requires Node.js 20+.

## Auth

**Claude** (default) — either:
- Install the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) and run `claude login`
- Or set `ANTHROPIC_API_KEY` and use `/claude-mode api`
- Claude CLI usage is ban-free; conforms to Anthropic's usage policy

**OpenAI** — OAuth login on first run (requires ChatGPT Plus or Pro).

## Usage

```
helios [options]

Options:
  -p, --provider <claude|openai>  Model provider (default: claude)
  --claude-mode <cli|api>         Claude auth mode (cli = Agent SDK, api = API key)
  -v, --version                   Show version
  -h, --help                      Show help
```

Type a goal and Helios takes over:

```
> Train a 125M parameter GPT on TinyStories to loss < 1.0
```

It will write training scripts, launch runs, parse metrics from stdout, set up monitoring intervals, compare experiments, and keep iterating until the goal is met or you interrupt.

## Commands

| Command | Description |
|---|---|
| `/switch <claude\|openai>` | Switch model provider |
| `/model <model-id>` | Set model |
| `/models` | List available models |
| `/reasoning <level>` | Set reasoning effort (Claude: `medium` `high` `max` / OpenAI: `none` `minimal` `low` `medium` `high` `xhigh`) |
| `/claude-mode <cli\|api>` | Switch Claude auth mode |
| `/machine add <id> <user@host[:port]>` | Add remote machine (`--key <path>`, `--auth <agent\|key>`) |
| `/machine rm <id>` | Remove machine |
| `/machines` | List machines and connection status |
| `/metric [name ...]` | Show metric sparklines |
| `/metrics clear` | Clear all metrics |
| `/resume` | List recent sessions |
| `/resume <n>` | Resume a past session |
| `/writeup` | Generate experiment writeup from conversation |
| `/sticky <text>` | Pin a note to the sidebar |
| `/stickies` | List sticky notes |
| `/memory [path]` | Browse the agent's memory tree |
| `/status` | Provider, model, cost, state |
| `/clear` | Clear conversation |
| `/help` | Show all commands |

## Keys

| Key | Action |
|---|---|
| `Ctrl+T` | Task output overlay |
| `Ctrl+G` | Metrics overlay |
| `Escape` | Interrupt / close overlay |
| `Ctrl+C` | Interrupt / exit |
| `Tab` | Autocomplete command |
| `↑` `↓` | History / menu navigation |
| `PageUp` `PageDown` | Scroll conversation |
| `Ctrl+A` `Ctrl+E` | Start / end of line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+U` | Clear line |

Mouse scroll works in terminals that support SGR mouse reporting.

## Remote Machines

Helios can run workloads on remote machines over SSH. The `local` machine is always available.

```bash
# Add a GPU box
/machine add gpu1 researcher@10.0.0.5 --key ~/.ssh/id_rsa

# Add with custom port
/machine add gpu2 user@hostname:2222
```

Machines are stored in `~/.helios/machines.json` and auto-connect on startup.

The agent prefers remote machines for heavy compute and uses `local` for lightweight tasks. Or if you don't have a remote machine.

## How It Works

Helios runs an autonomous loop:

1. **Understand the goal** — break it into experiments
2. **Launch** via `remote_exec_background` — stdout is captured, metrics are parsed live
3. **Monitor** via `start_monitor` — periodic check-ins review progress
4. **Compare** via `compare_runs` — keep improvements, discard regressions
5. **Iterate** — plan and launch the next experiment
6. **Stop** only when the goal is achieved or it hits an unrecoverable error

### Metric Tracking

Training scripts print metrics to stdout. Helios parses them automatically:

```python
# key=value format (detected via metric_names)
print(f"loss={loss:.4f} acc={acc:.4f} lr={lr:.6f}")

# Custom patterns (detected via metric_patterns)
print(f"Step {step}: Loss {loss:.4f}")
```

Live sparklines appear in the dashboard. The agent uses `show_metrics` and `compare_runs` to make decisions.

### Memory

Long sessions get checkpointed when the context window fills up. The agent's memory persists as a virtual filesystem:

```
/goal                    → "Train TinyStories to loss < 1.0"
/best                    → "Run #3: lr=3e-4, cosine → loss=0.83"
/experiments/
  4521                   → config, metrics, verdict
  4380                   → config, metrics, verdict
/observations/
  cosine-schedule-helps  → "cosine decay outperforms linear by ~15%"
```

After a checkpoint, the agent receives its memory tree and continues where it left off.

### Consult

The agent can ask the other provider for a second opinion:

```
# If running on Claude, consult asks OpenAI (and vice versa)
consult("I'm stuck at loss=0.9 — what should I try next?")
```

## Models

**Claude** (200k context):
- `claude-opus-4-6` — higher-end reasoning/coding (default)
- `claude-sonnet-4-6` — balanced speed vs reasoning

**OpenAI** (~400k context):
- `gpt-5.4` — latest flagship, recommended (default)
- `gpt-5.3-codex` — codex
- `gpt-5.3-codex-spark` — research preview, text-only
- `gpt-5.2-codex` — codex
- `gpt-5.2`
- `gpt-5.1-codex-max` — max compute
- `gpt-5.1`
- `gpt-5.1-codex` — codex

## Tools

The agent has access to 19 tools:

| Tool | What it does |
|---|---|
| `remote_exec` | Run a quick command (ls, pip install, git clone) |
| `remote_exec_background` | Launch a long-running process with metric tracking |
| `remote_upload` / `remote_download` | rsync files between machines |
| `read_file` / `write_file` / `patch_file` | File operations on any machine |
| `list_machines` | Show configured machines |
| `task_output` | Tail stdout/stderr of a background task |
| `show_metrics` | Query metrics with sparklines |
| `compare_runs` | Side-by-side comparison of two runs |
| `clear_metrics` | Wipe stale metric data |
| `kill_task` | Kill a running process |
| `web_fetch` | Fetch web pages, docs, papers |
| `sleep` | Sleep with composable triggers (timer, process exit, metric threshold, file change, resource usage) |
| `start_monitor` / `stop_monitor` | Periodic monitoring loop |
| `memory_ls` / `memory_read` / `memory_write` / `memory_rm` | Persistent memory |
| `consult` | Ask the other AI provider |

## Data

Everything is stored locally in `~/.helios/`:

```
~/.helios/
  helios.db          SQLite database (sessions, metrics, memory)
  machines.json      Remote machine configs
  auth/
    auth.json        OAuth tokens and API keys
  preferences.json   Last provider, claude mode
```

## Development

```bash
git clone https://github.com/snoglobe/helios.git
cd helios
npm install
npm run dev          # tsx src/index.tsx
npm run build        # tsc
npm start            # node dist/index.js
```

## License

Apache-2.0
