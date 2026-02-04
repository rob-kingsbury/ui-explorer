/**
 * UI Explorer - Core Type Definitions
 *
 * Full-stack integration test explorer types for exhaustive UI crawling
 * with database, API, and external service verification.
 */

import type { Page } from 'playwright'

// ============================================================================
// Viewport & Display
// ============================================================================

export type ViewportName = 'mobile' | 'tablet' | 'desktop'

export interface Viewport {
  name: ViewportName
  width: number
  height: number
}

export const VIEWPORTS: Record<ViewportName, Viewport> = {
  mobile: { name: 'mobile', width: 375, height: 667 },
  tablet: { name: 'tablet', width: 768, height: 1024 },
  desktop: { name: 'desktop', width: 1280, height: 720 },
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Represents the complete state of the application at a point in time.
 * Includes both UI state and backend state captured via adapters.
 */
export interface AppState {
  /** Unique identifier (hash of url + domFingerprint + viewport) */
  id: string

  // UI State
  url: string
  pathname: string
  title: string
  domFingerprint: string
  modalOpen: string | null
  formState?: FormState

  // Backend State (captured via adapters)
  dbSnapshot?: DatabaseSnapshot
  authState?: AuthState

  // Metadata
  viewport: ViewportName
  timestamp: number
  screenshot?: string
}

export interface FormState {
  selector: string
  fields: Record<string, string>
}

export interface DatabaseSnapshot {
  tables: Record<
    string,
    {
      rowCount: number
      checksum?: string
      recentRows?: Record<string, unknown>[]
    }
  >
}

export interface AuthState {
  isAuthenticated: boolean
  userId?: string
  email?: string
  role?: string
}

// ============================================================================
// Actions
// ============================================================================

export type ActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'keypress'
  | 'upload'
  | 'hover'

export interface Action {
  /** Type of interaction */
  type: ActionType

  /** CSS selector for the target element */
  selector: string

  /** Human-readable label (button text, aria-label, etc.) */
  label: string

  /** Value for fill/select/keypress actions */
  value?: string

  /** Element tag name */
  tagName?: string

  /** Element role */
  role?: string

  /** Whether this action is likely destructive */
  destructive?: boolean

  /** Bounding box for visual reference */
  boundingBox?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface DiscoveredAction extends Action {
  /** Whether the element is currently visible */
  visible: boolean

  /** Whether the element is enabled */
  enabled: boolean

  /** Z-index or stacking order */
  zIndex?: number
}

// ============================================================================
// Action Schemas (Expected Side-Effects)
// ============================================================================

export interface ActionSchema {
  /** Matching criteria for this schema */
  match: ActionMatcher

  /** Setup steps to perform before the action */
  setup?: SetupStep[]

  /** Expected side-effects after the action */
  expects?: ActionExpectation[]

  /** Whether this action is destructive (delete, logout, etc.) */
  destructive?: boolean

  /** Follow-up actions (e.g., confirm dialog) */
  followUp?: ActionSchema

  /** Description for reports */
  description?: string
}

export interface ActionMatcher {
  /** Element selector (CSS) */
  selector?: string

  /** Text content (string or regex) */
  text?: string | RegExp

  /** ARIA role */
  role?: string

  /** URL context (only match on this path) */
  context?: string | RegExp

  /** Custom matcher function */
  custom?: (action: Action, page: Page) => boolean | Promise<boolean>
}

export interface SetupStep {
  /** Fill an input */
  fill?: string
  /** Click an element */
  click?: string
  /** Select an option */
  select?: string
  /** Value to fill/select */
  value?: string
  /** Wait for element */
  waitFor?: string
  /** Wait milliseconds */
  delay?: number
  /** Whether this step is optional (don't fail if element not found) */
  optional?: boolean
}

export interface ActionExpectation {
  /** Database expectations */
  database?: DatabaseExpectation

  /** API/Network expectations */
  api?: ApiExpectation

  /** UI expectations */
  ui?: UiExpectation

  /** External service expectations */
  service?: ServiceExpectation
}

export interface DatabaseExpectation {
  /** Table name */
  table: string

  /** Type of change expected */
  change: 'insert' | 'update' | 'delete' | 'unchanged'

  /** Conditions to match (for verification) */
  where?: Record<string, unknown>

  /** Expected row count change */
  count?: number

  /** Column values to verify */
  values?: Record<string, unknown>
}

export interface ApiExpectation {
  /** Endpoint URL or pattern */
  endpoint: string | RegExp

  /** HTTP method */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

  /** Expected status code(s) */
  status?: number | number[]

  /** Response body should contain */
  responseContains?: Record<string, unknown>

  /** Maximum response time (ms) */
  maxResponseTime?: number
}

export interface UiExpectation {
  /** Selectors that should become visible */
  visible?: string[]

  /** Selectors that should become hidden */
  hidden?: string[]

  /** Element -> expected text content */
  text?: Record<string, string | RegExp>

  /** URL should match */
  url?: string | RegExp

  /** Title should match */
  title?: string | RegExp
}

export interface ServiceExpectation {
  /** Adapter name (e.g., 'stripe', 'groq') */
  adapter: string

  /** Action to verify */
  action: string

  /** Adapter-specific expectations */
  expects: Record<string, unknown>
}

// ============================================================================
// Verification Results
// ============================================================================

export interface VerificationResult {
  /** Whether the verification passed */
  passed: boolean

  /** Human-readable message */
  message: string

  /** Type of verification */
  type: 'database' | 'api' | 'ui' | 'service'

  /** Expected value */
  expected?: unknown

  /** Actual value */
  actual?: unknown

  /** Additional details */
  details?: Record<string, unknown>

  /** Time taken (ms) */
  duration?: number
}

export interface ActionResult {
  /** The action that was performed */
  action: Action

  /** State before the action */
  fromState: string

  /** State after the action */
  toState: string

  /** Whether the action succeeded */
  success: boolean

  /** Error if action failed */
  error?: string

  /** Verification results */
  verifications: VerificationResult[]

  /** Time taken (ms) */
  duration: number

  /** Screenshots before/after */
  screenshots?: {
    before?: string
    after?: string
  }
}

// ============================================================================
// State Graph
// ============================================================================

export interface StateTransition {
  fromState: string
  toState: string
  action: Action
  viewport: ViewportName
  verifications: VerificationResult[]
  timestamp: number
}

export interface StateNode {
  state: AppState
  issues: Issue[]
  transitions: StateTransition[]
}

export interface StateGraph {
  states: Map<string, StateNode>
  startStates: string[]
  metadata: {
    startTime: number
    endTime?: number
    config: Partial<ExplorerConfig>
  }
}

// ============================================================================
// Issues & Validation
// ============================================================================

export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor'
export type IssueType =
  | 'accessibility'
  | 'responsive'
  | 'console'
  | 'network'
  | 'database'
  | 'api'
  | 'service'
  | 'functional'

export interface Issue {
  /** Issue type */
  type: IssueType

  /** Severity level */
  severity: IssueSeverity

  /** Rule or check that failed */
  rule: string

  /** Human-readable description */
  description: string

  /** Affected element(s) */
  elements?: string[]

  /** Help URL for more info */
  helpUrl?: string

  /** State where issue was found */
  stateId?: string

  /** Viewport where issue was found */
  viewport?: ViewportName

  /** Additional details */
  details?: Record<string, unknown>
}

// ============================================================================
// Adapters
// ============================================================================

export interface AdapterConfig {
  supabase?: {
    url: string
    serviceKey: string
    anonKey?: string
  }
  stripe?: {
    secretKey: string
    webhookSecret?: string
  }
  groq?: {
    apiKey: string
  }
  // Extensible for custom adapters
  [key: string]: unknown
}

export interface BaseAdapterInterface {
  name: string
  connect(config: unknown): Promise<void>
  captureState(): Promise<unknown>
  verify(action: string, expects: Record<string, unknown>): Promise<VerificationResult>
  disconnect(): Promise<void>
}

// ============================================================================
// Validators
// ============================================================================

export interface ValidatorConfig {
  accessibility?: {
    enabled: boolean
    rules?: string[]
    exclude?: string[]
    /** Axe rules to ignore (e.g., 'color-contrast', 'link-name') */
    ignoredRules?: string[]
  }
  responsive?: {
    enabled: boolean
    checkOverflow?: boolean
    checkTouchTargets?: boolean
    minTouchTarget?: number
  }
  console?: {
    enabled: boolean
    failOnError?: boolean
    failOnWarning?: boolean
    ignorePatterns?: (string | RegExp)[]
  }
  network?: {
    enabled: boolean
    maxResponseTime?: number
    failOnError?: boolean
    ignorePatterns?: (string | RegExp)[]
    /** Resource types to track */
    trackResourceTypes?: ('xhr' | 'fetch' | 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'other')[]
    /** Check for mixed content (HTTP on HTTPS) */
    checkMixedContent?: boolean
  }
  brokenLinks?: {
    enabled: boolean
    /** Check external (off-site) links */
    checkExternal?: boolean
    /** Check internal (same-site) links */
    checkInternal?: boolean
    /** Request timeout in milliseconds */
    timeout?: number
    /** URL patterns to ignore */
    ignorePatterns?: (string | RegExp)[]
    /** Follow redirects and report chains */
    followRedirects?: boolean
  }
}

export interface ValidatorResult {
  validator: string
  issues: Issue[]
  duration: number
}

// ============================================================================
// Test Data
// ============================================================================

export type TestDataGenerator = () => string | number | boolean
export type TestDataValue = string | number | boolean | TestDataGenerator

export interface TestDataConfig {
  [key: string]: TestDataValue
}

// ============================================================================
// Explorer Configuration
// ============================================================================

export interface ExplorerConfig {
  /** Base URL to explore */
  baseUrl: string

  /** Starting URLs (defaults to baseUrl) */
  startUrls?: string[]

  /** Playwright auth storage state */
  auth?: string

  /** Service adapters configuration */
  adapters?: AdapterConfig

  /** Action schemas (expected side-effects) */
  actionSchemas?: ActionSchema[]

  /** Test data generators */
  testData?: TestDataConfig

  /** Validator configuration */
  validators?: ValidatorConfig

  /** Exploration limits */
  exploration?: {
    /** Maximum depth (actions from start) */
    maxDepth?: number
    /** Maximum unique states */
    maxStates?: number
    /** Maximum actions per state */
    maxActionsPerState?: number
    /** Action timeout (ms) */
    timeout?: number
    /** Viewports to test */
    viewports?: ViewportName[]
    /** Wait for network idle after actions */
    waitForNetworkIdle?: boolean
    /** Delay between actions (ms) */
    actionDelay?: number
  }

  /** Selectors to ignore */
  ignore?: string[]

  /** Setup actions (run before exploration) */
  setup?: SetupStep[]

  /** Output configuration */
  output?: {
    /** Output directory */
    dir?: string
    /** Output formats */
    formats?: ('html' | 'json' | 'playwright')[]
    /** Generate Playwright tests */
    generatePlaywrightTests?: boolean
    /** Capture screenshots */
    screenshots?: boolean
    /** Screenshot format */
    screenshotFormat?: 'png' | 'jpeg'
  }

  /** Headless mode */
  headless?: boolean

  /** Browser to use */
  browser?: 'chromium' | 'firefox' | 'webkit'

  /** Cookies to set for authentication */
  cookies?: Array<{ name: string; value: string; url: string }>

  /** Extra HTTP headers to set for authentication */
  extraHTTPHeaders?: Record<string, string>
}

// ============================================================================
// Exploration Results
// ============================================================================

export interface ExplorationTask {
  url: string
  path: Action[]
  depth: number
  viewport: ViewportName
}

export interface ExplorationSummary {
  statesExplored: number
  actionsPerformed: number
  issuesFound: number
  verificationsPassed: number
  verificationsFailed: number
  duration: number
  coverage: {
    urlsCovered: string[]
    actionsDiscovered: number
    actionsExecuted: number
    schemasMatched: number
  }
}

export interface ExplorationResult {
  graph: StateGraph
  summary: ExplorationSummary
  issues: Issue[]
  verifications: VerificationResult[]
}

// ============================================================================
// Reporter Types
// ============================================================================

export interface ReporterOptions {
  outputDir: string
  format: 'html' | 'json' | 'playwright'
  includeScreenshots?: boolean
}

export interface Reporter {
  generate(result: ExplorationResult, options: ReporterOptions): Promise<string>
}

// ============================================================================
// Event Emitter Types (for progress reporting)
// ============================================================================

export type ExplorerEvent =
  | { type: 'start'; config: ExplorerConfig }
  | { type: 'state:discovered'; state: AppState }
  | { type: 'state:visited'; state: AppState; issues: Issue[] }
  | { type: 'action:start'; action: Action; fromState: string }
  | { type: 'action:complete'; result: ActionResult }
  | { type: 'action:error'; action: Action; error: Error }
  | { type: 'validation:complete'; results: ValidatorResult[] }
  | { type: 'progress'; visited: number; queued: number; issues: number }
  | { type: 'complete'; result: ExplorationResult }
  | { type: 'error'; error: Error }
  | { type: 'warning'; message: string }

export type ExplorerEventHandler = (event: ExplorerEvent) => void
