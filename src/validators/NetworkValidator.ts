/**
 * NetworkValidator - Monitors network requests during page exploration
 *
 * Detects:
 * - Failed API requests (4xx, 5xx errors)
 * - Slow responses (exceeding threshold)
 * - Missing resources (images, scripts, stylesheets)
 * - Mixed content (HTTP on HTTPS pages)
 */

import type { Page, Response, Request } from 'playwright'
import type { Issue, ValidatorResult, ViewportName } from '../core/types.js'

export interface NetworkValidatorConfig {
  /** Enable network validation */
  enabled: boolean
  /** Maximum response time in milliseconds before flagging as slow */
  maxResponseTime: number
  /** Fail CI on network errors */
  failOnError: boolean
  /** URL patterns to ignore (strings are converted to RegExp) */
  ignorePatterns: (string | RegExp)[]
  /** Resource types to track */
  trackResourceTypes: ResourceType[]
  /** Check for mixed content (HTTP on HTTPS) */
  checkMixedContent: boolean
}

type ResourceType = 'xhr' | 'fetch' | 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'other'

const DEFAULT_CONFIG: NetworkValidatorConfig = {
  enabled: true,
  maxResponseTime: 3000,
  failOnError: false,
  ignorePatterns: [],
  trackResourceTypes: ['xhr', 'fetch', 'document', 'stylesheet', 'script', 'image'],
  checkMixedContent: true,
}

interface NetworkRequest {
  url: string
  method: string
  resourceType: string
  startTime: number
  endTime?: number
  status?: number
  error?: string
  duration?: number
}

export class NetworkValidator {
  private config: NetworkValidatorConfig
  private requests: Map<string, NetworkRequest> = new Map()
  private pageIsHttps: boolean = false

  constructor(config: Partial<NetworkValidatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Attach network listeners to a page
   * Call this before navigating to track all requests
   */
  attachToPage(page: Page): void {
    // Track request start
    page.on('request', (request: Request) => {
      const url = request.url()
      if (this.shouldTrackRequest(url, request.resourceType())) {
        this.requests.set(url + request.postData(), {
          url,
          method: request.method(),
          resourceType: request.resourceType(),
          startTime: Date.now(),
        })
      }
    })

    // Track request completion
    page.on('response', (response: Response) => {
      const request = response.request()
      const key = request.url() + request.postData()
      const tracked = this.requests.get(key)

      if (tracked) {
        tracked.endTime = Date.now()
        tracked.status = response.status()
        tracked.duration = tracked.endTime - tracked.startTime
      }
    })

    // Track request failures
    page.on('requestfailed', (request: Request) => {
      const key = request.url() + request.postData()
      const tracked = this.requests.get(key)

      if (tracked) {
        tracked.endTime = Date.now()
        tracked.error = request.failure()?.errorText || 'Request failed'
        tracked.duration = tracked.endTime - tracked.startTime
      } else if (this.shouldTrackRequest(request.url(), request.resourceType())) {
        // Request wasn't tracked yet, add it now
        this.requests.set(key, {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          startTime: Date.now(),
          endTime: Date.now(),
          error: request.failure()?.errorText || 'Request failed',
          duration: 0,
        })
      }
    })
  }

  /**
   * Run network validation on collected requests
   */
  async validate(page: Page, viewport: ViewportName): Promise<ValidatorResult> {
    if (!this.config.enabled) {
      return { validator: 'network', issues: [], duration: 0 }
    }

    const startTime = Date.now()
    const issues: Issue[] = []

    // Check if page is HTTPS (for mixed content detection)
    this.pageIsHttps = page.url().startsWith('https://')

    // Process all tracked requests
    for (const [, request] of this.requests) {
      const requestIssues = this.analyzeRequest(request, viewport)
      issues.push(...requestIssues)
    }

    return {
      validator: 'network',
      issues,
      duration: Date.now() - startTime,
    }
  }

  /**
   * Determine if a request should be tracked
   */
  private shouldTrackRequest(url: string, resourceType: string): boolean {
    // Check resource type
    const mappedType = this.mapResourceType(resourceType)
    if (!this.config.trackResourceTypes.includes(mappedType)) {
      return false
    }

    // Check ignore patterns
    for (const pattern of this.config.ignorePatterns) {
      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
      if (regex.test(url)) {
        return false
      }
    }

    return true
  }

  /**
   * Map Playwright resource types to our types
   */
  private mapResourceType(playwrightType: string): ResourceType {
    const mapping: Record<string, ResourceType> = {
      xhr: 'xhr',
      fetch: 'fetch',
      document: 'document',
      stylesheet: 'stylesheet',
      script: 'script',
      image: 'image',
      font: 'font',
    }
    return mapping[playwrightType] || 'other'
  }

  /**
   * Analyze a single request for issues
   */
  private analyzeRequest(request: NetworkRequest, viewport: ViewportName): Issue[] {
    const issues: Issue[] = []

    // Check for failed requests
    if (request.error) {
      issues.push(this.createFailedRequestIssue(request, viewport))
    }

    // Check for HTTP errors
    if (request.status && request.status >= 400) {
      issues.push(this.createHttpErrorIssue(request, viewport))
    }

    // Check for slow responses
    if (request.duration && request.duration > this.config.maxResponseTime) {
      issues.push(this.createSlowResponseIssue(request, viewport))
    }

    // Check for mixed content
    if (
      this.config.checkMixedContent &&
      this.pageIsHttps &&
      request.url.startsWith('http://')
    ) {
      issues.push(this.createMixedContentIssue(request, viewport))
    }

    return issues
  }

  /**
   * Create issue for failed request
   */
  private createFailedRequestIssue(request: NetworkRequest, viewport: ViewportName): Issue {
    const severity = this.getSeverityForResourceType(request.resourceType, 'error')

    return {
      type: 'network',
      severity,
      rule: 'network-request-failed',
      description: `Network request failed: ${this.truncateUrl(request.url)} (${request.error})`,
      viewport,
      helpUrl: 'https://developer.chrome.com/docs/devtools/network/reference/',
      details: {
        url: request.url,
        method: request.method,
        resourceType: request.resourceType,
        error: request.error,
      },
    }
  }

  /**
   * Create issue for HTTP error response
   */
  private createHttpErrorIssue(request: NetworkRequest, viewport: ViewportName): Issue {
    const isServerError = request.status && request.status >= 500
    const severity = isServerError
      ? 'critical'
      : this.getSeverityForResourceType(request.resourceType, 'http-error')

    const statusText = this.getStatusText(request.status!)

    return {
      type: 'network',
      severity,
      rule: isServerError ? 'network-server-error' : 'network-client-error',
      description: `${request.method} ${this.truncateUrl(request.url)} returned ${request.status} ${statusText}`,
      viewport,
      helpUrl: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${request.status}`,
      details: {
        url: request.url,
        method: request.method,
        status: request.status,
        resourceType: request.resourceType,
        duration: request.duration,
      },
    }
  }

  /**
   * Create issue for slow response
   */
  private createSlowResponseIssue(request: NetworkRequest, viewport: ViewportName): Issue {
    return {
      type: 'network',
      severity: 'minor',
      rule: 'network-slow-response',
      description: `Slow response (${request.duration}ms): ${this.truncateUrl(request.url)}`,
      viewport,
      helpUrl: 'https://web.dev/performance/',
      details: {
        url: request.url,
        method: request.method,
        status: request.status,
        resourceType: request.resourceType,
        duration: request.duration,
        threshold: this.config.maxResponseTime,
      },
    }
  }

  /**
   * Create issue for mixed content
   */
  private createMixedContentIssue(request: NetworkRequest, viewport: ViewportName): Issue {
    const isBlockable = ['script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType)

    return {
      type: 'network',
      severity: isBlockable ? 'serious' : 'moderate',
      rule: 'mixed-content',
      description: `Mixed content: ${request.resourceType} loaded over HTTP on HTTPS page`,
      viewport,
      helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content',
      details: {
        url: request.url,
        resourceType: request.resourceType,
        blockable: isBlockable,
      },
    }
  }

  /**
   * Get severity based on resource type and error type
   */
  private getSeverityForResourceType(
    resourceType: string,
    errorType: 'error' | 'http-error'
  ): Issue['severity'] {
    // Critical resources
    if (['script', 'stylesheet', 'document'].includes(resourceType)) {
      return errorType === 'error' ? 'critical' : 'serious'
    }

    // API requests
    if (['xhr', 'fetch'].includes(resourceType)) {
      return 'serious'
    }

    // Non-critical resources
    if (['image', 'font'].includes(resourceType)) {
      return 'moderate'
    }

    return 'minor'
  }

  /**
   * Get HTTP status text
   */
  private getStatusText(status: number): string {
    const statusTexts: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      408: 'Request Timeout',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    }
    return statusTexts[status] || ''
  }

  /**
   * Truncate URL for display
   */
  private truncateUrl(url: string, maxLength: number = 60): string {
    if (url.length <= maxLength) return url

    try {
      const parsed = new URL(url)
      const path = parsed.pathname + parsed.search
      if (path.length > maxLength - 10) {
        return parsed.origin + '/...' + path.slice(-30)
      }
      return url.slice(0, maxLength - 3) + '...'
    } catch {
      return url.slice(0, maxLength - 3) + '...'
    }
  }

  /**
   * Clear collected requests (call between pages)
   */
  clearRequests(): void {
    this.requests.clear()
  }

  /**
   * Get summary of collected requests
   */
  getSummary(): {
    total: number
    failed: number
    errors4xx: number
    errors5xx: number
    slow: number
  } {
    let failed = 0
    let errors4xx = 0
    let errors5xx = 0
    let slow = 0

    for (const [, request] of this.requests) {
      if (request.error) failed++
      if (request.status && request.status >= 400 && request.status < 500) errors4xx++
      if (request.status && request.status >= 500) errors5xx++
      if (request.duration && request.duration > this.config.maxResponseTime) slow++
    }

    return {
      total: this.requests.size,
      failed,
      errors4xx,
      errors5xx,
      slow,
    }
  }

  /**
   * Generate a report of network issues
   */
  generateReport(issues: Issue[]): string {
    const networkIssues = issues.filter((i) => i.type === 'network' && i.rule.startsWith('network-'))

    if (networkIssues.length === 0) {
      return '# Network Report\n\nNo network issues found.'
    }

    let report = '# Network Report\n\n'

    // Summary by rule
    const byRule = new Map<string, Issue[]>()
    for (const issue of networkIssues) {
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
        const details = issue.details as {
          url?: string
          status?: number
          error?: string
          duration?: number
        }
        report += `- **${issue.severity}**: ${issue.description}\n`
        if (details?.status) {
          report += `  - Status: ${details.status}\n`
        }
        if (details?.error) {
          report += `  - Error: ${details.error}\n`
        }
        if (details?.duration) {
          report += `  - Duration: ${details.duration}ms\n`
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
