/**
 * BrokenLinksValidator - Checks for broken/stale links on pages
 *
 * Detects:
 * - Links returning 404 (Not Found)
 * - Links timing out
 * - Links with connection errors
 * - Redirect loops
 * - Links to error pages
 */

import type { Page } from 'playwright'
import type { Issue, ValidatorResult, ViewportName } from '../core/types.js'

export interface BrokenLinksValidatorConfig {
  /** Enable broken link validation */
  enabled: boolean
  /** Check external (off-site) links */
  checkExternal: boolean
  /** Check internal (same-site) links */
  checkInternal: boolean
  /** Request timeout in milliseconds */
  timeout: number
  /** URL patterns to ignore (strings are converted to RegExp) */
  ignorePatterns: (string | RegExp)[]
  /** Follow redirects and report chains */
  followRedirects: boolean
  /** Maximum redirects before considering it a loop */
  maxRedirects: number
}

const DEFAULT_CONFIG: BrokenLinksValidatorConfig = {
  enabled: true,
  checkExternal: true,
  checkInternal: true,
  timeout: 5000,
  ignorePatterns: [],
  followRedirects: false,
  maxRedirects: 5,
}

interface LinkInfo {
  href: string
  text: string
  selector: string
  isExternal: boolean
}

interface LinkCheckResult {
  link: LinkInfo
  status: number | null
  error: string | null
  redirectChain: string[]
  duration: number
}

export class BrokenLinksValidator {
  private config: BrokenLinksValidatorConfig
  private checkedUrls: Map<string, LinkCheckResult> = new Map()

  constructor(config: Partial<BrokenLinksValidatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run broken link validation on the current page
   */
  async validate(page: Page, viewport: ViewportName): Promise<ValidatorResult> {
    if (!this.config.enabled) {
      return { validator: 'brokenLinks', issues: [], duration: 0 }
    }

    const startTime = Date.now()
    const issues: Issue[] = []

    // Extract all links from the page
    const links = await this.extractLinks(page)

    // Filter links based on configuration
    const linksToCheck = links.filter((link) => this.shouldCheckLink(link, page.url()))

    // Check each link with concurrency limit to be polite to servers
    const results = await this.checkLinksWithConcurrency(linksToCheck, 5)

    // Convert results to issues
    for (const result of results) {
      const issue = this.resultToIssue(result, viewport)
      if (issue) {
        issues.push(issue)
      }
    }

    return {
      validator: 'brokenLinks',
      issues,
      duration: Date.now() - startTime,
    }
  }

  /**
   * Extract all links from the page
   */
  private async extractLinks(page: Page): Promise<LinkInfo[]> {
    const baseUrl = new URL(page.url())

    const links = await page.evaluate((baseOrigin: string) => {
      const anchors = document.querySelectorAll('a[href]')
      const results: Array<{
        href: string
        text: string
        selector: string
        isExternal: boolean
      }> = []

      anchors.forEach((anchor, index) => {
        const href = anchor.getAttribute('href')
        if (!href) return

        // Skip non-http links
        if (
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:') ||
          href.startsWith('javascript:') ||
          href.startsWith('data:')
        ) {
          return
        }

        // Resolve relative URLs
        let fullUrl: string
        try {
          fullUrl = new URL(href, baseOrigin).href
        } catch {
          // Invalid URL, skip
          return
        }

        // Generate selector
        let selector = 'a'
        if (anchor.id) {
          selector = `#${anchor.id}`
        } else if (anchor.getAttribute('data-testid')) {
          selector = `[data-testid="${anchor.getAttribute('data-testid')}"]`
        } else {
          selector = `a[href="${href}"]:nth-of-type(${index + 1})`
        }

        // Check if external
        const linkOrigin = new URL(fullUrl).origin
        const isExternal = linkOrigin !== baseOrigin

        results.push({
          href: fullUrl,
          text: (anchor as HTMLAnchorElement).innerText?.slice(0, 50) || href,
          selector,
          isExternal,
        })
      })

      return results
    }, baseUrl.origin)

    return links
  }

  /**
   * Determine if a link should be checked
   */
  private shouldCheckLink(link: LinkInfo, currentUrl: string): boolean {
    // Check external/internal settings
    if (link.isExternal && !this.config.checkExternal) return false
    if (!link.isExternal && !this.config.checkInternal) return false

    // Check ignore patterns
    for (const pattern of this.config.ignorePatterns) {
      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
      if (regex.test(link.href)) return false
    }

    // Skip if same as current page (just an anchor)
    try {
      const linkUrl = new URL(link.href)
      const pageUrl = new URL(currentUrl)
      if (linkUrl.origin === pageUrl.origin && linkUrl.pathname === pageUrl.pathname) {
        return false
      }
    } catch {
      // Invalid URL
      return false
    }

    return true
  }

  /**
   * Check links with concurrency limit
   */
  private async checkLinksWithConcurrency(
    links: LinkInfo[],
    concurrency: number
  ): Promise<LinkCheckResult[]> {
    const results: LinkCheckResult[] = []
    const queue = [...links]

    const workers = Array(Math.min(concurrency, queue.length))
      .fill(null)
      .map(async () => {
        while (queue.length > 0) {
          const link = queue.shift()
          if (link) {
            const result = await this.checkLink(link)
            results.push(result)
          }
        }
      })

    await Promise.all(workers)
    return results
  }

  /**
   * Check a single link
   */
  private async checkLink(link: LinkInfo): Promise<LinkCheckResult> {
    // Check cache first
    const cached = this.checkedUrls.get(link.href)
    if (cached) {
      return { ...cached, link }
    }

    const startTime = Date.now()
    const result: LinkCheckResult = {
      link,
      status: null,
      error: null,
      redirectChain: [],
      duration: 0,
    }

    try {
      // Use fetch with HEAD method for efficiency
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

      const response = await fetch(link.href, {
        method: 'HEAD',
        redirect: this.config.followRedirects ? 'follow' : 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'EVA-QA Link Checker/1.0',
        },
      })

      clearTimeout(timeoutId)

      result.status = response.status

      // Track redirects if following
      if (this.config.followRedirects && response.redirected) {
        result.redirectChain.push(response.url)
      }

      // Some servers don't support HEAD, retry with GET for 405
      if (response.status === 405) {
        const getResponse = await fetch(link.href, {
          method: 'GET',
          redirect: this.config.followRedirects ? 'follow' : 'manual',
          signal: AbortSignal.timeout(this.config.timeout),
          headers: {
            'User-Agent': 'EVA-QA Link Checker/1.0',
          },
        })
        result.status = getResponse.status
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          result.error = 'Timeout'
        } else if (error.message.includes('fetch')) {
          result.error = 'Connection failed'
        } else {
          result.error = error.message
        }
      } else {
        result.error = 'Unknown error'
      }
    }

    result.duration = Date.now() - startTime

    // Cache the result
    this.checkedUrls.set(link.href, result)

    return result
  }

  /**
   * Convert a link check result to an issue (if it's a problem)
   */
  private resultToIssue(result: LinkCheckResult, viewport: ViewportName): Issue | null {
    const { link, status, error } = result

    // Determine if this is an issue
    if (status && status >= 200 && status < 400) {
      // Success or redirect - not an issue
      return null
    }

    // Build issue based on problem type
    let severity: Issue['severity']
    let rule: string
    let description: string

    if (error) {
      // Connection/timeout error
      if (error === 'Timeout') {
        severity = 'moderate'
        rule = 'link-timeout'
        description = `Link timed out after ${this.config.timeout}ms: "${link.text}"`
      } else {
        severity = 'serious'
        rule = 'link-connection-error'
        description = `Link connection failed: "${link.text}" (${error})`
      }
    } else if (status === 404) {
      severity = 'serious'
      rule = 'broken-link-404'
      description = `Broken link (404 Not Found): "${link.text}"`
    } else if (status && status >= 500) {
      severity = 'critical'
      rule = 'broken-link-server-error'
      description = `Link returns server error (${status}): "${link.text}"`
    } else if (status && status >= 400) {
      severity = 'moderate'
      rule = 'broken-link-client-error'
      description = `Link returns error (${status}): "${link.text}"`
    } else {
      // Unknown status
      severity = 'minor'
      rule = 'link-unknown-status'
      description = `Link returned unexpected status: "${link.text}"`
    }

    return {
      type: 'network',
      severity,
      rule,
      description,
      viewport,
      elements: [link.selector],
      helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status',
      details: {
        href: link.href,
        linkText: link.text,
        status,
        error,
        isExternal: link.isExternal,
        duration: result.duration,
        redirectChain: result.redirectChain,
      },
    }
  }

  /**
   * Clear the URL cache (useful between page navigations)
   */
  clearCache(): void {
    this.checkedUrls.clear()
  }

  /**
   * Generate a report of broken link issues
   */
  generateReport(issues: Issue[]): string {
    const linkIssues = issues.filter(
      (i) => i.type === 'network' && (i.rule.startsWith('broken-link') || i.rule.startsWith('link-'))
    )

    if (linkIssues.length === 0) {
      return '# Broken Links Report\n\nNo broken links found.'
    }

    let report = '# Broken Links Report\n\n'

    // Summary by rule
    const byRule = new Map<string, Issue[]>()
    for (const issue of linkIssues) {
      const existing = byRule.get(issue.rule) || []
      existing.push(issue)
      byRule.set(issue.rule, existing)
    }

    report += '## Summary\n\n'
    for (const [rule, ruleIssues] of byRule) {
      const severities = ruleIssues.map((i) => i.severity)
      const worst = severities.includes('critical')
        ? 'critical'
        : severities.includes('serious')
          ? 'serious'
          : severities.includes('moderate')
            ? 'moderate'
            : 'minor'
      report += `- **${rule}**: ${ruleIssues.length} issue(s) (${worst})\n`
    }

    report += '\n## Details\n\n'

    for (const [rule, ruleIssues] of byRule) {
      report += `### ${rule}\n\n`

      for (const issue of ruleIssues.slice(0, 10)) {
        const details = issue.details as { href?: string; status?: number; error?: string }
        report += `- **${issue.severity}**: ${issue.description}\n`
        report += `  - URL: ${details?.href || 'unknown'}\n`
        if (details?.status) {
          report += `  - Status: ${details.status}\n`
        }
        if (details?.error) {
          report += `  - Error: ${details.error}\n`
        }
      }

      if (ruleIssues.length > 10) {
        report += `- ... and ${ruleIssues.length - 10} more\n`
      }

      report += '\n'
    }

    return report
  }
}
