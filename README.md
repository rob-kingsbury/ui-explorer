# UI Explorer

Zero-config UI testing that crawls your app and finds accessibility, responsive, and functional issues.

## Quick Start

```bash
# Just run it
npx ui-explorer http://localhost:3000
```

That's it. No config needed. You'll get:
- Accessibility issues (WCAG 2.1 AA)
- Responsive problems (overflow, touch targets)
- A visual HTML report

## Preset Modes

Pick what you need:

```bash
# Quick scan (default) - fast a11y + responsive check
npx ui-explorer http://localhost:3000

# Accessibility only - WCAG validation
npx ui-explorer a11y http://localhost:3000

# Responsive only - overflow and touch targets on mobile/tablet/desktop
npx ui-explorer responsive http://localhost:3000

# Full exploration - deep crawl with all validators
npx ui-explorer full http://localhost:3000
```

## Common Options

```bash
# With authentication
npx ui-explorer http://localhost:3000 --auth ./playwright/.auth/user.json

# CI mode - exit 1 on critical/serious issues
npx ui-explorer http://localhost:3000 --ci

# See the browser
npx ui-explorer http://localhost:3000 --no-headless

# Ignore certain elements
npx ui-explorer http://localhost:3000 --ignore "button:has-text('Logout')"
```

## Output

Reports are saved to `./ui-explorer-reports/`:
- `report.html` - Visual report with issue details
- `report.json` - Machine-readable for CI integration

## Advanced: Database Verification

For full-stack testing, add Supabase credentials:

```bash
npx ui-explorer full http://localhost:3000 \
  --supabase-url $SUPABASE_URL \
  --supabase-key $SUPABASE_SERVICE_KEY
```

This verifies database changes after actions (row inserts, RLS policies, etc).

## Advanced: Config File

For complex setups, create `ui-explorer.config.js`:

```javascript
export default {
  baseUrl: 'http://localhost:5173',
  auth: './playwright/.auth/user.json',

  // Define expected side-effects for specific actions
  actionSchemas: [
    {
      match: { selector: 'button', text: /add song/i },
      setup: [
        { fill: '[placeholder*="title"]', value: 'Test Song' },
      ],
      expects: [
        { database: { table: 'songs', change: 'insert' } },
        { ui: { hidden: ['[role="dialog"]'] } },
      ],
    },
  ],

  ignore: ['button:has-text("Logout")'],
}
```

Then run:

```bash
npx ui-explorer --config ./ui-explorer.config.js
```

## Programmatic API

```typescript
import { Explorer, createConfig } from 'ui-explorer'

const explorer = new Explorer(createConfig({
  baseUrl: 'http://localhost:3000',
}))

const result = await explorer.explore()
console.log(`Found ${result.summary.issuesFound} issues`)
```

## Preset Details

| Mode | Depth | States | Viewports | Validators |
|------|-------|--------|-----------|------------|
| `quick` | 3 | 50 | mobile, desktop | a11y, responsive |
| `a11y` | 5 | 100 | desktop | a11y only |
| `responsive` | 5 | 100 | mobile, tablet, desktop | responsive only |
| `full` | 10 | 500 | mobile, desktop | all |

## CI Integration

```yaml
# GitHub Actions
- name: UI Explorer
  run: npx ui-explorer ${{ env.PREVIEW_URL }} --ci
```

## License

MIT
