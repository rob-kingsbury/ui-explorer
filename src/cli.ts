#!/usr/bin/env node
/**
 * EVA - Explore, Validate, Analyze
 *
 * Zero-config UI testing that crawls your app and finds accessibility,
 * responsive, and functional issues.
 *
 * Quick Start:
 *   npx eva-qa http://localhost:3000
 *
 * Preset Modes:
 *   npx eva-qa quick http://localhost:3000       # Fast scan (3 depth, a11y + responsive)
 *   npx eva-qa a11y http://localhost:3000        # Accessibility only
 *   npx eva-qa responsive http://localhost:3000  # Responsive issues only
 *   npx eva-qa links http://localhost:3000       # Find broken and stale links
 *   npx eva-qa full http://localhost:3000        # Full exploration with all checks
 *
 * With Authentication:
 *   npx eva-qa http://localhost:3000 --auth ./auth.json
 *
 * With Database Verification:
 *   npx eva-qa http://localhost:3000 --supabase-url $URL --supabase-key $KEY
 */

// =============================================================================
// Node Version Check (before any ES modules that might fail on old Node)
// =============================================================================
const MIN_NODE_VERSION = 18
const currentVersion = parseInt(process.versions.node.split('.')[0], 10)

if (currentVersion < MIN_NODE_VERSION) {
  console.error('')
  console.error(`\x1b[31mError: EVA requires Node.js ${MIN_NODE_VERSION} or higher.\x1b[0m`)
  console.error(`You are running Node.js ${process.versions.node}.`)
  console.error('')
  console.error('To fix this:')
  console.error('  1. Update Node.js: https://nodejs.org/')
  console.error('  2. Or use nvm: nvm install 18 && nvm use 18')
  console.error('')
  process.exit(1)
}

import { program } from 'commander'
import chalk from 'chalk'
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { resolve, dirname, isAbsolute, normalize } from 'path'
import { fileURLToPath } from 'url'
import { Explorer } from './core/Explorer.js'
import type { ExplorerConfig, ExplorerEvent, ViewportName, Issue } from './core/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// =============================================================================
// Security: URL and Path Validation
// =============================================================================
const ALLOWED_PROTOCOLS = ['http:', 'https:']

/**
 * Validate URL is safe to navigate to
 */
function validateUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(`Invalid URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`)
    }
    if (parsed.username || parsed.password) {
      throw new Error('URLs with embedded credentials are not allowed.')
    }
  } catch (e) {
    if ((e as Error).message.includes('Invalid URL')) {
      throw new Error(`Invalid URL: ${url}`)
    }
    throw e
  }
}

/**
 * Validate output path is safe (no path traversal)
 */
function validateOutputPath(outputDir: string, cwd: string): string {
  const resolved = isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir)
  const normalized = normalize(resolved)
  if (!normalized.startsWith(cwd) && !isAbsolute(outputDir)) {
    throw new Error(`Output directory must be within the current working directory. Got: ${outputDir}`)
  }
  return normalized
}

/**
 * Parse JSON config file safely (no code execution)
 * SEC-001 FIX: Use JSON.parse instead of dynamic import
 */
function loadJsonConfig(configPath: string): Partial<ExplorerConfig> {
  const content = readFileSync(configPath, 'utf-8')
  const config = JSON.parse(content)

  // Convert string patterns to RegExp in actionSchemas
  if (config.actionSchemas) {
    for (const schema of config.actionSchemas) {
      if (schema.match?.text && typeof schema.match.text === 'string') {
        schema.match.text = new RegExp(schema.match.text, 'i')
      }
      if (schema.match?.context && typeof schema.match.context === 'string') {
        schema.match.context = new RegExp(schema.match.context)
      }
      // Custom matchers (functions) not supported in JSON config for security
      if (schema.match?.custom) {
        delete schema.match.custom
        console.warn(chalk.yellow('Warning: custom matchers are not supported in JSON config files.'))
      }
    }
  }
  return config
}

// =============================================================================
// Friendly Error Messages
// =============================================================================
const FRIENDLY_ERRORS: Record<string, { message: string; tip: string }> = {
  'Timeout': {
    message: 'Connection timed out',
    tip: 'Make sure your app is running at the specified URL. Try: npm run dev',
  },
  'net::ERR_CONNECTION_REFUSED': {
    message: 'Could not connect to the server',
    tip: 'The server is not running. Start your development server first.',
  },
  'net::ERR_NAME_NOT_RESOLVED': {
    message: 'Could not resolve hostname',
    tip: 'Check the URL for typos. For local development, use http://localhost:PORT',
  },
  'ECONNREFUSED': {
    message: 'Connection refused',
    tip: 'The server is not accepting connections. Is your app running?',
  },
  'storageState': {
    message: 'Authentication file not found or invalid',
    tip: 'Check that your auth file exists and is valid JSON.',
  },
}

function getFriendlyError(error: Error): { message: string; tip?: string } {
  const errorStr = error.message || String(error)
  for (const [pattern, friendly] of Object.entries(FRIENDLY_ERRORS)) {
    if (errorStr.includes(pattern)) {
      return friendly
    }
  }
  return { message: errorStr }
}

// Read package.json for version
let version = '0.1.0'
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'))
  version = pkg.version
} catch {
  // Ignore
}

// =============================================================================
// Preset Configurations - The key to simplicity
// =============================================================================

interface Preset {
  name: string
  description: string
  exploration: {
    maxDepth: number
    maxStates: number
    viewports: ViewportName[]
  }
  validators: {
    accessibility: boolean
    responsive: boolean
    console: boolean
    network: boolean
    brokenLinks: boolean
  }
}

const PRESETS: Record<string, Preset> = {
  quick: {
    name: 'Quick Scan',
    description: 'Fast accessibility + responsive check (3 depth, 50 states)',
    exploration: {
      maxDepth: 3,
      maxStates: 50,
      viewports: ['mobile', 'desktop'],
    },
    validators: {
      accessibility: true,
      responsive: true,
      console: true,
      network: false,
      brokenLinks: false,
    },
  },
  a11y: {
    name: 'Accessibility',
    description: 'WCAG 2.1 AA accessibility scan only',
    exploration: {
      maxDepth: 5,
      maxStates: 100,
      viewports: ['desktop'],
    },
    validators: {
      accessibility: true,
      responsive: false,
      console: false,
      network: false,
      brokenLinks: false,
    },
  },
  responsive: {
    name: 'Responsive',
    description: 'Mobile/tablet/desktop overflow and touch target check',
    exploration: {
      maxDepth: 5,
      maxStates: 100,
      viewports: ['mobile', 'tablet', 'desktop'],
    },
    validators: {
      accessibility: false,
      responsive: true,
      console: false,
      network: false,
      brokenLinks: false,
    },
  },
  links: {
    name: 'Link Check',
    description: 'Find broken and stale links (5 depth, 100 states)',
    exploration: {
      maxDepth: 5,
      maxStates: 100,
      viewports: ['desktop'],
    },
    validators: {
      accessibility: false,
      responsive: false,
      console: false,
      network: true,
      brokenLinks: true,
    },
  },
  full: {
    name: 'Full Exploration',
    description: 'Complete exploration with all validators (10 depth, 500 states)',
    exploration: {
      maxDepth: 10,
      maxStates: 500,
      viewports: ['mobile', 'desktop'],
    },
    validators: {
      accessibility: true,
      responsive: true,
      console: true,
      network: true,
      brokenLinks: true,
    },
  },
}

// =============================================================================
// Main Program
// =============================================================================

program
  .name('eva-qa')
  .description('EVA - Explore, Validate, Analyze. Zero-config UI testing.')
  .version(version)

// Default command - just pass a URL
program
  .argument('[url]', 'URL to explore (default: http://localhost:3000)')
  .option('-m, --mode <preset>', 'Preset mode: quick, a11y, responsive, full', 'quick')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--headless', 'Run in headless mode', true)
  .option('--no-headless', 'Show browser window')
  .option('--ci', 'CI mode - exit 1 on critical/serious issues')
  .option('--depth <n>', 'Override max depth')
  .option('--states <n>', 'Override max states')
  .option('--viewports <list>', 'Override viewports (mobile,tablet,desktop)')
  .option('--ignore <selectors>', 'CSS selectors to ignore (comma-separated)')
  .option('--timeout <ms>', 'Timeout for page loads and actions (default: 10000)')
  .option('--zoom <levels>', 'Test at zoom levels (e.g., "100,150,200" for 100%, 150%, 200%)')
  .option('--cookie <cookie...>', 'Set cookies for authentication (name=value), can be repeated')
  .option('--header <header...>', 'Set headers for authentication (Name: value), can be repeated')
  .option('-f, --format <formats>', 'Output formats: html,json,junit (comma-separated)', 'html,json')
  .option('--score', 'Show compliance score in output')
  .option('--ignore-rules <rules>', 'Axe rules to ignore (comma-separated, e.g., "color-contrast,link-name")')
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('-q, --quiet', 'Minimal output')
  .option('-v, --verbose', 'Detailed output')
  .action(runExplorer)

// Subcommands for preset modes (cleaner syntax)
program
  .command('quick [url]')
  .description('Quick scan - fast a11y + responsive check')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication (can be repeated)')
  .option('--header <header...>', 'Set headers for authentication (can be repeated)')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-f, --format <formats>', 'Output formats: html,json,junit')
  .option('--score', 'Show compliance score')
  .option('--ci', 'CI mode')
  .action((url, options, command) => runExplorer(url, { ...command.optsWithGlobals(), mode: 'quick' }))

program
  .command('a11y [url]')
  .alias('accessibility')
  .description('Accessibility scan - WCAG 2.1 AA validation')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication (can be repeated)')
  .option('--header <header...>', 'Set headers for authentication (can be repeated)')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-f, --format <formats>', 'Output formats: html,json,junit')
  .option('--score', 'Show compliance score')
  .option('--ci', 'CI mode')
  .action((url, options, command) => runExplorer(url, { ...command.optsWithGlobals(), mode: 'a11y' }))

program
  .command('responsive [url]')
  .description('Responsive check - overflow and touch targets')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication (can be repeated)')
  .option('--header <header...>', 'Set headers for authentication (can be repeated)')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-f, --format <formats>', 'Output formats: html,json,junit')
  .option('--score', 'Show compliance score')
  .option('--ci', 'CI mode')
  .action((url, options, command) => runExplorer(url, { ...command.optsWithGlobals(), mode: 'responsive' }))

program
  .command('full [url]')
  .description('Full exploration - all validators, deep crawl')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication (can be repeated)')
  .option('--header <header...>', 'Set headers for authentication (can be repeated)')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-f, --format <formats>', 'Output formats: html,json,junit')
  .option('--score', 'Show compliance score')
  .option('--ci', 'CI mode')
  .action((url, options, command) => {
    // Use optsWithGlobals() to include parent program options (like --auth)
    runExplorer(url, { ...command.optsWithGlobals(), mode: 'full' })
  })

program
  .command('links [url]')
  .description('Link check - find broken and stale links')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication (can be repeated)')
  .option('--header <header...>', 'Set headers for authentication (can be repeated)')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-f, --format <formats>', 'Output formats: html,json,junit')
  .option('--score', 'Show compliance score')
  .option('--ci', 'CI mode')
  .option('--external', 'Check external links (default: true)')
  .option('--no-external', 'Skip external link checking')
  .action((url, options, command) => {
    runExplorer(url, { ...command.optsWithGlobals(), mode: 'links' })
  })

// =============================================================================
// Baseline & Regression Tracking Commands
// =============================================================================

program
  .command('baseline [url]')
  .description('Run exploration and save result as baseline for future comparisons')
  .option('-m, --mode <preset>', 'Preset mode: quick, a11y, responsive, full', 'quick')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication')
  .option('--header <header...>', 'Set headers for authentication')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-n, --name <name>', 'Name for this baseline (default: timestamp)')
  .option('-q, --quiet', 'Minimal output')
  .action(async (url, options, command) => {
    await runBaseline(url, command.optsWithGlobals())
  })

program
  .command('compare [url]')
  .description('Run exploration and compare against baseline to find regressions')
  .option('-m, --mode <preset>', 'Preset mode: quick, a11y, responsive, full', 'quick')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .option('--cookie <cookie...>', 'Set cookies for authentication')
  .option('--header <header...>', 'Set headers for authentication')
  .option('--timeout <ms>', 'Timeout in milliseconds')
  .option('-b, --baseline <name>', 'Baseline name to compare against (default: latest)')
  .option('--ci', 'CI mode - exit 1 on regressions')
  .option('-q, --quiet', 'Minimal output')
  .action(async (url, options, command) => {
    await runCompare(url, command.optsWithGlobals())
  })

program
  .command('baselines')
  .description('List all saved baselines')
  .option('-o, --output <dir>', 'Output directory', './eva-qa-reports')
  .action(listBaselines)

// =============================================================================
// Run Explorer
// =============================================================================

async function runExplorer(
  url: string | undefined,
  options: Record<string, unknown>
): Promise<void> {
  try {
    const baseUrl = url || 'http://localhost:3000'
    const preset = PRESETS[options.mode as string] || PRESETS.quick
    const cwd = process.cwd()

    // SEC-006: Validate URL protocol and format
    validateUrl(baseUrl)

    // SEC-002: Validate output path
    const outputDir = validateOutputPath(options.output as string || './eva-qa-reports', cwd)

    if (!options.quiet) {
      console.log()
      console.log(chalk.bold.cyan('EVA'), chalk.gray(`v${version}`), chalk.gray('- Explore, Validate, Analyze'))
      console.log(chalk.gray('─'.repeat(50)))
      console.log(chalk.white('URL:'), baseUrl)
      console.log(chalk.white('Mode:'), `${preset.name} - ${preset.description}`)
      console.log(chalk.gray('─'.repeat(50)))
      console.log()
    }

    // SEC-001 FIX: Load JSON config file safely (no code execution)
    let fileConfig: Partial<ExplorerConfig> = {}
    if (options.config) {
      const configPath = resolve(cwd, options.config as string)
      if (existsSync(configPath)) {
        try {
          // Only support JSON config files for security
          if (!configPath.endsWith('.json')) {
            console.error(chalk.yellow(`Warning: Config file must be JSON. Got: ${configPath}`))
            console.error(chalk.gray('Tip: Rename your config to eva.config.json'))
          } else {
            fileConfig = loadJsonConfig(configPath)
            if (!options.quiet) {
              console.log(chalk.gray(`Loaded config: ${configPath}`))
            }
          }
        } catch (e) {
          console.error(chalk.yellow(`Warning: Could not parse ${configPath}: ${(e as Error).message}`))
        }
      } else {
        console.error(chalk.yellow(`Warning: Config file not found: ${configPath}`))
      }
    }

    // SEC-003: Read Supabase credentials from environment variables
    const supabaseUrl = process.env.SUPABASE_URL || process.env.EVA_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.EVA_SUPABASE_KEY

    // Parse timeout option
    const timeout = options.timeout
      ? parseInt(options.timeout as string, 10)
      : fileConfig.exploration?.timeout || 10000

    // Parse cookie options (name=value format, supports multiple)
    let cookies: Array<{ name: string; value: string; url: string }> | undefined
    if (options.cookie) {
      const cookieArray = Array.isArray(options.cookie) ? options.cookie : [options.cookie]
      cookies = []
      for (const cookieStr of cookieArray as string[]) {
        const [name, ...valueParts] = cookieStr.split('=')
        const value = valueParts.join('=') // Handle values with = in them
        if (name && value) {
          cookies.push({ name: name.trim(), value: value.trim(), url: baseUrl })
        } else {
          console.warn(chalk.yellow(`Warning: Invalid cookie format "${cookieStr}". Use: --cookie "name=value"`))
        }
      }
      if (cookies.length === 0) cookies = undefined
    }

    // Parse header options (Name: value format, supports multiple)
    let extraHTTPHeaders: Record<string, string> | undefined
    if (options.header) {
      const headerArray = Array.isArray(options.header) ? options.header : [options.header]
      extraHTTPHeaders = {}
      for (const headerStr of headerArray as string[]) {
        const [name, ...valueParts] = headerStr.split(':')
        const value = valueParts.join(':').trim()
        if (name && value) {
          extraHTTPHeaders[name.trim()] = value
        } else {
          console.warn(chalk.yellow(`Warning: Invalid header format "${headerStr}". Use: --header "Authorization: Bearer token"`))
        }
      }
      if (Object.keys(extraHTTPHeaders).length === 0) extraHTTPHeaders = undefined
    }

    // Parse output formats
    const outputFormats = ((options.format as string) || 'html,json')
      .split(',')
      .map(f => f.trim().toLowerCase())
      .filter(f => ['html', 'json', 'junit'].includes(f)) as ('html' | 'json' | 'junit')[]

    // Build config from preset + overrides
    const config: ExplorerConfig = {
      baseUrl,
      auth: (options.auth as string) || fileConfig.auth,

      exploration: {
        maxDepth: options.depth
          ? parseInt(options.depth as string, 10)
          : preset.exploration.maxDepth,
        maxStates: options.states
          ? parseInt(options.states as string, 10)
          : preset.exploration.maxStates,
        maxActionsPerState: 50,
        timeout,
        viewports: options.viewports
          ? (options.viewports as string).split(',') as ViewportName[]
          : preset.exploration.viewports,
        waitForNetworkIdle: true,
        actionDelay: 100,
        ...fileConfig.exploration,
      },

      validators: {
        accessibility: {
          enabled: preset.validators.accessibility,
          rules: ['wcag21aa'],
          ignoredRules: options.ignoreRules
            ? (options.ignoreRules as string).split(',').map(r => r.trim())
            : fileConfig.validators?.accessibility?.ignoredRules || [],
          ...fileConfig.validators?.accessibility,
        },
        responsive: {
          enabled: preset.validators.responsive,
          checkOverflow: true,
          checkTouchTargets: true,
          minTouchTarget: 44,
          ...fileConfig.validators?.responsive,
        },
        console: {
          enabled: preset.validators.console,
          failOnError: false,
          ...fileConfig.validators?.console,
        },
        network: {
          enabled: preset.validators.network,
          maxResponseTime: 3000,
          checkMixedContent: true,
          ...fileConfig.validators?.network,
        },
        brokenLinks: {
          enabled: preset.validators.brokenLinks,
          checkExternal: options.external !== false,
          checkInternal: true,
          timeout: 5000,
          ...fileConfig.validators?.brokenLinks,
        },
      },

      // SEC-003: Use environment variables for Supabase credentials
      adapters: supabaseUrl && supabaseKey
        ? {
            supabase: {
              url: supabaseUrl,
              serviceKey: supabaseKey,
            },
          }
        : fileConfig.adapters,

      actionSchemas: fileConfig.actionSchemas,
      testData: fileConfig.testData,

      ignore: options.ignore
        ? (options.ignore as string).split(',')
        : fileConfig.ignore || [],

      output: {
        dir: outputDir,
        formats: ['html', 'json'],
        screenshots: true,
        screenshotFormat: 'png',
        ...fileConfig.output,
      },

      headless: options.headless as boolean,
      browser: fileConfig.browser || 'chromium',

      // New: Cookie and header authentication
      cookies,
      extraHTTPHeaders,
    }

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
    if (!existsSync(`${outputDir}/screenshots`)) {
      mkdirSync(`${outputDir}/screenshots`, { recursive: true })
    }

    // Create and run explorer
    const explorer = new Explorer(config)

    if (!options.quiet) {
      explorer.on(createProgressHandler(options.verbose as boolean))
    }

    if (!options.quiet) {
      console.log(chalk.yellow('Exploring...'))
      console.log()
    }

    const startTime = Date.now()
    const result = await explorer.explore()

    // Run zoom level testing if requested
    if (options.zoom) {
      const zoomLevels = (options.zoom as string).split(',').map(z => parseInt(z.trim(), 10)).filter(z => z > 0)
      if (zoomLevels.length > 0 && !options.quiet) {
        console.log(chalk.yellow(`Testing zoom levels: ${zoomLevels.join('%, ')}%...`))
      }
      const zoomIssues = await runZoomTesting(config, zoomLevels, options.quiet as boolean)
      result.issues.push(...zoomIssues)
      result.summary.issuesFound = result.issues.length
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)

    // Calculate compliance score
    const score = calculateComplianceScore(result)

    // Print results
    printResults(result, duration, options.quiet as boolean, options.score as boolean, score)

    // Write reports
    writeReports(result, outputDir, outputFormats, options.quiet as boolean, score)

    // CI mode exit
    if (options.ci) {
      const hasCritical = result.issues.some(
        (i) => i.severity === 'critical' || i.severity === 'serious'
      )
      if (hasCritical) {
        console.log(chalk.red('\nCI: Failing due to critical/serious issues'))
        process.exit(1)
      }
    }
  } catch (error) {
    // Convert to friendly error message
    const friendly = getFriendlyError(error as Error)
    console.error()
    console.error(chalk.red('Error:'), friendly.message)
    if (friendly.tip) {
      console.error(chalk.gray('Tip:'), friendly.tip)
    }
    if (options.verbose) {
      console.error()
      console.error(chalk.gray('Stack trace:'))
      console.error(chalk.gray((error as Error).stack))
    } else {
      console.error(chalk.gray('Run with --verbose for more details'))
    }
    process.exit(1)
  }
}

// =============================================================================
// Compliance Score Calculation
// =============================================================================

interface ComplianceScore {
  /** Overall percentage (0-100) */
  overall: number
  /** Accessibility score */
  accessibility: number
  /** Responsive score */
  responsive: number
  /** Network score (includes broken links) */
  network: number
  /** Grade (A, B, C, D, F) */
  grade: string
  /** Human-readable summary */
  summary: string
}

/**
 * Calculate compliance score based on issues found
 * Scoring: critical issues = -20pts, serious = -10pts, moderate = -5pts, minor = -2pts
 * Base score is 100, minimum is 0
 */
function calculateComplianceScore(result: import('./core/types.js').ExplorationResult): ComplianceScore {
  const { issues, summary } = result

  // Weight by severity
  const weights = { critical: 20, serious: 10, moderate: 5, minor: 2 }

  // Calculate deductions per type
  let a11yDeductions = 0
  let responsiveDeductions = 0
  let networkDeductions = 0
  let totalDeductions = 0

  for (const issue of issues) {
    const weight = weights[issue.severity] || 2
    totalDeductions += weight
    if (issue.type === 'accessibility') {
      a11yDeductions += weight
    } else if (issue.type === 'responsive') {
      responsiveDeductions += weight
    } else if (issue.type === 'network') {
      networkDeductions += weight
    }
  }

  // Scale deductions by states explored (more states = issues spread out)
  const stateScale = Math.max(1, summary.statesExplored / 10)
  const scaledDeductions = totalDeductions / stateScale
  const scaledA11y = a11yDeductions / stateScale
  const scaledResponsive = responsiveDeductions / stateScale
  const scaledNetwork = networkDeductions / stateScale

  // Calculate scores (0-100)
  const overall = Math.max(0, Math.min(100, Math.round(100 - scaledDeductions)))
  const accessibility = Math.max(0, Math.min(100, Math.round(100 - scaledA11y)))
  const responsive = Math.max(0, Math.min(100, Math.round(100 - scaledResponsive)))
  const network = Math.max(0, Math.min(100, Math.round(100 - scaledNetwork)))

  // Determine grade
  let grade: string
  if (overall >= 90) grade = 'A'
  else if (overall >= 80) grade = 'B'
  else if (overall >= 70) grade = 'C'
  else if (overall >= 60) grade = 'D'
  else grade = 'F'

  // Generate summary
  const critical = issues.filter(i => i.severity === 'critical').length
  const serious = issues.filter(i => i.severity === 'serious').length

  let summary_text: string
  if (overall === 100) {
    summary_text = 'Excellent! No issues found.'
  } else if (overall >= 90) {
    summary_text = 'Great! Minor improvements recommended.'
  } else if (overall >= 70) {
    summary_text = `Good baseline. ${critical + serious} critical/serious issues to address.`
  } else {
    summary_text = `Needs work. ${critical} critical, ${serious} serious issues found.`
  }

  return { overall, accessibility, responsive, network, grade, summary: summary_text }
}

// =============================================================================
// Output Helpers
// =============================================================================

function printResults(
  result: import('./core/types.js').ExplorationResult,
  duration: string,
  quiet: boolean,
  showScore: boolean,
  score: ComplianceScore
): void {
  if (quiet) {
    // Minimal output for scripts
    console.log(
      JSON.stringify({
        states: result.summary.statesExplored,
        actions: result.summary.actionsPerformed,
        issues: result.summary.issuesFound,
        duration: parseFloat(duration),
        score: score.overall,
        grade: score.grade,
      })
    )
    return
  }

  console.log()
  console.log(chalk.gray('─'.repeat(50)))
  console.log(chalk.bold.green('✓ Exploration Complete'))
  console.log(chalk.gray('─'.repeat(50)))
  console.log()

  // Summary stats
  console.log(chalk.white('States explored:'), result.summary.statesExplored)
  console.log(chalk.white('Actions performed:'), result.summary.actionsPerformed)
  console.log(chalk.white('Duration:'), `${duration}s`)
  console.log()

  // Compliance score (always show if requested, or if issues found)
  if (showScore || result.issues.length > 0) {
    const scoreColor = score.overall >= 90 ? chalk.green
      : score.overall >= 70 ? chalk.yellow
      : chalk.red
    console.log(chalk.bold('Compliance Score:'), scoreColor(`${score.overall}% (${score.grade})`))
    if (result.issues.some(i => i.type === 'accessibility')) {
      console.log(chalk.gray(`  Accessibility: ${score.accessibility}%`))
    }
    if (result.issues.some(i => i.type === 'responsive')) {
      console.log(chalk.gray(`  Responsive: ${score.responsive}%`))
    }
    if (result.issues.some(i => i.type === 'network')) {
      console.log(chalk.gray(`  Network/Links: ${score.network}%`))
    }
    console.log(chalk.gray(`  ${score.summary}`))
    console.log()
  }

  // Issues by severity
  const critical = result.issues.filter((i) => i.severity === 'critical').length
  const serious = result.issues.filter((i) => i.severity === 'serious').length
  const moderate = result.issues.filter((i) => i.severity === 'moderate').length
  const minor = result.issues.filter((i) => i.severity === 'minor').length

  if (result.issues.length === 0) {
    console.log(chalk.green('No issues found!'))
  } else {
    console.log(chalk.bold('Issues:'))
    if (critical > 0) console.log(chalk.red(`  ${critical} critical`))
    if (serious > 0) console.log(chalk.yellow(`  ${serious} serious`))
    if (moderate > 0) console.log(chalk.blue(`  ${moderate} moderate`))
    if (minor > 0) console.log(chalk.gray(`  ${minor} minor`))
  }

  // Verifications (only if adapters were used)
  if (result.verifications.length > 0) {
    console.log()
    console.log(chalk.bold('Verifications:'))
    console.log(chalk.green(`  ${result.summary.verificationsPassed} passed`))
    if (result.summary.verificationsFailed > 0) {
      console.log(chalk.red(`  ${result.summary.verificationsFailed} failed`))
    }
  }

  console.log()
}

function writeReports(
  result: import('./core/types.js').ExplorationResult,
  outputDir: string,
  formats: ('html' | 'json' | 'junit')[],
  quiet: boolean,
  score: ComplianceScore
): void {
  const writtenFiles: string[] = []

  // JSON report
  if (formats.includes('json')) {
    const jsonPath = `${outputDir}/report.json`
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          summary: result.summary,
          score: {
            overall: score.overall,
            accessibility: score.accessibility,
            responsive: score.responsive,
            network: score.network,
            grade: score.grade,
            summary: score.summary,
          },
          issues: result.issues,
          verifications: result.verifications,
          states: Array.from(result.graph.states.values()).map((node) => ({
            id: node.state.id,
            url: node.state.url,
            title: node.state.title,
            viewport: node.state.viewport,
            issueCount: node.issues.length,
          })),
        },
        null,
        2
      )
    )
    writtenFiles.push('report.json - Machine-readable')
  }

  // HTML report
  if (formats.includes('html')) {
    const htmlPath = `${outputDir}/report.html`
    writeFileSync(htmlPath, generateHtmlReport(result, score))
    writtenFiles.push('report.html - Visual report')
  }

  // JUnit XML report (for CI integration)
  if (formats.includes('junit')) {
    const junitPath = `${outputDir}/report.xml`
    writeFileSync(junitPath, generateJunitReport(result, score))
    writtenFiles.push('report.xml - JUnit XML for CI')
  }

  if (!quiet && writtenFiles.length > 0) {
    console.log(chalk.gray(`Reports: ${outputDir}/`))
    for (const file of writtenFiles) {
      console.log(chalk.gray(`  ${file}`))
    }
  }
}

/**
 * Generate JUnit XML report for CI integration
 * Compatible with Jenkins, GitLab CI, CircleCI, Azure DevOps
 */
function generateJunitReport(
  result: import('./core/types.js').ExplorationResult,
  score: ComplianceScore
): string {
  const { issues, summary } = result
  const timestamp = new Date().toISOString()

  // Group issues by type (each type becomes a test suite)
  const issuesByType: Record<string, typeof issues> = {}
  for (const issue of issues) {
    if (!issuesByType[issue.type]) {
      issuesByType[issue.type] = []
    }
    issuesByType[issue.type].push(issue)
  }

  // Calculate totals
  const totalTests = summary.statesExplored
  const failures = issues.filter(i => i.severity === 'critical' || i.severity === 'serious').length
  const errors = 0 // We don't have "errors" in our model

  // Build XML
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="EVA UI Testing" tests="${totalTests}" failures="${failures}" errors="${errors}" time="${(summary.duration / 1000).toFixed(3)}" timestamp="${timestamp}">
  <!-- Compliance Score: ${score.overall}% (${score.grade}) -->
`

  // Add a test suite for each issue type
  for (const [type, typeIssues] of Object.entries(issuesByType)) {
    const suiteFailures = typeIssues.filter(i => i.severity === 'critical' || i.severity === 'serious').length
    const suiteTime = (summary.duration / Object.keys(issuesByType).length / 1000).toFixed(3)

    xml += `  <testsuite name="${escapeXml(type)}" tests="${typeIssues.length}" failures="${suiteFailures}" errors="0" time="${suiteTime}">
`

    for (const issue of typeIssues) {
      const testName = `${issue.rule}`
      const className = `eva.${type}.${issue.severity}`
      const isFailed = issue.severity === 'critical' || issue.severity === 'serious'

      xml += `    <testcase name="${escapeXml(testName)}" classname="${escapeXml(className)}" time="0.001">
`

      if (isFailed) {
        xml += `      <failure message="${escapeXml(issue.description)}" type="${escapeXml(issue.severity)}">
Rule: ${escapeXml(issue.rule)}
Severity: ${escapeXml(issue.severity)}
Description: ${escapeXml(issue.description)}
${issue.elements ? `Elements: ${issue.elements.map(e => escapeXml(e)).join(', ')}` : ''}
${issue.helpUrl ? `Help: ${escapeXml(issue.helpUrl)}` : ''}
${issue.stateId ? `State: ${escapeXml(issue.stateId)}` : ''}
      </failure>
`
      }

      xml += `    </testcase>
`
    }

    xml += `  </testsuite>
`
  }

  // Add a summary test suite if no issues
  if (Object.keys(issuesByType).length === 0) {
    xml += `  <testsuite name="accessibility" tests="1" failures="0" errors="0" time="${(summary.duration / 1000).toFixed(3)}">
    <testcase name="no-issues-found" classname="eva.summary" time="0.001" />
  </testsuite>
`
  }

  xml += `</testsuites>
`

  return xml
}

/**
 * Escape special characters for XML
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function createProgressHandler(verbose: boolean): (event: ExplorerEvent) => void {
  let lastProgress = 0

  return (event: ExplorerEvent) => {
    switch (event.type) {
      case 'state:discovered':
        if (verbose) {
          console.log(chalk.green('+'), chalk.gray(event.state.url))
        }
        break

      case 'state:visited':
        if (verbose && event.issues.length > 0) {
          console.log(
            chalk.yellow('!'),
            `${event.issues.length} issue(s) at`,
            chalk.gray(event.state.url)
          )
        }
        break

      case 'action:complete':
        if (verbose) {
          const status = event.result.success ? chalk.green('✓') : chalk.red('✗')
          console.log(status, chalk.gray(event.result.action.label.slice(0, 50)))
        }
        break

      case 'progress':
        if (event.visited - lastProgress >= 5) {
          lastProgress = event.visited
          process.stdout.write(
            `\r${chalk.cyan('Progress:')} ${event.visited} states, ${event.queued} queued`
          )
        }
        break

      case 'complete':
        process.stdout.write('\r' + ' '.repeat(60) + '\r')
        break
    }
  }
}

// =============================================================================
// User-Impact Descriptions
// =============================================================================

/**
 * Maps technical issue rules to plain English user-impact descriptions.
 * These help non-technical stakeholders understand WHY issues matter.
 */
const USER_IMPACT_DESCRIPTIONS: Record<string, string> = {
  // Accessibility - Color & Vision
  'color-contrast': 'People with low vision or color blindness may not be able to read this text.',
  'link-in-text-block': 'Links that only differ by color are invisible to colorblind users.',

  // Accessibility - Images
  'image-alt': 'Screen reader users won\'t know what this image shows.',
  'image-redundant-alt': 'Screen readers will read confusing duplicate descriptions.',
  'input-image-alt': 'Screen reader users won\'t know what this button does.',
  'object-alt': 'Screen reader users won\'t know what this embedded content is.',
  'svg-img-alt': 'Screen reader users won\'t know what this icon or graphic represents.',

  // Accessibility - Forms
  'label': 'Screen reader users won\'t know what information to enter in this field.',
  'form-field-multiple-labels': 'Screen readers may announce confusing or conflicting labels.',
  'select-name': 'Screen reader users won\'t know what this dropdown is for.',
  'autocomplete-valid': 'Browsers can\'t autofill this field, making forms harder to complete.',

  // Accessibility - Structure
  'heading-order': 'Screen reader users use headings to navigate - skipped levels are confusing.',
  'page-has-heading-one': 'Screen reader users expect a main heading to understand the page purpose.',
  'landmark-one-main': 'Screen reader users can\'t quickly jump to the main content.',
  'region': 'Screen reader users may have trouble understanding the page structure.',
  'bypass': 'Keyboard users have to tab through every element to reach main content.',

  // Accessibility - Interactive Elements
  'button-name': 'Screen reader users won\'t know what this button does.',
  'link-name': 'Screen reader users won\'t know where this link goes.',
  'aria-required-children': 'Screen readers may not announce this component correctly.',
  'aria-required-parent': 'Screen readers may not announce this component correctly.',
  'aria-valid-attr': 'Screen readers may misinterpret or ignore this element.',
  'aria-valid-attr-value': 'Screen readers may misinterpret this element\'s state.',
  'aria-hidden-focus': 'Keyboard users may get stuck on an invisible element.',

  // Accessibility - Keyboard
  'focus-order-semantics': 'Keyboard users may encounter a confusing tab order.',
  'focusable-disabled': 'Keyboard users may try to interact with disabled elements.',
  'tabindex': 'Keyboard users may encounter unexpected navigation order.',

  // Accessibility - Tables
  'td-headers-attr': 'Screen reader users won\'t understand how table data relates to headers.',
  'th-has-data-cells': 'Screen reader users won\'t understand the table structure.',
  'table-fake-caption': 'Screen reader users may miss the table\'s purpose.',

  // Responsive
  'horizontal-overflow': 'Mobile users will need to scroll horizontally to see all content.',
  'touch-target-size': 'Mobile users may have difficulty tapping this element accurately.',
  'viewport-zoom': 'Users who need to zoom in won\'t be able to enlarge the text.',
  'zoom-overflow': 'Users who zoom in for better visibility will see content cut off or overlapping.',
  'zoom-text-truncation': 'Users who zoom in will see truncated text that may hide important information.',
  'zoom-interactive-overlap': 'Users who zoom in may not be able to click buttons or links due to overlapping elements.',

  // Console/Network
  'console-error': 'Users may experience broken functionality or see error messages.',
  'network-error': 'Users may see missing content or broken features.',
  'slow-response': 'Users may experience frustrating delays.',
}

/**
 * Get user-impact description for an issue
 */
function getUserImpact(rule: string): string | undefined {
  return USER_IMPACT_DESCRIPTIONS[rule]
}

/**
 * Quick fix suggestions for common issues
 */
const QUICK_FIX_SUGGESTIONS: Record<string, string> = {
  'image-alt': 'Add alt="" to decorative images, or descriptive alt text to meaningful images.',
  'color-contrast': 'Increase text color darkness or background lightness to achieve 4.5:1 ratio.',
  'button-name': 'Add text content, aria-label, or aria-labelledby to the button.',
  'link-name': 'Add text content or aria-label to the link.',
  'label': 'Add a <label> element with a "for" attribute matching the input id.',
  'heading-order': 'Ensure headings follow a logical order (h1 → h2 → h3, no skipping).',
  'touch-target-size': 'Increase button/link padding to ensure at least 44x44px touch area.',
  'horizontal-overflow': 'Use max-width: 100% on images and overflow-x: hidden on containers.',
}

/**
 * Generate Quick Wins section for overwhelmed users
 */
function generateQuickWinsSection(issues: Issue[]): string {
  if (issues.length === 0) return ''

  // Prioritize: critical first, then serious, then by commonality
  const criticalSerious = issues.filter(i => i.severity === 'critical' || i.severity === 'serious')

  // Group by rule and count
  const ruleCount: Record<string, { count: number; issue: Issue }> = {}
  for (const issue of criticalSerious) {
    if (!ruleCount[issue.rule]) {
      ruleCount[issue.rule] = { count: 0, issue }
    }
    ruleCount[issue.rule].count++
  }

  // Sort by impact (critical first) then count
  const sortedRules = Object.entries(ruleCount)
    .sort((a, b) => {
      const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 }
      const aSeverity = severityOrder[a[1].issue.severity]
      const bSeverity = severityOrder[b[1].issue.severity]
      if (aSeverity !== bSeverity) return aSeverity - bSeverity
      return b[1].count - a[1].count
    })
    .slice(0, 5) // Top 5 quick wins

  if (sortedRules.length === 0) {
    // No critical/serious issues - show moderate ones
    const moderate = issues.filter(i => i.severity === 'moderate').slice(0, 3)
    if (moderate.length === 0) return ''

    return `
    <div class="quick-wins">
      <h2>👍 Looking Good!</h2>
      <p class="quick-wins-intro">No critical or serious issues found. Here are some optional improvements:</p>
      ${moderate.map((issue, i) => `
        <div class="quick-win">
          <div class="quick-win-header">
            <span class="quick-win-number">${i + 1}</span>
            <span class="quick-win-title">${escapeHtml(issue.rule)}</span>
          </div>
          <div class="quick-win-desc">${escapeHtml(issue.description)}</div>
        </div>
      `).join('')}
    </div>`
  }

  return `
    <div class="quick-wins">
      <h2>🎯 Start Here - Top ${sortedRules.length} Quick Wins</h2>
      <p class="quick-wins-intro">Fix these first for the biggest impact. Each fix addresses multiple issues.</p>
      ${sortedRules.map(([rule, data], i) => {
        const fix = QUICK_FIX_SUGGESTIONS[rule] || 'See the help link for fix instructions.'
        const userImpact = getUserImpact(rule)
        return `
        <div class="quick-win">
          <div class="quick-win-header">
            <span class="quick-win-number">${i + 1}</span>
            <span class="quick-win-title">${escapeHtml(rule)}</span>
            <span class="badge ${escapeHtml(data.issue.severity)}">${data.count} occurrence${data.count > 1 ? 's' : ''}</span>
          </div>
          <div class="quick-win-desc">
            <strong>Fix:</strong> ${escapeHtml(fix)}
            ${userImpact ? `<br><strong>Why:</strong> ${escapeHtml(userImpact)}` : ''}
          </div>
        </div>
      `}).join('')}
    </div>`
}

// =============================================================================
// HTML Report Generator
// =============================================================================

function generateHtmlReport(
  result: import('./core/types.js').ExplorationResult,
  score: ComplianceScore
): string {
  const { summary, issues } = result

  const issuesByType: Record<string, typeof issues> = {}
  for (const issue of issues) {
    if (!issuesByType[issue.type]) {
      issuesByType[issue.type] = []
    }
    issuesByType[issue.type].push(issue)
  }

  // Determine score color class
  const scoreColorClass = score.overall >= 90 ? 'success' : score.overall >= 70 ? 'warning' : 'danger'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EVA Report - ${score.grade} (${score.overall}%)</title>
  <style>
    :root {
      --bg: #0f0f10;
      --surface: #1a1a1d;
      --text: #e4e4e7;
      --text-muted: #71717a;
      --primary: #3b82f6;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --border: #27272a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.125rem; margin: 2rem 0 1rem; color: var(--text-muted); }
    .meta { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 2rem; }
    .score-card {
      background: var(--surface);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 2rem;
    }
    .score-circle {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }
    .score-circle.success { background: linear-gradient(135deg, #22c55e33, #22c55e11); border: 3px solid var(--success); }
    .score-circle.warning { background: linear-gradient(135deg, #f59e0b33, #f59e0b11); border: 3px solid var(--warning); }
    .score-circle.danger { background: linear-gradient(135deg, #ef444433, #ef444411); border: 3px solid var(--danger); }
    .score-value { font-size: 1.75rem; }
    .score-grade { font-size: 0.875rem; color: var(--text-muted); }
    .score-details { flex: 1; }
    .score-summary { font-size: 1.125rem; margin-bottom: 0.5rem; }
    .score-breakdown { color: var(--text-muted); font-size: 0.875rem; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin: 1.5rem 0;
    }
    .stat {
      background: var(--surface);
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
    }
    .stat-value { font-size: 1.75rem; font-weight: 600; }
    .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; }
    .stat.success .stat-value { color: var(--success); }
    .stat.warning .stat-value { color: var(--warning); }
    .stat.danger .stat-value { color: var(--danger); }
    .issues { margin-top: 1rem; }
    .issue {
      background: var(--surface);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 0.75rem;
      border-left: 3px solid var(--border);
    }
    .issue.critical { border-left-color: var(--danger); }
    .issue.serious { border-left-color: var(--warning); }
    .issue.moderate { border-left-color: var(--primary); }
    .issue-header { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
    .issue-rule { font-weight: 500; }
    .badge {
      font-size: 0.625rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .badge.critical { background: var(--danger); }
    .badge.serious { background: var(--warning); color: #000; }
    .badge.moderate { background: var(--primary); }
    .badge.minor { background: var(--text-muted); }
    .issue-desc { color: var(--text-muted); font-size: 0.875rem; margin-top: 0.5rem; }
    .issue-impact { background: var(--bg); border-radius: 4px; padding: 0.5rem 0.75rem; margin-top: 0.5rem; font-size: 0.8125rem; color: var(--text); border-left: 2px solid var(--warning); }
    .issue-impact::before { content: "User impact: "; font-weight: 500; color: var(--warning); }
    .issue-elements { font-family: monospace; font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem; }
    .issue-elements code { background: var(--bg); padding: 0.125rem 0.375rem; border-radius: 3px; }
    .empty { text-align: center; padding: 3rem; color: var(--success); }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .quick-wins {
      background: linear-gradient(135deg, #3b82f622, #3b82f611);
      border: 1px solid var(--primary);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 1.5rem 0;
    }
    .quick-wins h2 {
      color: var(--primary);
      margin: 0 0 1rem;
      font-size: 1rem;
    }
    .quick-wins-intro {
      color: var(--text-muted);
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .quick-win {
      background: var(--surface);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 0.75rem;
    }
    .quick-win:last-child { margin-bottom: 0; }
    .quick-win-header { display: flex; align-items: center; gap: 0.5rem; }
    .quick-win-number {
      background: var(--primary);
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .quick-win-title { font-weight: 500; }
    .quick-win-desc { color: var(--text-muted); font-size: 0.875rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>EVA Report</h1>
    <p class="meta">Generated ${new Date().toLocaleString()}</p>

    <div class="score-card">
      <div class="score-circle ${scoreColorClass}">
        <div class="score-value">${score.overall}%</div>
        <div class="score-grade">Grade ${score.grade}</div>
      </div>
      <div class="score-details">
        <div class="score-summary">${escapeHtml(score.summary)}</div>
        <div class="score-breakdown">
          ${score.accessibility < 100 ? `Accessibility: ${score.accessibility}% · ` : ''}
          ${score.responsive < 100 ? `Responsive: ${score.responsive}%` : ''}
        </div>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${summary.statesExplored}</div>
        <div class="stat-label">States</div>
      </div>
      <div class="stat">
        <div class="stat-value">${summary.actionsPerformed}</div>
        <div class="stat-label">Actions</div>
      </div>
      <div class="stat ${summary.issuesFound > 0 ? 'warning' : 'success'}">
        <div class="stat-value">${summary.issuesFound}</div>
        <div class="stat-label">Issues</div>
      </div>
      <div class="stat">
        <div class="stat-value">${(summary.duration / 1000).toFixed(1)}s</div>
        <div class="stat-label">Duration</div>
      </div>
    </div>

    ${issues.length === 0 ? '<div class="empty">✓ No issues found</div>' : ''}

    ${generateQuickWinsSection(issues)}

    ${Object.entries(issuesByType)
      .map(
        ([type, typeIssues]) => `
      <h2>${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))} Issues (${typeIssues.length})</h2>
      <div class="issues">
        ${typeIssues
          .slice(0, 25)
          .map(
            (issue) => {
              const userImpact = getUserImpact(issue.rule)
              return `
          <div class="issue ${escapeHtml(issue.severity)}">
            <div class="issue-header">
              <span class="issue-rule">${escapeHtml(issue.rule)}</span>
              <span class="badge ${escapeHtml(issue.severity)}">${escapeHtml(issue.severity)}</span>
            </div>
            <div class="issue-desc">${escapeHtml(issue.description)}</div>
            ${userImpact ? `<div class="issue-impact">${escapeHtml(userImpact)}</div>` : ''}
            ${
              issue.elements && issue.elements.length > 0
                ? `<div class="issue-elements">${issue.elements
                    .slice(0, 2)
                    .map((e) => `<code>${escapeHtml(e)}</code>`)
                    .join(' ')}</div>`
                : ''
            }
            ${issue.helpUrl ? `<a href="${escapeHtml(validateHelpUrl(issue.helpUrl))}" target="_blank" rel="noopener noreferrer">Learn more →</a>` : ''}
          </div>
        `
            }
          )
          .join('')}
        ${typeIssues.length > 25 ? `<p style="color: var(--text-muted); text-align: center;">+ ${typeIssues.length - 25} more</p>` : ''}
      </div>
    `
      )
      .join('')}
  </div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * SEC-004: Validate help URLs are from trusted sources
 */
const TRUSTED_HELP_DOMAINS = [
  'dequeuniversity.com',
  'www.w3.org',
  'developer.mozilla.org',
  'web.dev',
  'accessibility.digital.gov',
]

function validateHelpUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Only allow https URLs from trusted domains
    if (parsed.protocol !== 'https:') {
      return ''
    }
    const isTrusted = TRUSTED_HELP_DOMAINS.some(
      domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    )
    return isTrusted ? url : ''
  } catch {
    return ''
  }
}

// =============================================================================
// Baseline & Regression Tracking
// =============================================================================

interface Baseline {
  name: string
  timestamp: string
  url: string
  mode: string
  score: ComplianceScore
  issues: Issue[]
  summary: {
    statesExplored: number
    actionsPerformed: number
    issuesFound: number
  }
}

interface ComparisonResult {
  baseline: Baseline
  current: {
    score: ComplianceScore
    issues: Issue[]
    summary: {
      statesExplored: number
      actionsPerformed: number
      issuesFound: number
    }
  }
  regressions: Issue[]     // New issues not in baseline
  fixed: Issue[]           // Issues in baseline but not in current
  unchanged: Issue[]       // Issues in both
  scoreDelta: number       // Score change (positive = improvement)
}

/**
 * Run exploration and save as baseline
 */
async function runBaseline(
  url: string | undefined,
  options: Record<string, unknown>
): Promise<void> {
  const baseUrl = url || 'http://localhost:3000'
  const cwd = process.cwd()
  const outputDir = validateOutputPath(options.output as string || './eva-qa-reports', cwd)
  const baselineDir = `${outputDir}/baselines`

  // Validate URL
  validateUrl(baseUrl)

  // Run exploration
  const result = await runExplorerAndGetResult(baseUrl, options)
  if (!result) {
    process.exit(1)
  }

  const score = calculateComplianceScore(result)

  // Create baseline name
  const baselineName = (options.name as string) || new Date().toISOString().replace(/[:.]/g, '-')

  // Save baseline
  const baseline: Baseline = {
    name: baselineName,
    timestamp: new Date().toISOString(),
    url: baseUrl,
    mode: (options.mode as string) || 'quick',
    score,
    issues: result.issues,
    summary: {
      statesExplored: result.summary.statesExplored,
      actionsPerformed: result.summary.actionsPerformed,
      issuesFound: result.summary.issuesFound,
    },
  }

  if (!existsSync(baselineDir)) {
    mkdirSync(baselineDir, { recursive: true })
  }

  const baselinePath = `${baselineDir}/${baselineName}.json`
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2))

  if (!options.quiet) {
    console.log()
    console.log(chalk.gray('─'.repeat(50)))
    console.log(chalk.bold.green('✓ Baseline Saved'))
    console.log(chalk.gray('─'.repeat(50)))
    console.log()
    console.log(chalk.white('Name:'), baselineName)
    console.log(chalk.white('Score:'), `${score.overall}% (${score.grade})`)
    console.log(chalk.white('Issues:'), result.summary.issuesFound)
    console.log(chalk.white('Path:'), baselinePath)
    console.log()
    console.log(chalk.gray('Run'), chalk.cyan('eva compare'), chalk.gray('to check for regressions.'))
  }
}

/**
 * Run exploration and compare against baseline
 */
async function runCompare(
  url: string | undefined,
  options: Record<string, unknown>
): Promise<void> {
  const baseUrl = url || 'http://localhost:3000'
  const cwd = process.cwd()
  const outputDir = validateOutputPath(options.output as string || './eva-qa-reports', cwd)
  const baselineDir = `${outputDir}/baselines`

  // Validate URL
  validateUrl(baseUrl)

  // Load baseline
  const baselineName = options.baseline as string
  const baseline = loadBaseline(baselineDir, baselineName)

  if (!baseline) {
    console.error(chalk.red('Error:'), 'No baseline found.')
    console.error(chalk.gray('Tip:'), 'Run', chalk.cyan('eva baseline <url>'), 'first to create one.')
    process.exit(1)
  }

  if (!options.quiet) {
    console.log()
    console.log(chalk.bold.cyan('EVA'), chalk.gray(`v${version}`), chalk.gray('- Comparing against baseline'))
    console.log(chalk.gray('─'.repeat(50)))
    console.log(chalk.white('URL:'), baseUrl)
    console.log(chalk.white('Baseline:'), baseline.name, chalk.gray(`(${baseline.timestamp})`))
    console.log(chalk.gray('─'.repeat(50)))
    console.log()
  }

  // Run exploration
  const result = await runExplorerAndGetResult(baseUrl, options)
  if (!result) {
    process.exit(1)
  }

  const score = calculateComplianceScore(result)

  // Compare results
  const comparison = compareResults(baseline, result, score)

  // Print comparison
  printComparison(comparison, options.quiet as boolean)

  // Write comparison report
  writeComparisonReport(comparison, outputDir, options.quiet as boolean)

  // CI mode - fail on regressions
  if (options.ci && comparison.regressions.length > 0) {
    console.log(chalk.red('\nCI: Failing due to regressions'))
    process.exit(1)
  }
}

/**
 * List all saved baselines
 */
function listBaselines(options: Record<string, unknown>): void {
  const cwd = process.cwd()
  const outputDir = validateOutputPath(options.output as string || './eva-qa-reports', cwd)
  const baselineDir = `${outputDir}/baselines`

  if (!existsSync(baselineDir)) {
    console.log(chalk.yellow('No baselines found.'))
    console.log(chalk.gray('Run'), chalk.cyan('eva baseline <url>'), chalk.gray('to create one.'))
    return
  }

  const files = readdirSync(baselineDir).filter(f => f.endsWith('.json'))

  if (files.length === 0) {
    console.log(chalk.yellow('No baselines found.'))
    return
  }

  console.log()
  console.log(chalk.bold('Saved Baselines:'))
  console.log(chalk.gray('─'.repeat(50)))

  for (const file of files.sort().reverse()) {
    try {
      const baseline = JSON.parse(readFileSync(`${baselineDir}/${file}`, 'utf-8')) as Baseline
      const scoreColor = baseline.score.overall >= 90 ? chalk.green
        : baseline.score.overall >= 70 ? chalk.yellow
        : chalk.red

      console.log(
        chalk.white(baseline.name),
        chalk.gray('-'),
        scoreColor(`${baseline.score.overall}% (${baseline.score.grade})`),
        chalk.gray(`- ${baseline.summary.issuesFound} issues`)
      )
      console.log(chalk.gray(`  ${baseline.timestamp} - ${baseline.url}`))
    } catch {
      console.log(chalk.gray(file), chalk.red('(corrupted)'))
    }
  }

  console.log()
}

/**
 * Load baseline by name (or latest if no name specified)
 */
function loadBaseline(baselineDir: string, name?: string): Baseline | null {
  if (!existsSync(baselineDir)) {
    return null
  }

  const files = readdirSync(baselineDir).filter(f => f.endsWith('.json'))

  if (files.length === 0) {
    return null
  }

  let targetFile: string

  if (name) {
    // Look for specific baseline
    targetFile = files.find(f => f === `${name}.json` || f.startsWith(name)) || ''
    if (!targetFile) {
      console.error(chalk.yellow(`Baseline "${name}" not found.`))
      console.error(chalk.gray('Available baselines:'), files.map(f => f.replace('.json', '')).join(', '))
      return null
    }
  } else {
    // Use latest baseline (sorted by filename which includes timestamp)
    targetFile = files.sort().reverse()[0]
  }

  try {
    return JSON.parse(readFileSync(`${baselineDir}/${targetFile}`, 'utf-8')) as Baseline
  } catch (e) {
    console.error(chalk.red('Error reading baseline:'), (e as Error).message)
    return null
  }
}

/**
 * Compare current results against baseline
 */
function compareResults(
  baseline: Baseline,
  result: import('./core/types.js').ExplorationResult,
  score: ComplianceScore
): ComparisonResult {
  const currentIssues = result.issues

  // Create fingerprints for comparison (rule + elements)
  const getFingerprint = (issue: Issue): string => {
    const elements = (issue.elements || []).sort().join('|')
    return `${issue.type}:${issue.rule}:${elements}`
  }

  const baselineFingerprints = new Set(baseline.issues.map(getFingerprint))
  const currentFingerprints = new Set(currentIssues.map(getFingerprint))

  // Find regressions (new issues not in baseline)
  const regressions = currentIssues.filter(issue => !baselineFingerprints.has(getFingerprint(issue)))

  // Find fixed issues (in baseline but not current)
  const fixed = baseline.issues.filter(issue => !currentFingerprints.has(getFingerprint(issue)))

  // Find unchanged issues (in both)
  const unchanged = currentIssues.filter(issue => baselineFingerprints.has(getFingerprint(issue)))

  const scoreDelta = score.overall - baseline.score.overall

  return {
    baseline,
    current: {
      score,
      issues: currentIssues,
      summary: {
        statesExplored: result.summary.statesExplored,
        actionsPerformed: result.summary.actionsPerformed,
        issuesFound: result.summary.issuesFound,
      },
    },
    regressions,
    fixed,
    unchanged,
    scoreDelta,
  }
}

/**
 * Print comparison results to console
 */
function printComparison(comparison: ComparisonResult, quiet: boolean): void {
  if (quiet) {
    console.log(JSON.stringify({
      regressions: comparison.regressions.length,
      fixed: comparison.fixed.length,
      unchanged: comparison.unchanged.length,
      scoreDelta: comparison.scoreDelta,
      currentScore: comparison.current.score.overall,
      baselineScore: comparison.baseline.score.overall,
    }))
    return
  }

  console.log()
  console.log(chalk.gray('─'.repeat(50)))
  console.log(chalk.bold('Comparison Results'))
  console.log(chalk.gray('─'.repeat(50)))
  console.log()

  // Score change
  const scoreColor = comparison.scoreDelta >= 0 ? chalk.green : chalk.red
  const scoreArrow = comparison.scoreDelta > 0 ? '↑' : comparison.scoreDelta < 0 ? '↓' : '→'
  console.log(
    chalk.bold('Score:'),
    `${comparison.baseline.score.overall}%`,
    scoreColor(`${scoreArrow} ${comparison.current.score.overall}%`),
    chalk.gray(`(${comparison.scoreDelta > 0 ? '+' : ''}${comparison.scoreDelta}%)`)
  )
  console.log()

  // Summary
  if (comparison.regressions.length === 0 && comparison.fixed.length === 0) {
    console.log(chalk.green('✓ No changes from baseline'))
  } else {
    if (comparison.fixed.length > 0) {
      console.log(chalk.green(`✓ ${comparison.fixed.length} issue(s) fixed`))
    }
    if (comparison.regressions.length > 0) {
      console.log(chalk.red(`✗ ${comparison.regressions.length} new issue(s) (regressions)`))
    }
    if (comparison.unchanged.length > 0) {
      console.log(chalk.gray(`  ${comparison.unchanged.length} issue(s) unchanged`))
    }
  }

  // List regressions
  if (comparison.regressions.length > 0) {
    console.log()
    console.log(chalk.bold.red('Regressions:'))
    for (const issue of comparison.regressions.slice(0, 10)) {
      const severityColor = issue.severity === 'critical' ? chalk.red
        : issue.severity === 'serious' ? chalk.yellow
        : chalk.gray
      console.log(severityColor(`  [${issue.severity}]`), issue.rule, chalk.gray('-'), issue.description.slice(0, 60))
    }
    if (comparison.regressions.length > 10) {
      console.log(chalk.gray(`  ... and ${comparison.regressions.length - 10} more`))
    }
  }

  // List fixed issues
  if (comparison.fixed.length > 0) {
    console.log()
    console.log(chalk.bold.green('Fixed:'))
    for (const issue of comparison.fixed.slice(0, 5)) {
      console.log(chalk.green('  ✓'), issue.rule, chalk.gray('-'), issue.description.slice(0, 60))
    }
    if (comparison.fixed.length > 5) {
      console.log(chalk.gray(`  ... and ${comparison.fixed.length - 5} more`))
    }
  }

  console.log()
}

/**
 * Write comparison report to file
 */
function writeComparisonReport(comparison: ComparisonResult, outputDir: string, quiet: boolean): void {
  const reportPath = `${outputDir}/comparison.json`

  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    baseline: {
      name: comparison.baseline.name,
      timestamp: comparison.baseline.timestamp,
      score: comparison.baseline.score,
      issuesCount: comparison.baseline.issues.length,
    },
    current: {
      score: comparison.current.score,
      issuesCount: comparison.current.issues.length,
    },
    scoreDelta: comparison.scoreDelta,
    regressions: comparison.regressions,
    fixed: comparison.fixed,
    unchanged: comparison.unchanged.length,
  }, null, 2))

  if (!quiet) {
    console.log(chalk.gray(`Comparison report: ${reportPath}`))
  }
}

// =============================================================================
// Zoom Level Testing
// =============================================================================

/**
 * Run zoom level testing to detect issues at different zoom levels
 * WCAG 2.1 Success Criterion 1.4.4 requires content to be functional up to 200% zoom
 */
async function runZoomTesting(
  config: ExplorerConfig,
  zoomLevels: number[],
  quiet: boolean
): Promise<Issue[]> {
  const issues: Issue[] = []

  // Import playwright dynamically to avoid startup cost when not needed
  const { chromium } = await import('playwright')

  const browser = await chromium.launch({ headless: config.headless ?? true })

  try {
    for (const zoom of zoomLevels) {
      if (!quiet) {
        process.stdout.write(`  Testing at ${zoom}% zoom... `)
      }

      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        storageState: config.auth ? config.auth : undefined,
      })

      // Set cookies if provided
      if (config.cookies && config.cookies.length > 0) {
        await context.addCookies(config.cookies)
      }

      const page = await context.newPage()

      // Set extra HTTP headers if provided
      if (config.extraHTTPHeaders) {
        await page.setExtraHTTPHeaders(config.extraHTTPHeaders)
      }

      try {
        // Navigate to the base URL
        await page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.exploration?.timeout || 10000 })

        // Apply zoom via CSS transform (simulates browser zoom)
        const scale = zoom / 100
        await page.evaluate((s) => {
          document.body.style.transform = `scale(${s})`
          document.body.style.transformOrigin = 'top left'
          document.body.style.width = `${100 / s}%`
        }, scale)

        // Wait for layout to stabilize
        await page.waitForTimeout(500)

        // Check for issues at this zoom level
        const zoomIssues = await page.evaluate((zoomLevel) => {
          const foundIssues: Array<{
            rule: string
            description: string
            severity: 'critical' | 'serious' | 'moderate' | 'minor'
            elements: string[]
          }> = []

          const viewportWidth = window.innerWidth

          // Check for horizontal overflow
          const docWidth = document.documentElement.scrollWidth
          if (docWidth > viewportWidth + 50) { // 50px tolerance
            const overflowingElements: string[] = []
            document.querySelectorAll('*').forEach(el => {
              const rect = el.getBoundingClientRect()
              if (rect.right > viewportWidth + 20) {
                let selector = el.tagName.toLowerCase()
                if (el.id) selector = `#${el.id}`
                else if (el.className && typeof el.className === 'string' && el.className.trim()) {
                  selector += `.${el.className.split(' ')[0]}`
                }
                if (!overflowingElements.includes(selector)) {
                  overflowingElements.push(selector)
                }
              }
            })

            if (overflowingElements.length > 0) {
              foundIssues.push({
                rule: 'zoom-overflow',
                description: `Page has horizontal overflow at ${zoomLevel}% zoom. Content extends beyond viewport.`,
                severity: zoomLevel <= 200 ? 'serious' : 'moderate',
                elements: overflowingElements.slice(0, 5),
              })
            }
          }

          // Check for overlapping interactive elements
          const interactive = document.querySelectorAll('button, a, input, select, [role="button"]')
          const rects = new Map<Element, DOMRect>()
          interactive.forEach(el => {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              rects.set(el, rect)
            }
          })

          const overlapping: string[] = []
          const checked = new Set<Element>()
          rects.forEach((rect1, el1) => {
            rects.forEach((rect2, el2) => {
              if (el1 === el2 || checked.has(el2)) return

              // Check for significant overlap (more than 50% of either element)
              const overlapX = Math.max(0, Math.min(rect1.right, rect2.right) - Math.max(rect1.left, rect2.left))
              const overlapY = Math.max(0, Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top))
              const overlapArea = overlapX * overlapY
              const area1 = rect1.width * rect1.height
              const area2 = rect2.width * rect2.height

              if (overlapArea > Math.min(area1, area2) * 0.5) {
                let selector = el1.tagName.toLowerCase()
                if (el1.id) selector = `#${el1.id}`
                if (!overlapping.includes(selector)) {
                  overlapping.push(selector)
                }
              }
            })
            checked.add(el1)
          })

          if (overlapping.length > 0) {
            foundIssues.push({
              rule: 'zoom-interactive-overlap',
              description: `Interactive elements overlap at ${zoomLevel}% zoom, making them hard to click.`,
              severity: 'serious',
              elements: overlapping.slice(0, 5),
            })
          }

          // Check for text truncation that wasn't there before zoom
          const truncatedTexts: string[] = []
          document.querySelectorAll('*').forEach(el => {
            const htmlEl = el as HTMLElement
            const style = getComputedStyle(el)

            // Check if text is truncated
            if (
              (style.overflow === 'hidden' || style.textOverflow === 'ellipsis') &&
              htmlEl.scrollWidth > htmlEl.clientWidth + 5
            ) {
              let selector = el.tagName.toLowerCase()
              if (el.id) selector = `#${el.id}`
              else if (el.className && typeof el.className === 'string' && el.className.trim()) {
                selector += `.${el.className.split(' ')[0]}`
              }

              // Only report if it contains meaningful text
              const text = htmlEl.innerText?.trim()
              if (text && text.length > 10 && !truncatedTexts.includes(selector)) {
                truncatedTexts.push(selector)
              }
            }
          })

          if (truncatedTexts.length > 3) { // Only report if multiple elements affected
            foundIssues.push({
              rule: 'zoom-text-truncation',
              description: `${truncatedTexts.length} elements have truncated text at ${zoomLevel}% zoom.`,
              severity: 'moderate',
              elements: truncatedTexts.slice(0, 5),
            })
          }

          return foundIssues
        }, zoom)

        // Add issues with zoom viewport info
        for (const issue of zoomIssues) {
          issues.push({
            type: 'responsive',
            severity: issue.severity,
            rule: issue.rule,
            description: issue.description,
            elements: issue.elements,
            viewport: 'desktop',
            details: { zoomLevel: zoom },
          })
        }

        if (!quiet) {
          const issueCount = zoomIssues.length
          if (issueCount === 0) {
            console.log(chalk.green('OK'))
          } else {
            console.log(chalk.yellow(`${issueCount} issue(s)`))
          }
        }
      } catch {
        if (!quiet) {
          console.log(chalk.red('Error'))
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  return issues
}

/**
 * Helper to run explorer and return result (used by baseline/compare)
 */
async function runExplorerAndGetResult(
  baseUrl: string,
  options: Record<string, unknown>
): Promise<import('./core/types.js').ExplorationResult | null> {
  try {
    const preset = PRESETS[options.mode as string] || PRESETS.quick
    const cwd = process.cwd()
    const outputDir = validateOutputPath(options.output as string || './eva-qa-reports', cwd)

    // Parse timeout
    const timeout = options.timeout
      ? parseInt(options.timeout as string, 10)
      : 10000

    // Parse cookies
    let cookies: Array<{ name: string; value: string; url: string }> | undefined
    if (options.cookie) {
      const cookieArray = Array.isArray(options.cookie) ? options.cookie : [options.cookie]
      cookies = []
      for (const cookieStr of cookieArray as string[]) {
        const [name, ...valueParts] = cookieStr.split('=')
        const value = valueParts.join('=')
        if (name && value) {
          cookies.push({ name: name.trim(), value: value.trim(), url: baseUrl })
        }
      }
      if (cookies.length === 0) cookies = undefined
    }

    // Parse headers
    let extraHTTPHeaders: Record<string, string> | undefined
    if (options.header) {
      const headerArray = Array.isArray(options.header) ? options.header : [options.header]
      extraHTTPHeaders = {}
      for (const headerStr of headerArray as string[]) {
        const [name, ...valueParts] = headerStr.split(':')
        const value = valueParts.join(':').trim()
        if (name && value) {
          extraHTTPHeaders[name.trim()] = value
        }
      }
      if (Object.keys(extraHTTPHeaders).length === 0) extraHTTPHeaders = undefined
    }

    const config: ExplorerConfig = {
      baseUrl,
      auth: options.auth as string | undefined,
      exploration: {
        maxDepth: preset.exploration.maxDepth,
        maxStates: preset.exploration.maxStates,
        maxActionsPerState: 50,
        timeout,
        viewports: preset.exploration.viewports,
        waitForNetworkIdle: true,
        actionDelay: 100,
      },
      validators: {
        accessibility: { enabled: preset.validators.accessibility, rules: ['wcag21aa'] },
        responsive: { enabled: preset.validators.responsive, checkOverflow: true, checkTouchTargets: true, minTouchTarget: 44 },
        console: { enabled: preset.validators.console, failOnError: false },
        network: { enabled: preset.validators.network, maxResponseTime: 5000 },
      },
      output: { dir: outputDir, formats: ['json'], screenshots: false },
      headless: true,
      browser: 'chromium',
      cookies,
      extraHTTPHeaders,
    }

    // Ensure directories exist
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const explorer = new Explorer(config)

    if (!options.quiet) {
      console.log(chalk.yellow('Exploring...'))
    }

    return await explorer.explore()
  } catch (error) {
    const friendly = getFriendlyError(error as Error)
    console.error(chalk.red('Error:'), friendly.message)
    if (friendly.tip) {
      console.error(chalk.gray('Tip:'), friendly.tip)
    }
    return null
  }
}

program.parse()
