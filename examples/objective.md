# CSV and JSON export for `shop report`

## Goal

`shop report --month <YYYY-MM>` prints the monthly sales report as a table. Add a `--format` option so that the same report can be exported as CSV or JSON for spreadsheets and scripts, and an `--output <file>` option that writes the export to a file. The table output must not change.

## Definition of done

- `shop report --month 2026-10 --format csv` writes RFC 4180 CSV to stdout: the header row `order_id,date,product,quantity,unit_price,total`, then one row per order line. Fields that contain a comma, a double quote or a line break are quoted, and embedded double quotes are doubled.
- `shop report --month 2026-10 --format json` writes a JSON array with one object per row, keyed by the same column names.
- `shop report` without `--format`, or with `--format table`, prints exactly what it prints today.
- `--output <file>` writes the export to that file and prints nothing on stdout.
- An unknown format exits with code 2 and names the allowed formats (`table`, `csv`, `json`) on stderr.
- Unit tests cover the CSV quoting rules and every format. `npm run typecheck` and `npm test` pass.
- The README documents `--format` and `--output`, with one example each.

## Out of scope

- How the report is computed: totals and rounding stay as they are.
- New runtime dependencies: write the CSV and JSON serializers yourself.
- Commands other than `shop report`.

## How a user tries it

- Build the CLI with `npm ci && npm run build`.
- Run it on the fixture data: `SHOP_DATA=test/fixtures node dist/cli.js report --month 2026-10 --format csv`. The October fixture contains a product name with a comma and one with a double quote.
- Run `report` with each format, with `--output`, with an unknown format, and without `--format`. The table output must be byte-identical to the output before the change.

## Validation

Validation commands run in a fresh checkout without `node_modules` or `dist/`, so every command installs its dependencies first.

- Acceptance command for the whole objective: `npm ci && npm run typecheck && npm test`
- Behavioural QA: the steps under "How a user tries it".

## Suggested milestones

1. Serializers: CSV and JSON serializers for report rows, with unit tests. A code review and `npm ci && npm test` are enough here; there is nothing a user can run yet.
2. CLI options and docs: `--format`, `--output`, the error for an unknown format, and the README.
