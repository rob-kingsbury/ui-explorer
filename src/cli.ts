#!/usr/bin/env node
/**
 * UI Explorer CLI
 *
 * Simple, zero-config UI exploration with optional full-stack verification.
 *
 * Quick Start:
 *   npx ui-explorer http://localhost:3000
 *
 * Preset Modes:
 *   npx ui-explorer quick http://localhost:3000   # Fast scan (3 depth, a11y + responsive)
 *   npx ui-explorer a11y http://localhost:3000    # Accessibility only
 *   npx ui-explorer responsive http://localhost:3000  # Responsive issues only
 *   npx ui-explorer full http://localhost:3000    # Full exploration with all checks
 *
 * With Authentication:
 *   npx ui-explorer http://localhost:3000 --auth ./auth.json
 *
 * With Database Verification:
 *   npx ui-explorer http://localhost:3000 --supabase-url $URL --supabase-key $KEY
 */

import { program } from 'commander'
import chalk from 'chalk'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Explorer } from './core/Explorer.js'
import type { ExplorerConfig, ExplorerEvent, ViewportName } from './core/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    },
  },
}

// =============================================================================
// Main Program
// =============================================================================

program
  .name('ui-explorer')
  .description('Simple, zero-config UI exploration testing')
  .version(version)

// Default command - just pass a URL
program
  .argument('[url]', 'URL to explore (default: http://localhost:3000)')
  .option('-m, --mode <preset>', 'Preset mode: quick, a11y, responsive, full', 'quick')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('--headless', 'Run in headless mode', true)
  .option('--no-headless', 'Show browser window')
  .option('--ci', 'CI mode - exit 1 on critical/serious issues')
  .option('--depth <n>', 'Override max depth')
  .option('--states <n>', 'Override max states')
  .option('--viewports <list>', 'Override viewports (mobile,tablet,desktop)')
  .option('--ignore <selectors>', 'CSS selectors to ignore (comma-separated)')
  .option('--supabase-url <url>', 'Enable Supabase verification')
  .option('--supabase-key <key>', 'Supabase service role key')
  .option('-c, --config <path>', 'Path to config file (advanced)')
  .option('-q, --quiet', 'Minimal output')
  .option('-v, --verbose', 'Detailed output')
  .action(runExplorer)

// Subcommands for preset modes (cleaner syntax)
program
  .command('quick [url]')
  .description('Quick scan - fast a11y + responsive check')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('--ci', 'CI mode')
  .action((url, options) => runExplorer(url, { ...options, mode: 'quick' }))

program
  .command('a11y [url]')
  .alias('accessibility')
  .description('Accessibility scan - WCAG 2.1 AA validation')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('--ci', 'CI mode')
  .action((url, options) => runExplorer(url, { ...options, mode: 'a11y' }))

program
  .command('responsive [url]')
  .description('Responsive check - overflow and touch targets')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('--ci', 'CI mode')
  .action((url, options) => runExplorer(url, { ...options, mode: 'responsive' }))

program
  .command('full [url]')
  .description('Full exploration - all validators, deep crawl')
  .option('-a, --auth <path>', 'Playwright auth state file')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('--supabase-url <url>', 'Enable Supabase verification')
  .option('--supabase-key <key>', 'Supabase service role key')
  .option('--ci', 'CI mode')
  .action((url, options) => runExplorer(url, { ...options, mode: 'full' }))

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

    if (!options.quiet) {
      console.log()
      console.log(chalk.bold.cyan('UI Explorer'), chalk.gray(`v${version}`))
      console.log(chalk.gray('─'.repeat(50)))
      console.log(chalk.white('URL:'), baseUrl)
      console.log(chalk.white('Mode:'), `${preset.name} - ${preset.description}`)
      console.log(chalk.gray('─'.repeat(50)))
      console.log()
    }

    // Load config file if specified (advanced usage)
    let fileConfig: Partial<ExplorerConfig> = {}
    if (options.config) {
      const configPath = resolve(process.cwd(), options.config as string)
      if (existsSync(configPath)) {
        try {
          const module = await import(configPath)
          fileConfig = module.default || module
          if (!options.quiet) {
            console.log(chalk.gray(`Loaded config: ${configPath}`))
          }
        } catch {
          console.error(chalk.yellow(`Warning: Could not load ${configPath}`))
        }
      }
    }

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
        timeout: 10000,
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
          maxResponseTime: 5000,
          ...fileConfig.validators?.network,
        },
      },

      // Only load adapters if credentials provided
      adapters:
        options.supabaseUrl && options.supabaseKey
          ? {
              supabase: {
                url: options.supabaseUrl as string,
                serviceKey: options.supabaseKey as string,
              },
            }
          : fileConfig.adapters,

      actionSchemas: fileConfig.actionSchemas,
      testData: fileConfig.testData,

      ignore: options.ignore
        ? (options.ignore as string).split(',')
        : fileConfig.ignore || [],

      output: {
        dir: options.output as string,
        formats: ['html', 'json'],
        screenshots: true,
        screenshotFormat: 'png',
        ...fileConfig.output,
      },

      headless: options.headless as boolean,
      browser: fileConfig.browser || 'chromium',
    }

    // Ensure output directory exists
    const outputDir = config.output?.dir || './ui-explorer-reports'
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
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)

    // Print results
    printResults(result, duration, options.quiet as boolean)

    // Write reports
    writeReports(result, outputDir, options.quiet as boolean)

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
    console.error(chalk.red('Error:'), (error as Error).message)
    if (options.verbose) {
      console.error((error as Error).stack)
    }
    process.exit(1)
  }
}

// =============================================================================
// Output Helpers
// =============================================================================

function printResults(
  result: import('./core/types.js').ExplorationResult,
  duration: string,
  quiet: boolean
): void {
  if (quiet) {
    // Minimal output for scripts
    console.log(
      JSON.stringify({
        states: result.summary.statesExplored,
        actions: result.summary.actionsPerformed,
        issues: result.summary.issuesFound,
        duration: parseFloat(duration),
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
  quiet: boolean
): void {
  // JSON report
  const jsonPath = `${outputDir}/report.json`
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary: result.summary,
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

  // HTML report
  const htmlPath = `${outputDir}/report.html`
  writeFileSync(htmlPath, generateHtmlReport(result))

  if (!quiet) {
    console.log(chalk.gray(`Reports: ${outputDir}/`))
    console.log(chalk.gray(`  report.html - Visual report`))
    console.log(chalk.gray(`  report.json - Machine-readable`))
  }
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
// HTML Report Generator
// =============================================================================

function generateHtmlReport(result: import('./core/types.js').ExplorationResult): string {
  const { summary, issues } = result

  const issuesByType: Record<string, typeof issues> = {}
  for (const issue of issues) {
    if (!issuesByType[issue.type]) {
      issuesByType[issue.type] = []
    }
    issuesByType[issue.type].push(issue)
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UI Explorer Report</title>
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
    .issue-elements { font-family: monospace; font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem; }
    .issue-elements code { background: var(--bg); padding: 0.125rem 0.375rem; border-radius: 3px; }
    .empty { text-align: center; padding: 3rem; color: var(--success); }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>UI Explorer Report</h1>
    <p class="meta">Generated ${new Date().toLocaleString()}</p>

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

    ${Object.entries(issuesByType)
      .map(
        ([type, typeIssues]) => `
      <h2>${type.charAt(0).toUpperCase() + type.slice(1)} Issues (${typeIssues.length})</h2>
      <div class="issues">
        ${typeIssues
          .slice(0, 25)
          .map(
            (issue) => `
          <div class="issue ${issue.severity}">
            <div class="issue-header">
              <span class="issue-rule">${issue.rule}</span>
              <span class="badge ${issue.severity}">${issue.severity}</span>
            </div>
            <div class="issue-desc">${issue.description}</div>
            ${
              issue.elements && issue.elements.length > 0
                ? `<div class="issue-elements">${issue.elements
                    .slice(0, 2)
                    .map((e) => `<code>${escapeHtml(e)}</code>`)
                    .join(' ')}</div>`
                : ''
            }
            ${issue.helpUrl ? `<a href="${issue.helpUrl}" target="_blank">Learn more →</a>` : ''}
          </div>
        `
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

program.parse()
