# UI Explorer - Full-Stack Integration Test Explorer

A state-machine based testing tool that exhaustively explores web applications while simultaneously verifying UI, database, APIs, and external services at every state transition.

**Think of it as an entire QA team doing a complete audit in one sweep.**

## Goals

1. **Exhaustive UI coverage** - Click every button, follow every path, test every state
2. **Database verification** - Confirm data persists correctly, RLS policies work
3. **API validation** - Edge functions respond correctly, errors handled
4. **External service testing** - Auth, payments, realtime, AI services
5. **Accessibility** - WCAG 2.1 AA compliance at every state
6. **Responsive** - Multi-viewport testing with overflow/touch target detection
7. **Schema-driven assertions** - Config defines expected side-effects per action

## Architecture

```
ui-explorer/
├── src/
│   ├── core/
│   │   ├── types.ts              # All type definitions
│   │   ├── StateManager.ts       # State identity, hashing, storage
│   │   ├── ActionDiscovery.ts    # Find interactive elements
│   │   ├── ActionExecutor.ts     # Perform actions, handle forms
│   │   ├── Explorer.ts           # Main BFS crawl loop
│   │   └── AssertionEngine.ts    # Run schema-driven assertions
│   │
│   ├── adapters/                 # Pluggable service adapters
│   │   ├── BaseAdapter.ts        # Abstract adapter interface
│   │   ├── SupabaseAdapter.ts    # Database, Auth, Realtime, Storage
│   │   ├── StripeAdapter.ts      # Payments, subscriptions, webhooks
│   │   ├── GroqAdapter.ts        # AI service verification
│   │   └── index.ts              # Adapter registry
│   │
│   ├── validators/               # Per-state validators
│   │   ├── AccessibilityValidator.ts   # axe-core WCAG checks
│   │   ├── ResponsiveValidator.ts      # Overflow, touch targets
│   │   ├── ConsoleValidator.ts         # JS errors, warnings
│   │   ├── NetworkValidator.ts         # Failed requests, slow responses
│   │   └── index.ts
│   │
│   ├── reporters/
│   │   ├── HTMLReporter.ts       # Interactive graph + issue dashboard
│   │   ├── JSONReporter.ts       # Machine-readable for CI
│   │   ├── PlaywrightGenerator.ts # Generate regression tests
│   │   └── index.ts
│   │
│   ├── cli.ts                    # CLI entry point
│   └── index.ts                  # Library exports
│
├── package.json
├── tsconfig.json
└── README.md
```

## Core Concepts

### State = UI + Backend Snapshot

A state is not just the DOM - it includes backend state:

```typescript
interface AppState {
  id: string                    // Hash of all components

  // UI State
  url: string
  title: string
  domFingerprint: string        // Hash of interactive elements
  modalOpen: string | null      // Modal identifier if open
  screenshot?: string           // File path

  // Backend State (captured via adapters)
  dbSnapshot?: DatabaseSnapshot
  authState?: AuthState

  // Metadata
  viewport: Viewport
  timestamp: number
}

interface DatabaseSnapshot {
  tables: Record<string, {
    rowCount: number
    recentRows?: any[]          // Last N rows for verification
  }>
}

interface AuthState {
  isAuthenticated: boolean
  userId?: string
  role?: string
  permissions?: string[]
}
```

### Actions with Expected Side-Effects

Actions include schema-driven assertions:

```typescript
interface Action {
  // What to do
  type: 'click' | 'fill' | 'select' | 'keypress' | 'upload'
  selector: string
  label: string
  value?: string

  // Expected side-effects (from schema)
  expects?: ActionExpectation[]
}

interface ActionExpectation {
  // Database expectations
  database?: {
    table: string
    change: 'insert' | 'update' | 'delete' | 'unchanged'
    where?: Record<string, any>   // Conditions to match
    count?: number                // Expected row count change
  }

  // API expectations
  api?: {
    endpoint: string | RegExp
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    status: number | number[]
    responseContains?: Record<string, any>
  }

  // UI expectations
  ui?: {
    visible?: string[]            // Selectors that should appear
    hidden?: string[]             // Selectors that should disappear
    text?: Record<string, string> // Element -> expected text
  }

  // External service expectations
  service?: {
    adapter: string               // 'stripe', 'groq', etc.
    action: string                // Adapter-specific action
    expects: Record<string, any>  // Adapter-specific expectations
  }
}
```

### Exploration Schema

The config file defines the "contract" for each UI action:

```typescript
// ui-explorer.config.ts
export default {
  baseUrl: 'http://localhost:5173',

  // Service adapters
  adapters: {
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_KEY, // For DB verification
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY,
    },
  },

  // Schema: what each action should do
  actionSchemas: [
    {
      // Match: clicking "Add Song" button
      match: {
        selector: 'button',
        text: /add song/i,
        context: '/songs',  // Only on songs page
      },

      // Before: fill the form
      setup: [
        { fill: '[placeholder*="title" i]', value: '{{testData.songTitle}}' },
        { fill: '[placeholder*="artist" i]', value: '{{testData.artistName}}' },
      ],

      // After: verify side effects
      expects: [
        {
          database: {
            table: 'songs',
            change: 'insert',
            where: { title: '{{testData.songTitle}}' },
          },
        },
        {
          ui: {
            hidden: ['[role="dialog"]'],  // Modal should close
            visible: ['text={{testData.songTitle}}'],  // Song in list
          },
        },
      ],
    },

    {
      // Match: clicking "Delete" with confirmation
      match: {
        selector: 'button',
        text: /delete/i,
      },

      // This is destructive - handle specially
      destructive: true,

      expects: [
        {
          ui: {
            visible: ['[role="alertdialog"]'],  // Confirm dialog
          },
        },
      ],

      // Follow-up action after confirmation
      followUp: {
        match: { selector: 'button', text: /confirm|yes|delete/i },
        expects: [
          {
            database: {
              table: '{{context.table}}',
              change: 'delete',
              count: -1,
            },
          },
        ],
      },
    },

    {
      // Match: AI Fill button (Pro feature)
      match: {
        selector: 'button',
        text: /ai fill/i,
      },

      expects: [
        {
          api: {
            endpoint: /functions\/v1\/ai-lyrics/,
            method: 'POST',
            status: 200,
          },
        },
        {
          service: {
            adapter: 'supabase',
            action: 'checkCredits',
            expects: { decremented: true },
          },
        },
      ],
    },

    {
      // Match: Stripe checkout
      match: {
        selector: 'button',
        text: /upgrade|subscribe/i,
      },

      expects: [
        {
          service: {
            adapter: 'stripe',
            action: 'checkoutSessionCreated',
            expects: { mode: 'subscription' },
          },
        },
      ],
    },
  ],

  // Test data generators
  testData: {
    songTitle: () => `Test Song ${Date.now()}`,
    artistName: () => `Test Artist ${Math.random().toString(36).slice(2, 8)}`,
    email: () => `test-${Date.now()}@example.com`,
  },

  // Global validators (run at every state)
  validators: {
    accessibility: { enabled: true, rules: ['wcag21aa'] },
    responsive: { enabled: true, minTouchTarget: 44 },
    console: { enabled: true, failOnError: true },
    network: { enabled: true, maxResponseTime: 5000 },
  },

  // Exploration limits
  exploration: {
    maxDepth: 15,
    maxStates: 1000,
    timeout: 10000,
    viewports: ['mobile', 'desktop'],
  },

  // Elements to skip
  ignore: [
    'button:has-text("Logout")',
    'a[href*="logout"]',
    '[data-testid="skip-exploration"]',
  ],
}
```

## Adapter Interface

All service adapters implement this interface:

```typescript
abstract class BaseAdapter {
  abstract name: string

  // Initialize connection
  abstract connect(config: any): Promise<void>

  // Capture current state (for snapshots)
  abstract captureState(): Promise<any>

  // Verify an expectation
  abstract verify(action: string, expects: any): Promise<VerificationResult>

  // Cleanup (optional)
  abstract disconnect(): Promise<void>
}

interface VerificationResult {
  passed: boolean
  message: string
  details?: any
  actual?: any
  expected?: any
}
```

### Supabase Adapter

```typescript
class SupabaseAdapter extends BaseAdapter {
  name = 'supabase'
  private client: SupabaseClient

  async connect(config: SupabaseConfig) {
    this.client = createClient(config.url, config.serviceKey)
  }

  async captureState(): Promise<DatabaseSnapshot> {
    // Get row counts for all tables
    const tables = await this.client.rpc('get_table_stats')
    return { tables }
  }

  async verify(action: string, expects: any): Promise<VerificationResult> {
    switch (action) {
      case 'rowInserted':
        const { data } = await this.client
          .from(expects.table)
          .select('*')
          .match(expects.where)
        return {
          passed: data && data.length > 0,
          message: data?.length
            ? `Found ${data.length} matching rows`
            : `No rows found matching ${JSON.stringify(expects.where)}`,
          actual: data,
        }

      case 'rowDeleted':
        const { data: deleted } = await this.client
          .from(expects.table)
          .select('*')
          .match(expects.where)
        return {
          passed: !deleted || deleted.length === 0,
          message: deleted?.length
            ? `Row still exists`
            : `Row successfully deleted`,
        }

      case 'checkCredits':
        // Check AI credits were decremented
        const { data: profile } = await this.client
          .from('profiles')
          .select('ai_credits_used')
          .single()
        return {
          passed: expects.decremented ? profile.ai_credits_used > 0 : true,
          message: `AI credits used: ${profile.ai_credits_used}`,
        }

      case 'rlsBlocked':
        // Verify RLS blocks unauthorized access
        // ... implementation

      default:
        return { passed: false, message: `Unknown action: ${action}` }
    }
  }
}
```

### Stripe Adapter

```typescript
class StripeAdapter extends BaseAdapter {
  name = 'stripe'
  private stripe: Stripe

  async verify(action: string, expects: any): Promise<VerificationResult> {
    switch (action) {
      case 'checkoutSessionCreated':
        // List recent checkout sessions
        const sessions = await this.stripe.checkout.sessions.list({
          limit: 5,
          created: { gte: Math.floor(Date.now() / 1000) - 60 },
        })
        const matching = sessions.data.find(s =>
          s.mode === expects.mode
        )
        return {
          passed: !!matching,
          message: matching
            ? `Checkout session created: ${matching.id}`
            : `No matching checkout session found`,
        }

      case 'subscriptionActive':
        // Verify subscription status
        // ...

      case 'webhookReceived':
        // Check webhook logs
        // ...
    }
  }
}
```

## Exploration Algorithm

```typescript
async function explore(config: ExplorerConfig): Promise<ExplorationResult> {
  const browser = await chromium.launch()
  const adapters = await initializeAdapters(config.adapters)
  const graph = new StateGraph()
  const queue: ExplorationTask[] = []
  const visited = new Set<string>()

  // Start from each entry point
  for (const url of config.startUrls) {
    queue.push({ url, path: [], depth: 0 })
  }

  while (queue.length > 0) {
    const task = queue.shift()!
    if (task.depth > config.exploration.maxDepth) continue

    for (const viewport of config.exploration.viewports) {
      const page = await browser.newPage()
      await page.setViewportSize(VIEWPORTS[viewport])

      // Navigate and replay path to reach this state
      await page.goto(task.url)
      await replayPath(page, task.path)

      // Capture state (UI + backend)
      const state = await captureState(page, adapters, viewport)
      if (visited.has(state.id)) {
        await page.close()
        continue
      }
      visited.add(state.id)

      // Run all validators
      const issues = await runValidators(page, viewport, config.validators)
      graph.addState(state, issues)

      // Discover possible actions
      const actions = await discoverActions(page, config)

      for (const action of actions) {
        // Find matching schema for this action
        const schema = findMatchingSchema(action, config.actionSchemas)

        // Capture pre-action state
        const preState = await captureBackendState(adapters)

        // Execute setup steps if any
        if (schema?.setup) {
          await executeSetup(page, schema.setup, config.testData)
        }

        try {
          // Perform the action
          await executeAction(page, action)
          await page.waitForLoadState('networkidle')

          // Capture post-action state
          const postState = await captureState(page, adapters, viewport)

          // Verify expectations
          if (schema?.expects) {
            const results = await verifyExpectations(
              schema.expects,
              { preState, postState, page, adapters }
            )
            graph.addTransition(state, postState, action, results)
          } else {
            graph.addTransition(state, postState, action)
          }

          // Queue new state for exploration
          if (!visited.has(postState.id)) {
            queue.push({
              url: page.url(),
              path: [...task.path, action],
              depth: task.depth + 1,
            })
          }

        } catch (error) {
          graph.recordFailure(state, action, error)
        }

        // Backtrack to explore next action
        await page.goto(task.url)
        await replayPath(page, task.path)
      }

      await page.close()
    }
  }

  await browser.close()
  await disconnectAdapters(adapters)

  return {
    graph,
    summary: {
      statesExplored: visited.size,
      actionsPerformed: graph.transitionCount,
      issuesFound: graph.issueCount,
      verificationsPassed: graph.passedCount,
      verificationsFailed: graph.failedCount,
    },
  }
}
```

## Output: Comprehensive Report

The HTML report shows:

### State Graph View
- Interactive graph visualization
- Nodes = states (colored by issue severity)
- Edges = actions (colored by verification result)
- Click to drill down

### Issue Dashboard
- Grouped by type: Accessibility, Responsive, Database, API, Service
- Filtered by severity: Critical, Serious, Moderate, Minor
- Each issue links to state where found

### Verification Results
- Action → Expected → Actual → Pass/Fail
- Database diffs shown inline
- API response comparisons
- Screenshot evidence

### Coverage Report
- % of interactive elements clicked
- % of schema actions verified
- Unreached states/actions
- Suggested additional schemas

## CLI Usage

```bash
# Full exploration with all adapters
ui-explorer http://localhost:5173 \
  --config ./ui-explorer.config.ts \
  --auth ./playwright/.auth/user.json

# Quick accessibility-only scan
ui-explorer http://localhost:5173 --validators accessibility

# Database verification focus
ui-explorer http://localhost:5173 \
  --adapters supabase \
  --supabase-url $SUPABASE_URL \
  --supabase-key $SUPABASE_SERVICE_KEY

# CI mode (JSON output, fail on issues)
ui-explorer http://localhost:5173 \
  --ci \
  --output ./reports/exploration.json \
  --fail-on critical,serious
```

## Development Phases

### Phase 1: Core Framework
- [x] Project setup
- [x] Type definitions
- [x] StateManager
- [x] ActionDiscovery
- [x] Basic Explorer loop
- [x] JSON output

### Phase 2: Validators
- [x] AccessibilityValidator (axe-core)
- [x] ResponsiveValidator
- [x] ConsoleValidator (integrated in Explorer)
- [x] NetworkValidator (integrated in Explorer)

### Phase 3: Adapters
- [x] BaseAdapter interface
- [x] SupabaseAdapter
- [ ] StripeAdapter (optional)
- [ ] Generic REST adapter

### Phase 4: Assertions
- [x] Schema matcher
- [x] Expectation verifier
- [x] Test data templating

### Phase 5: Reporting
- [x] HTML report with graph
- [x] Issue dashboard
- [ ] Playwright test generation

### Phase 6: Polish
- [x] Config file loader
- [x] CLI improvements
- [x] Error recovery
- [ ] Parallel exploration

## Key Differentiators

| Feature | Crawljax | Playwright MCP | UI Explorer |
|---------|----------|----------------|-------------|
| Exhaustive exploration | Yes | No | Yes |
| State machine graph | Yes | No | Yes |
| Database verification | No | No | **Yes** |
| API verification | No | No | **Yes** |
| External service testing | No | No | **Yes** |
| Schema-driven assertions | No | No | **Yes** |
| Accessibility (axe-core) | Plugin | No | **Built-in** |
| Responsive validation | No | No | **Built-in** |
| Playwright test output | No | Yes | Yes |
| TypeScript/modern | No (Java) | Yes | Yes |

## Summary

UI Explorer is a full-stack integration test automation tool that:

1. **Crawls** every UI path exhaustively
2. **Verifies** database changes after each action
3. **Validates** API responses and external services
4. **Checks** accessibility and responsiveness at every state
5. **Reports** comprehensive findings with actionable details
6. **Generates** regression tests for discovered paths

It's like having an entire QA team audit your application in one automated sweep.
