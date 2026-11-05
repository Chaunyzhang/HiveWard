# Hello TSX

A components panel written in TSX with no build step and no `dist/` folder. HiveWard transpiles
`src/*.tsx` and `src/*.ts` when the panel loads (types stripped, JSX compiled for `hiveward`, relative
imports such as `./todos` resolved to their files).

```sh
hiveward plugin dev load .   # also writes .hiveward/types, the typings tsconfig.json extends
npx tsc -p .             # optional type check
hiveward plugin test .       # runs src/panel.test.tsx in Node with hiveward/testing
hiveward plugin check .      # renders the panel once and reports errors with file:line
```

Import only `hiveward` and relative files: there is no bundler, so `import 'react'` fails with an
error naming the file and the import.

It shows the components API: keyed atoms persisted per plugin (`src/todos.ts`), `derived`
values, `setup(ctx)` subscribing to the typed `on('theme')` event, and `ui.has` feature
detection.
