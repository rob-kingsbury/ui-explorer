/**
 * Explorer - Main crawl loop for exhaustive UI exploration
 *
 * Uses BFS to systematically explore all states and actions in a web application,
 * running validators and verifying expectations at each step.
 */

import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright'
import { StateManager } from './StateManager.js'
import { ActionDiscovery } from './ActionDiscovery.js'
import { AdapterRegistry } from '../adapters/BaseAdapter.js'
import { SupabaseAdapter } from '../adapters/SupabaseAdapter.js'
import { AccessibilityValidator } from '../validators/AccessibilityValidator.js'
import { ResponsiveValidator } from '../validators/ResponsiveValidator.js'
import type {
  ExplorerConfig,
  ExplorationResult,
  ExplorationSummary,
  ExplorationTask,
  AppState,
  Action,
  DiscoveredAction,
  ActionSchema,
  ActionExpectation,
  Issue,
  VerificationResult,
  StateGraph,
  StateNode,
  StateTransition,
  ViewportName,
  ExplorerEvent,
  ExplorerEventHandler,
  SetupStep,
} from './types.js'

const DEFAULT_VIEWPORTS: Record<ViewportName, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
}

const DEFAULT_CONFIG: Partial<ExplorerConfig> = {
  exploration: {
    maxDepth: 10,
    maxStates: 500,
    maxActionsPerState: 50,
    timeout: 10000,
    viewports: ['mobile', 'desktop'],
    waitForNetworkIdle: true,
    actionDelay: 100,
  },
  validators: {
    accessibility: { enabled: true, rules: ['wcag21aa'] },
    responsive: { enabled: true, checkOverflow: true, checkTouchTargets: true, minTouchTarget: 44 },
    console: { enabled: true, failOnError: false },
    network: { enabled: true, maxResponseTime: 5000 },
  },
  output: {
    dir: './ui-explorer-reports',
    formats: ['html', 'json'],
    screenshots: true,
    screenshotFormat: 'png',
  },
  headless: true,
  browser: 'chromium',
  ignore: [],
}

export class Explorer {
  private config: ExplorerConfig
  private stateManager: StateManager
  private actionDiscovery: ActionDiscovery
  private adapters: AdapterRegistry
  private accessibilityValidator: AccessibilityValidator
  private responsiveValidator: ResponsiveValidator

  private browser: Browser | null = null
  private context: BrowserContext | null = null

  private graph: StateGraph
  private visited: Set<string> = new Set()
  private queue: ExplorationTask[] = []

  private eventHandlers: ExplorerEventHandler[] = []
  private consoleErrors: Array<{ message: string; url: string }> = []
  private networkErrors: Array<{ url: string; status: number; method: string }> = []

  constructor(config: ExplorerConfig) {
    this.config = this.mergeConfig(config)

    this.stateManager = new StateManager({
      includeQueryParams: true,
      sensitivity: 'medium',
    })

    this.actionDiscovery = new ActionDiscovery({
      ignoreSelectors: this.config.ignore,
      maxActions: this.config.exploration?.maxActionsPerState || 50,
    })

    this.adapters = new AdapterRegistry()

    this.accessibilityValidator = new AccessibilityValidator(
      this.config.validators?.accessibility
    )

    this.responsiveValidator = new ResponsiveValidator(
      this.config.validators?.responsive
    )

    this.graph = {
      states: new Map(),
      startStates: [],
      metadata: {
        startTime: Date.now(),
        config: this.config,
      },
    }
  }

  /**
   * Register an event handler for progress updates
   */
  on(handler: ExplorerEventHandler): void {
    this.eventHandlers.push(handler)
  }

  /**
   * Emit an event to all handlers
   */
  private emit(event: ExplorerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Start the exploration
   */
  async explore(): Promise<ExplorationResult> {
    this.emit({ type: 'start', config: this.config })

    try {
      await this.initialize()

      // Add start URLs to queue
      const startUrls = this.config.startUrls || [this.config.baseUrl]
      for (const url of startUrls) {
        for (const viewport of this.config.exploration?.viewports || ['desktop']) {
          this.queue.push({ url, path: [], depth: 0, viewport })
        }
      }

      // Main exploration loop
      while (this.queue.length > 0) {
        const task = this.queue.shift()!

        // Check limits
        if (task.depth > (this.config.exploration?.maxDepth || 10)) continue
        if (this.visited.size >= (this.config.exploration?.maxStates || 500)) break

        await this.exploreTask(task)

        // Progress update
        this.emit({
          type: 'progress',
          visited: this.visited.size,
          queued: this.queue.length,
          issues: this.getAllIssues().length,
        })
      }

      this.graph.metadata.endTime = Date.now()

      const result = this.buildResult()
      this.emit({ type: 'complete', result })

      return result
    } catch (error) {
      this.emit({ type: 'error', error: error as Error })
      throw error
    } finally {
      await this.cleanup()
    }
  }

  /**
   * Initialize browser and adapters
   */
  private async initialize(): Promise<void> {
    // Launch browser
    const browserType =
      this.config.browser === 'firefox'
        ? firefox
        : this.config.browser === 'webkit'
          ? webkit
          : chromium

    this.browser = await browserType.launch({
      headless: this.config.headless ?? true,
    })

    // Create context with auth if provided
    const contextOptions: Parameters<Browser['newContext']>[0] = {}

    if (this.config.auth) {
      contextOptions.storageState = this.config.auth
    }

    this.context = await this.browser.newContext(contextOptions)

    // Set up console and network error tracking
    this.context.on('console', (msg) => {
      if (msg.type() === 'error') {
        this.consoleErrors.push({
          message: msg.text(),
          url: msg.location().url,
        })
      }
    })

    // Initialize adapters
    if (this.config.adapters?.supabase) {
      const supabaseAdapter = new SupabaseAdapter()
      await supabaseAdapter.connect(this.config.adapters.supabase)
      this.adapters.register(supabaseAdapter)
    }

    // Add more adapters here as implemented
  }

  /**
   * Explore a single task (URL + viewport)
   */
  private async exploreTask(task: ExplorationTask): Promise<void> {
    if (!this.context) return

    const page = await this.context.newPage()

    try {
      // Set viewport
      const viewportSize = DEFAULT_VIEWPORTS[task.viewport]
      await page.setViewportSize(viewportSize)

      // Navigate to URL
      await page.goto(task.url, {
        timeout: this.config.exploration?.timeout || 10000,
        waitUntil: this.config.exploration?.waitForNetworkIdle ? 'networkidle' : 'load',
      })

      // Replay path to reach this state
      await this.replayPath(page, task.path)

      // Capture state
      const state = await this.stateManager.captureState(
        page,
        task.viewport,
        this.adapters.getAll()
      )

      // Check if already visited
      if (this.visited.has(state.id)) {
        return
      }

      this.visited.add(state.id)
      this.emit({ type: 'state:discovered', state })

      // Take screenshot if enabled
      if (this.config.output?.screenshots) {
        const screenshotPath = `${this.config.output.dir || '.'}/screenshots/${state.id}.${this.config.output.screenshotFormat || 'png'}`
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true })
          state.screenshot = screenshotPath
        } catch {
          // Screenshot failed, continue
        }
      }

      // Run validators
      const issues = await this.runValidators(page, task.viewport)

      // Add state to graph
      this.addStateToGraph(state, issues)

      this.emit({ type: 'state:visited', state, issues })

      // Discover actions
      const actions = await this.actionDiscovery.discoverActions(page, this.config.ignore)
      const prioritizedActions = this.actionDiscovery.prioritizeActions(actions)

      // Limit actions per state
      const maxActions = this.config.exploration?.maxActionsPerState || 50
      const actionsToExplore = prioritizedActions.slice(0, maxActions)

      // Explore each action
      for (const action of actionsToExplore) {
        await this.exploreAction(page, state, action, task)
      }
    } catch (error) {
      // Log exploration error but continue
      console.error(`Error exploring ${task.url}:`, error)
    } finally {
      await page.close()
    }
  }

  /**
   * Explore a single action
   */
  private async exploreAction(
    page: Page,
    fromState: AppState,
    action: DiscoveredAction,
    task: ExplorationTask
  ): Promise<void> {
    this.emit({ type: 'action:start', action, fromState: fromState.id })

    const startTime = Date.now()

    try {
      // Find matching schema
      const schema = this.findMatchingSchema(action, page)

      // Capture pre-action backend state
      const preBackendState = await this.adapters.captureAllStates()

      // Execute setup steps if schema has them
      if (schema?.setup) {
        await this.executeSetup(page, schema.setup)
      }

      // Perform the action
      await this.executeAction(page, action)

      // Wait for any async effects
      if (this.config.exploration?.waitForNetworkIdle) {
        await page.waitForLoadState('networkidle').catch(() => {})
      }

      // Small delay for UI to settle
      if (this.config.exploration?.actionDelay) {
        await page.waitForTimeout(this.config.exploration.actionDelay)
      }

      // Capture post-action state
      const toState = await this.stateManager.captureState(
        page,
        task.viewport,
        this.adapters.getAll()
      )

      // Verify expectations
      const verifications: VerificationResult[] = []

      if (schema?.expects) {
        const results = await this.verifyExpectations(schema.expects, page, preBackendState)
        verifications.push(...results)
      }

      // Record transition
      this.addTransitionToGraph(fromState.id, toState.id, action, task.viewport, verifications)

      this.emit({
        type: 'action:complete',
        result: {
          action,
          fromState: fromState.id,
          toState: toState.id,
          success: true,
          verifications,
          duration: Date.now() - startTime,
        },
      })

      // Queue new state for exploration if not visited
      if (!this.visited.has(toState.id)) {
        this.queue.push({
          url: page.url(),
          path: [...task.path, action],
          depth: task.depth + 1,
          viewport: task.viewport,
        })
      }

      // Backtrack to original state
      await page.goto(task.url, { waitUntil: 'load' })
      await this.replayPath(page, task.path)
    } catch (error) {
      this.emit({ type: 'action:error', action, error: error as Error })

      // Try to recover by navigating back
      try {
        await page.goto(task.url, { waitUntil: 'load' })
        await this.replayPath(page, task.path)
      } catch {
        // Recovery failed
      }
    }
  }

  /**
   * Execute an action on the page
   */
  private async executeAction(page: Page, action: Action): Promise<void> {
    const timeout = this.config.exploration?.timeout || 10000
    const locator = page.locator(action.selector).first()

    // Wait for element to be visible and enabled
    await locator.waitFor({ state: 'visible', timeout })

    switch (action.type) {
      case 'click':
        await locator.click({ timeout })
        break

      case 'fill':
        await locator.fill(action.value || '', { timeout })
        break

      case 'select':
        await locator.selectOption(action.value || '', { timeout })
        break

      case 'check':
        await locator.check({ timeout })
        break

      case 'uncheck':
        await locator.uncheck({ timeout })
        break

      case 'hover':
        await locator.hover({ timeout })
        break

      case 'keypress':
        await locator.press(action.value || 'Enter', { timeout })
        break

      default:
        await locator.click({ timeout })
    }
  }

  /**
   * Replay a path of actions to reach a state
   */
  private async replayPath(page: Page, path: Action[]): Promise<void> {
    for (const action of path) {
      try {
        await this.executeAction(page, action)
        await page.waitForTimeout(100) // Small delay between actions
      } catch {
        // Action failed during replay, continue
        break
      }
    }
  }

  /**
   * Execute setup steps before an action
   */
  private async executeSetup(page: Page, steps: SetupStep[]): Promise<void> {
    for (const step of steps) {
      try {
        if (step.delay) {
          await page.waitForTimeout(step.delay)
        }

        if (step.waitFor) {
          await page.waitForSelector(step.waitFor, { timeout: 5000 })
        }

        if (step.click) {
          await page.click(step.click, { timeout: 5000 })
        }

        if (step.fill) {
          const value = this.resolveTestData(step.value || '')
          await page.fill(step.fill, value, { timeout: 5000 })
        }

        if (step.select) {
          const value = this.resolveTestData(step.value || '')
          await page.selectOption(step.select, value, { timeout: 5000 })
        }
      } catch (error) {
        if (!step.optional) {
          throw error
        }
      }
    }
  }

  /**
   * Find a matching action schema
   */
  private findMatchingSchema(action: Action, page: Page): ActionSchema | undefined {
    if (!this.config.actionSchemas) return undefined

    for (const schema of this.config.actionSchemas) {
      const match = schema.match

      // Check selector
      if (match.selector && !action.selector.includes(match.selector)) continue

      // Check text
      if (match.text) {
        const pattern = typeof match.text === 'string' ? new RegExp(match.text, 'i') : match.text
        if (!pattern.test(action.label)) continue
      }

      // Check role
      if (match.role && action.role !== match.role) continue

      // Check context (URL)
      if (match.context) {
        const url = page.url()
        const pattern =
          typeof match.context === 'string' ? new RegExp(match.context) : match.context
        if (!pattern.test(url)) continue
      }

      return schema
    }

    return undefined
  }

  /**
   * Verify expectations after an action
   */
  private async verifyExpectations(
    expects: ActionExpectation[],
    page: Page,
    _preBackendState: Record<string, unknown>
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = []

    for (const expectation of expects) {
      // Database expectations
      if (expectation.database) {
        const adapter = this.adapters.get('supabase')
        if (adapter) {
          const result = await adapter.verify(
            expectation.database.change,
            expectation.database as unknown as Record<string, unknown>
          )
          results.push(result)
        }
      }

      // UI expectations
      if (expectation.ui) {
        const uiResults = await this.verifyUiExpectations(page, expectation.ui)
        results.push(...uiResults)
      }

      // API expectations
      if (expectation.api) {
        // API verification would check network requests
        // This requires capturing requests during action execution
        results.push({
          passed: true,
          message: 'API verification not yet implemented',
          type: 'api',
        })
      }

      // Service expectations
      if (expectation.service) {
        const adapter = this.adapters.get(expectation.service.adapter)
        if (adapter) {
          const result = await adapter.verify(
            expectation.service.action,
            expectation.service.expects
          )
          results.push(result)
        }
      }
    }

    return results
  }

  /**
   * Verify UI expectations
   */
  private async verifyUiExpectations(
    page: Page,
    ui: NonNullable<ActionExpectation['ui']>
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = []

    // Check visible elements
    if (ui.visible) {
      for (const selector of ui.visible) {
        try {
          const isVisible = await page.locator(selector).first().isVisible()
          results.push({
            passed: isVisible,
            message: isVisible
              ? `Element ${selector} is visible`
              : `Element ${selector} is not visible`,
            type: 'ui',
            expected: 'visible',
            actual: isVisible ? 'visible' : 'hidden',
          })
        } catch {
          results.push({
            passed: false,
            message: `Element ${selector} not found`,
            type: 'ui',
          })
        }
      }
    }

    // Check hidden elements
    if (ui.hidden) {
      for (const selector of ui.hidden) {
        try {
          const isVisible = await page.locator(selector).first().isVisible()
          results.push({
            passed: !isVisible,
            message: isVisible
              ? `Element ${selector} is still visible`
              : `Element ${selector} is hidden`,
            type: 'ui',
            expected: 'hidden',
            actual: isVisible ? 'visible' : 'hidden',
          })
        } catch {
          // Element not found = hidden
          results.push({
            passed: true,
            message: `Element ${selector} is not present`,
            type: 'ui',
          })
        }
      }
    }

    // Check URL
    if (ui.url) {
      const currentUrl = page.url()
      const pattern = typeof ui.url === 'string' ? new RegExp(ui.url) : ui.url
      const matches = pattern.test(currentUrl)
      results.push({
        passed: matches,
        message: matches ? `URL matches ${ui.url}` : `URL ${currentUrl} does not match ${ui.url}`,
        type: 'ui',
        expected: ui.url.toString(),
        actual: currentUrl,
      })
    }

    return results
  }

  /**
   * Run all validators on the current page
   */
  private async runValidators(page: Page, viewport: ViewportName): Promise<Issue[]> {
    const issues: Issue[] = []

    // Accessibility
    if (this.config.validators?.accessibility?.enabled) {
      const result = await this.accessibilityValidator.validate(page, viewport)
      issues.push(...result.issues)
      this.emit({ type: 'validation:complete', results: [result] })
    }

    // Responsive
    if (this.config.validators?.responsive?.enabled) {
      const result = await this.responsiveValidator.validate(page, viewport)
      issues.push(...result.issues)
      this.emit({ type: 'validation:complete', results: [result] })
    }

    // Console errors
    if (this.config.validators?.console?.enabled && this.consoleErrors.length > 0) {
      for (const error of this.consoleErrors) {
        // Check ignore patterns
        const ignorePatterns = this.config.validators.console.ignorePatterns || []
        const shouldIgnore = ignorePatterns.some((pattern) => {
          const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
          return regex.test(error.message)
        })

        if (!shouldIgnore) {
          issues.push({
            type: 'console',
            severity: this.config.validators.console.failOnError ? 'serious' : 'moderate',
            rule: 'no-console-errors',
            description: `Console error: ${error.message.slice(0, 200)}`,
            viewport,
            details: { message: error.message, url: error.url },
          })
        }
      }
      this.consoleErrors = [] // Clear after reporting
    }

    return issues
  }

  /**
   * Add a state to the graph
   */
  private addStateToGraph(state: AppState, issues: Issue[]): void {
    const node: StateNode = {
      state,
      issues,
      transitions: [],
    }

    this.graph.states.set(state.id, node)

    // Track start states
    if (this.graph.states.size === 1) {
      this.graph.startStates.push(state.id)
    }
  }

  /**
   * Add a transition to the graph
   */
  private addTransitionToGraph(
    fromState: string,
    toState: string,
    action: Action,
    viewport: ViewportName,
    verifications: VerificationResult[]
  ): void {
    const transition: StateTransition = {
      fromState,
      toState,
      action,
      viewport,
      verifications,
      timestamp: Date.now(),
    }

    const node = this.graph.states.get(fromState)
    if (node) {
      node.transitions.push(transition)
    }
  }

  /**
   * Get all issues from the graph
   */
  private getAllIssues(): Issue[] {
    const issues: Issue[] = []

    for (const node of this.graph.states.values()) {
      issues.push(...node.issues)
    }

    return issues
  }

  /**
   * Get all verifications from the graph
   */
  private getAllVerifications(): VerificationResult[] {
    const verifications: VerificationResult[] = []

    for (const node of this.graph.states.values()) {
      for (const transition of node.transitions) {
        verifications.push(...transition.verifications)
      }
    }

    return verifications
  }

  /**
   * Build the final result
   */
  private buildResult(): ExplorationResult {
    const issues = this.getAllIssues()
    const verifications = this.getAllVerifications()

    const summary: ExplorationSummary = {
      statesExplored: this.graph.states.size,
      actionsPerformed: Array.from(this.graph.states.values()).reduce(
        (sum, node) => sum + node.transitions.length,
        0
      ),
      issuesFound: issues.length,
      verificationsPassed: verifications.filter((v) => v.passed).length,
      verificationsFailed: verifications.filter((v) => !v.passed).length,
      duration: (this.graph.metadata.endTime || Date.now()) - this.graph.metadata.startTime,
      coverage: {
        urlsCovered: [...new Set(Array.from(this.graph.states.values()).map((n) => n.state.url))],
        actionsDiscovered: 0, // Would need to track this
        actionsExecuted: Array.from(this.graph.states.values()).reduce(
          (sum, node) => sum + node.transitions.length,
          0
        ),
        schemasMatched: 0, // Would need to track this
      },
    }

    return {
      graph: this.graph,
      summary,
      issues,
      verifications,
    }
  }

  /**
   * Resolve test data placeholders
   */
  private resolveTestData(value: string): string {
    if (!this.config.testData) return value

    return value.replace(/\{\{testData\.(\w+)\}\}/g, (match, key) => {
      const generator = this.config.testData?.[key]
      if (typeof generator === 'function') {
        return String(generator())
      }
      if (generator !== undefined) {
        return String(generator)
      }
      return match
    })
  }

  /**
   * Merge user config with defaults
   */
  private mergeConfig(config: ExplorerConfig): ExplorerConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      exploration: {
        ...DEFAULT_CONFIG.exploration,
        ...config.exploration,
      },
      validators: {
        ...DEFAULT_CONFIG.validators,
        ...config.validators,
      },
      output: {
        ...DEFAULT_CONFIG.output,
        ...config.output,
      },
    } as ExplorerConfig
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    await this.adapters.disconnectAll()

    if (this.context) {
      await this.context.close()
      this.context = null
    }

    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }
}
