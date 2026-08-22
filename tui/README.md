# ompw

ompw is the terminal viewer for [omp-workflows](https://github.com/ericjuta/omp-workflows).
It browses saved workflow runs, follows active runs, and replays recorded workflow and Pi conversation events without rerunning models or tools.

## Install

Install the `omp-workflows` crate to get the `ompw` command:

```bash
cargo install omp-workflows
```

## Use

Open the default run directory:

```bash
ompw
```

Open another run directory or one specific run bundle:

```bash
ompw /path/to/runs
ompw /path/to/one-run
```

Serve local runs over the live replay protocol:

```bash
ompw serve
```

Connect another viewer to that server:

```bash
ompw connect ws://127.0.0.1:9377/ws
```

See the [ompw viewer guide](https://github.com/ericjuta/omp-workflows/blob/main/docs/tui-viewer.md) for controls, themes, replay behavior, and remote viewing.
