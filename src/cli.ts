#!/usr/bin/env node
/**
 * UI Explorer CLI
 *
 * Exhaustive UI exploration with full-stack verification.
 *
 * Usage:
 *   ui-explorer http://localhost:5173
 *   ui-explorer http://localhost:5173 --auth ./playwright/.auth/user.json
 *   ui-explorer http://localhost:5173 --config ./ui-explorer.config.js
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

program
  .name('ui-explorer')
  .description('Exhaustive UI exploration with full-stack verification')
  .version(version)
  .argument('[urls...]', 'URLs to explore')
  .option('-c, --config <path>', 'Path to config file')
  .option('-a, --auth <path>', 'Playwright storage state for authentication')
  .option('-o, --output <dir>', 'Output directory', './ui-explorer-reports')
  .option('-f, --format <formats>', 'Output formats (html,json,playwright)', 'html,json')
  .option('-v, --viewports <viewports>', 'Viewports to test (mobile,tablet,desktop)', 'mobile,desktop')
  .option('--max-depth <n>', 'Maximum exploration depth', '10')
  .option('--max-states <n>', 'Maximum states to explore', '500')
  .option('--timeout <ms>', 'Action timeout in ms', '10000')
  .option('--headless', 'Run in headless mode', true)
  .option('--no-headless', 'Run in headed mode (visible browser)')
  .option('--ci', 'CI mode (fail on critical/serious issues)')
  .option('--fail-on <severities>', 'Fail on these severities (critical,serious,moderate,minor)')
  .option('--supabase-url <url>', 'Supabase project URL')
  .option('--supabase-key <key>', 'Supabase service role key')
  .option('--ignore <selectors>', 'CSS selectors to ignore (comma-separated)')
  .option('--quiet', 'Minimal output')
  .option('--verbose', 'Verbose output')
  .action(async (urls: string[], options) => {
    try {
      await run(urls, options)
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message)
      process.exit(1)
    }
  })

async function run(urls: string[], options: Record<string, unknown>): Promise<void> {
  // Load config file if specified
  let fileConfig: Partial<ExplorerConfig> = {}

  if (options.config) {
    const configPath = resolve(process.cwd(), options.config as string)
    if (existsSync(configPath)) {
      try {
        // Dynamic import for config file
        const module = await import(configPath)
        fileConfig = module.default || module
        if (!options.quiet) {
          console.log(chalk.gray(`Loaded config from ${configPath}`))
        }
      } catch {
        console.error(chalk.yellow(`Warning: Could not load config from ${configPath}`))
      }
    } else {
      console.error(chalk.red(`Config file not found: ${configPath}`))
      process.exit(1)
    }
  }

  // Build config from CLI options and file
  const baseUrl = urls[0] || fileConfig.baseUrl
  if (!baseUrl) {
    console.error(chalk.red('Error: No URL provided'))
    console.log('Usage: ui-explorer <url>')
    process.exit(1)
  }

  const config: ExplorerConfig = {
    baseUrl,
    startUrls: urls.length > 0 ? urls : fileConfig.startUrls,
    auth: (options.auth as string) || fileConfig.auth,

    adapters: {
      ...fileConfig.adapters,
      ...(options.supabaseUrl && options.supabaseKey
        ? {
            supabase: {
              url: options.supabaseUrl as string,
              serviceKey: options.supabaseKey as string,
            },
          }
        : {}),
    },

    actionSchemas: fileConfig.actionSchemas,
    testData: fileConfig.testData,
    validators: fileConfig.validators,

    exploration: {
      maxDepth: parseInt(options.maxDepth as string, 10),
      maxStates: parseInt(options.maxStates as string, 10),
      timeout: parseInt(options.timeout as string, 10),
      viewports: (options.viewports as string).split(',') as ViewportName[],
      ...fileConfig.exploration,
    },

    ignore: options.ignore
      ? (options.ignore as string).split(',')
      : fileConfig.ignore,

    output: {
      dir: options.output as string,
      formats: (options.format as string).split(',') as ('html' | 'json' | 'playwright')[],
      screenshots: true,
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

  // Create explorer
  const explorer = new Explorer(config)

  // Set up progress reporting
  if (!options.quiet) {
    console.log(chalk.bold('\nUI Explorer'))
    console.log(chalk.gray('─'.repeat(50)))
    console.log(chalk.cyan('Base URL:'), baseUrl)
    console.log(chalk.cyan('Viewports:'), config.exploration?.viewports?.join(', '))
    console.log(chalk.cyan('Max Depth:'), config.exploration?.maxDepth)
    console.log(chalk.cyan('Max States:'), config.exploration?.maxStates)
    console.log(chalk.gray('─'.repeat(50)))
    console.log()

    explorer.on(createProgressHandler(options.verbose as boolean))
  }

  // Run exploration
  console.log(chalk.yellow('Starting exploration...\n'))
  const startTime = Date.now()

  const result = await explorer.explore()

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)

  // Print summary
  console.log()
  console.log(chalk.gray('─'.repeat(50)))
  console.log(chalk.bold('Exploration Complete'))
  console.log(chalk.gray('─'.repeat(50)))
  console.log(chalk.cyan('Duration:'), `${duration}s`)
  console.log(chalk.cyan('States Explored:'), result.summary.statesExplored)
  console.log(chalk.cyan('Actions Performed:'), result.summary.actionsPerformed)
  console.log(chalk.cyan('URLs Covered:'), result.summary.coverage.urlsCovered.length)
  console.log()

  // Issues summary
  const issuesBySeverity = {
    critical: result.issues.filter((i) => i.severity === 'critical').length,
    serious: result.issues.filter((i) => i.severity === 'serious').length,
    moderate: result.issues.filter((i) => i.severity === 'moderate').length,
    minor: result.issues.filter((i) => i.severity === 'minor').length,
  }

  console.log(chalk.bold('Issues Found:'))
  if (issuesBySeverity.critical > 0) {
    console.log(chalk.red(`  Critical: ${issuesBySeverity.critical}`))
  }
  if (issuesBySeverity.serious > 0) {
    console.log(chalk.yellow(`  Serious: ${issuesBySeverity.serious}`))
  }
  if (issuesBySeverity.moderate > 0) {
    console.log(chalk.blue(`  Moderate: ${issuesBySeverity.moderate}`))
  }
  if (issuesBySeverity.minor > 0) {
    console.log(chalk.gray(`  Minor: ${issuesBySeverity.minor}`))
  }
  if (result.issues.length === 0) {
    console.log(chalk.green('  No issues found!'))
  }
  console.log()

  // Verifications summary
  if (result.verifications.length > 0) {
    console.log(chalk.bold('Verifications:'))
    console.log(chalk.green(`  Passed: ${result.summary.verificationsPassed}`))
    if (result.summary.verificationsFailed > 0) {
      console.log(chalk.red(`  Failed: ${result.summary.verificationsFailed}`))
    }
    console.log()
  }

  // Write outputs
  const formats = config.output?.formats || ['json']

  if (formats.includes('json')) {
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
            transitionCount: node.transitions.length,
          })),
        },
        null,
        2
      )
    )
    console.log(chalk.gray(`JSON report: ${jsonPath}`))
  }

  if (formats.includes('html')) {
    const htmlPath = `${outputDir}/report.html`
    writeFileSync(htmlPath, generateHtmlReport(result))
    console.log(chalk.gray(`HTML report: ${htmlPath}`))
  }

  console.log()

  // CI mode: exit with error if issues found
  if (options.ci || options.failOn) {
    const failSeverities = options.failOn
      ? (options.failOn as string).split(',')
      : ['critical', 'serious']

    const shouldFail = result.issues.some((issue) =>
      failSeverities.includes(issue.severity)
    )

    if (shouldFail) {
      console.log(chalk.red('Exiting with error due to issues found'))
      process.exit(1)
    }
  }
}

/**
 * Create a progress handler for explorer events
 */
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

      case 'action:error':
        if (verbose) {
          console.log(chalk.red('✗'), event.action.label, chalk.red(event.error.message))
        }
        break

      case 'progress':
        // Update progress every 5 states
        if (event.visited - lastProgress >= 5) {
          lastProgress = event.visited
          process.stdout.write(
            `\r${chalk.cyan('Progress:')} ${event.visited} states, ${event.queued} queued, ${event.issues} issues`
          )
        }
        break

      case 'complete':
        process.stdout.write('\r' + ' '.repeat(80) + '\r') // Clear progress line
        break
    }
  }
}

/**
 * Generate a simple HTML report
 */
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
      --bg: #121214;
      --surface: #1c1c20;
      --text: #e4e4e7;
      --text-muted: #8a8a94;
      --primary: #5bc4f5;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --border: #27272a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: var(--primary); margin-bottom: 1rem; }
    h2 { color: var(--text); margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h3 { color: var(--text-muted); margin: 1.5rem 0 0.5rem; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .stat {
      background: var(--surface);
      border-radius: 8px;
      padding: 1.5rem;
      border: 1px solid var(--border);
    }
    .stat-value { font-size: 2rem; font-weight: bold; color: var(--primary); }
    .stat-label { color: var(--text-muted); font-size: 0.875rem; }
    .issues { margin: 1rem 0; }
    .issue {
      background: var(--surface);
      border-radius: 8px;
      padding: 1rem;
      margin: 0.5rem 0;
      border-left: 4px solid var(--border);
    }
    .issue.critical { border-left-color: var(--danger); }
    .issue.serious { border-left-color: var(--warning); }
    .issue.moderate { border-left-color: var(--primary); }
    .issue.minor { border-left-color: var(--text-muted); }
    .issue-header { display: flex; justify-content: space-between; align-items: center; }
    .issue-rule { font-weight: bold; }
    .issue-severity {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .issue-severity.critical { background: var(--danger); color: white; }
    .issue-severity.serious { background: var(--warning); color: black; }
    .issue-severity.moderate { background: var(--primary); color: black; }
    .issue-severity.minor { background: var(--text-muted); color: black; }
    .issue-description { color: var(--text-muted); margin-top: 0.5rem; }
    .issue-elements { font-family: monospace; font-size: 0.875rem; color: var(--text-muted); margin-top: 0.5rem; }
    .no-issues { color: var(--success); padding: 2rem; text-align: center; }
    a { color: var(--primary); }
    code { background: var(--bg); padding: 0.125rem 0.25rem; border-radius: 4px; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>UI Explorer Report</h1>
    <p style="color: var(--text-muted)">Generated at ${new Date().toISOString()}</p>

    <div class="summary">
      <div class="stat">
        <div class="stat-value">${summary.statesExplored}</div>
        <div class="stat-label">States Explored</div>
      </div>
      <div class="stat">
        <div class="stat-value">${summary.actionsPerformed}</div>
        <div class="stat-label">Actions Performed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${summary.issuesFound}</div>
        <div class="stat-label">Issues Found</div>
      </div>
      <div class="stat">
        <div class="stat-value">${(summary.duration / 1000).toFixed(1)}s</div>
        <div class="stat-label">Duration</div>
      </div>
    </div>

    <h2>Issues by Type</h2>
    ${Object.entries(issuesByType)
      .map(
        ([type, typeIssues]) => `
      <h3>${type.charAt(0).toUpperCase() + type.slice(1)} (${typeIssues.length})</h3>
      <div class="issues">
        ${typeIssues
          .slice(0, 20)
          .map(
            (issue) => `
          <div class="issue ${issue.severity}">
            <div class="issue-header">
              <span class="issue-rule">${issue.rule}</span>
              <span class="issue-severity ${issue.severity}">${issue.severity}</span>
            </div>
            <div class="issue-description">${issue.description}</div>
            ${issue.elements && issue.elements.length > 0 ? `<div class="issue-elements">${issue.elements.slice(0, 3).map((e) => `<code>${e}</code>`).join(' ')}</div>` : ''}
            ${issue.helpUrl ? `<a href="${issue.helpUrl}" target="_blank">Learn more</a>` : ''}
          </div>
        `
          )
          .join('')}
        ${typeIssues.length > 20 ? `<p style="color: var(--text-muted)">... and ${typeIssues.length - 20} more</p>` : ''}
      </div>
    `
      )
      .join('')}

    ${issues.length === 0 ? '<div class="no-issues">No issues found!</div>' : ''}

    <h2>Coverage</h2>
    <ul>
      ${summary.coverage.urlsCovered.map((url) => `<li><code>${url}</code></li>`).join('')}
    </ul>
  </div>
</body>
</html>`
}

program.parse()
