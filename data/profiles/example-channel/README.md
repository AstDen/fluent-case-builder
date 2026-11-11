# Профиль `example-channel` — синтетический пример

Минимальный профиль, показывающий формат данных и возможности движка:

- **параметры** (`meshFile`, `L`, `h`, `iterations`) и **вычисляемое** поле (`y_mid`);
- **именование** кейса и файлов (`channel_L-<L>mm_h-<h>mm...`);
- **пресеты** `quick`/`fine` (критерий по невязкам выбирается автоматически);
- **шаблон журнала** `templates/setup_case.jou.tmpl` — только проверенные строки TUI.

Это **не** воспроизведение научного расчёта: шаблон не содержит граничных условий и
отчётов конкретного проекта. Он нужен, чтобы:

1. понять, как устроен профиль (как писать `profile.json` и шаблоны);
2. быстро проверить установку: `fluent_case_plan({profile:"example-channel", params:{meshFile:"/path/to/your.msh"}})`;
3. взять его за основу своего профиля.

## Попробовать

```text
fluent_case_plan({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
fluent_case_generate({ profile: "example-channel", params: { meshFile: "/path/to/channel.msh" } })
```

Кейс появится в `caseRoots[0]` (по умолчанию `~/fluent-cases`).

## Свой профиль

Скопируйте каталог, переименуйте `id`, опишите свои параметры/вычисления/ассеты и шаблоны
по контракту `docs/FORMATS.md` §1. Код менять не нужно.
