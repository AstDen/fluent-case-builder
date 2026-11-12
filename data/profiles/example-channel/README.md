# Profile `example-channel` — synthetic example

A minimal profile showing the data format and engine capabilities:

- **parameters** (`meshFile`, `L`, `h`, `iterations`) and a **computed** field (`y_mid`);
- case and file **naming** (`channel_L-<L>mm_h-<h>mm...`);
- `quick`/`fine` **presets** (the residual criterion is chosen automatically);
- **journal template** `templates/setup_case.jou.tmpl` — verified TUI lines only.

This is **not** a reproduction of a scientific run: the template contains no boundary conditions or
reports of a specific project. It is meant to:

1. understand how a profile is structured (how to write `profile.json` and templates);
2. quickly check the installation: `fluent_case_plan({profile:"example-channel", params:{meshFile:"/path/to/your.msh"}})`;
3. use it as a starting point for your own profile.

## Try it

```text
fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_generate({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
```

The case appears in `caseRoots[0]` (by default `~/fluent-cases`).

## Your own profile

Copy the directory, rename `id`, describe your parameters/computations/assets and templates
according to the `docs/FORMATS.md` §1 contract. No code changes are needed.
