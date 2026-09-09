# Contributing

Thanks for taking a look.

## Developing

There is **no build step**. `dist/fusionsolar-statistics-card.js` is a single
vanilla custom element with inline SVG and no dependencies — edit it directly.

To iterate without a Home Assistant instance, open `tools/demo.html` in a
browser. It renders the card against synthetic statistics:

```
tools/demo.html?period=day      # or month | year | lifetime
```

To regenerate the README screenshots:

```bash
npx playwright@latest install chromium
node tools/make-screenshots.js
```

To try a change against a real instance, copy the JS into
`<config>/www/` and bump the `?v=` query on the dashboard resource so the
browser reloads it.

## Before opening a PR

- Keep it dependency-free and buildless.
- `node --check dist/fusionsolar-statistics-card.js` must pass.
- If you change the visuals, regenerate the screenshots.
- Describe which Huawei hardware you tested against — register semantics vary
  between EMMA, SDongle and SmartLogger setups.

## Reporting problems

Please include your card YAML (entity ids are fine to share), your Home
Assistant version, and what the equivalent screen in the FusionSolar app shows.
