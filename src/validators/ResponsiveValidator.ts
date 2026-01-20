/**
 * ResponsiveValidator - Checks for responsive design issues
 *
 * Detects:
 * - Horizontal overflow (content wider than viewport)
 * - Touch targets too small (< 44x44px on mobile)
 * - Text truncation issues
 * - Elements outside viewport
 */

import type { Page } from 'playwright'
import type { Issue, ValidatorResult, ViewportName } from '../core/types.js'

export interface ResponsiveValidatorConfig {
  /** Enable responsive validation */
  enabled: boolean
  /** Check for horizontal overflow */
  checkOverflow: boolean
  /** Check touch target sizes */
  checkTouchTargets: boolean
  /** Minimum touch target size (px) */
  minTouchTarget: number
  /** Check for text truncation */
  checkTruncation: boolean
  /** Check for elements outside viewport */
  checkOutOfBounds: boolean
  /** Tolerance for overflow detection (px) */
  overflowTolerance: number
}

const DEFAULT_CONFIG: ResponsiveValidatorConfig = {
  enabled: true,
  checkOverflow: true,
  checkTouchTargets: true,
  minTouchTarget: 44,
  checkTruncation: true,
  checkOutOfBounds: true,
  overflowTolerance: 5,
}

export class ResponsiveValidator {
  private config: ResponsiveValidatorConfig

  constructor(config: Partial<ResponsiveValidatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run responsive validation on the current page
   */
  async validate(page: Page, viewport: ViewportName): Promise<ValidatorResult> {
    if (!this.config.enabled) {
      return { validator: 'responsive', issues: [], duration: 0 }
    }

    const startTime = Date.now()
    const issues: Issue[] = []

    // Get viewport dimensions
    const viewportSize = page.viewportSize()
    if (!viewportSize) {
      return { validator: 'responsive', issues: [], duration: Date.now() - startTime }
    }

    // Check horizontal overflow
    if (this.config.checkOverflow) {
      const overflowIssues = await this.checkHorizontalOverflow(page, viewport, viewportSize)
      issues.push(...overflowIssues)
    }

    // Check touch targets (only on mobile)
    if (this.config.checkTouchTargets && viewport === 'mobile') {
      const touchIssues = await this.checkTouchTargets(page, viewport)
      issues.push(...touchIssues)
    }

    // Check text truncation
    if (this.config.checkTruncation) {
      const truncationIssues = await this.checkTextTruncation(page, viewport)
      issues.push(...truncationIssues)
    }

    // Check elements outside viewport
    if (this.config.checkOutOfBounds) {
      const boundsIssues = await this.checkOutOfBounds(page, viewport, viewportSize)
      issues.push(...boundsIssues)
    }

    return {
      validator: 'responsive',
      issues,
      duration: Date.now() - startTime,
    }
  }

  /**
   * Check for horizontal overflow
   */
  private async checkHorizontalOverflow(
    page: Page,
    viewport: ViewportName,
    viewportSize: { width: number; height: number }
  ): Promise<Issue[]> {
    const issues: Issue[] = []

    const overflow = await page.evaluate((vw) => {
      const docWidth = document.documentElement.scrollWidth
      const bodyWidth = document.body.scrollWidth
      const maxWidth = Math.max(docWidth, bodyWidth)

      // Find elements causing overflow
      const overflowingElements: Array<{ selector: string; width: number; overflow: number }> = []

      const checkElement = (el: Element) => {
        const rect = el.getBoundingClientRect()
        if (rect.right > vw + 10) {
          // 10px tolerance
          let selector = el.tagName.toLowerCase()
          if (el.id) selector = `#${el.id}`
          else if (el.className && typeof el.className === 'string') {
            selector += `.${el.className.split(' ')[0]}`
          }

          overflowingElements.push({
            selector,
            width: rect.width,
            overflow: rect.right - vw,
          })
        }
      }

      // Check all elements
      document.querySelectorAll('*').forEach(checkElement)

      return {
        hasOverflow: maxWidth > vw + 10,
        maxWidth,
        viewportWidth: vw,
        overflowingElements: overflowingElements.slice(0, 10),
      }
    }, viewportSize.width)

    if (overflow.hasOverflow) {
      issues.push({
        type: 'responsive',
        severity: 'serious',
        rule: 'no-horizontal-scroll',
        description: `Page has horizontal overflow at ${viewportSize.width}px width (content is ${overflow.maxWidth}px)`,
        viewport,
        elements: overflow.overflowingElements.map((e) => e.selector),
        details: {
          viewportWidth: overflow.viewportWidth,
          contentWidth: overflow.maxWidth,
          overflow: overflow.maxWidth - overflow.viewportWidth,
          overflowingElements: overflow.overflowingElements,
        },
      })
    }

    return issues
  }

  /**
   * Check touch target sizes
   */
  private async checkTouchTargets(page: Page, viewport: ViewportName): Promise<Issue[]> {
    const issues: Issue[] = []
    const minSize = this.config.minTouchTarget

    const smallTargets = await page.evaluate((min) => {
      const interactive = document.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
      )

      const small: Array<{
        selector: string
        width: number
        height: number
        label: string
      }> = []

      interactive.forEach((el) => {
        const htmlEl = el as HTMLElement
        const rect = htmlEl.getBoundingClientRect()

        // Skip hidden elements
        if (rect.width === 0 || rect.height === 0) return
        if (!htmlEl.offsetParent && getComputedStyle(htmlEl).position !== 'fixed') return

        // Check if too small
        if (rect.width < min || rect.height < min) {
          let selector = el.tagName.toLowerCase()
          if (el.id) selector = `#${el.id}`
          else if (el.getAttribute('data-testid')) {
            selector = `[data-testid="${el.getAttribute('data-testid')}"]`
          }

          small.push({
            selector,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            label:
              el.getAttribute('aria-label') ||
              (el as HTMLElement).innerText?.slice(0, 30) ||
              selector,
          })
        }
      })

      return small
    }, minSize)

    for (const target of smallTargets) {
      issues.push({
        type: 'responsive',
        severity: 'moderate',
        rule: 'touch-target-size',
        description: `Touch target "${target.label}" is ${target.width}x${target.height}px (minimum ${minSize}x${minSize}px)`,
        viewport,
        elements: [target.selector],
        details: {
          width: target.width,
          height: target.height,
          minRequired: minSize,
          label: target.label,
        },
      })
    }

    return issues
  }

  /**
   * Check for text truncation (ellipsis)
   */
  private async checkTextTruncation(page: Page, viewport: ViewportName): Promise<Issue[]> {
    const issues: Issue[] = []

    const truncated = await page.evaluate(() => {
      const results: Array<{ selector: string; text: string }> = []

      // Find elements with text-overflow: ellipsis that are actually truncated
      document.querySelectorAll('*').forEach((el) => {
        const style = getComputedStyle(el)
        const htmlEl = el as HTMLElement

        // Check for CSS truncation
        if (
          style.textOverflow === 'ellipsis' &&
          style.overflow === 'hidden' &&
          htmlEl.scrollWidth > htmlEl.clientWidth
        ) {
          let selector = el.tagName.toLowerCase()
          if (el.id) selector = `#${el.id}`
          else if (el.className && typeof el.className === 'string') {
            selector += `.${el.className.split(' ')[0]}`
          }

          results.push({
            selector,
            text: htmlEl.innerText?.slice(0, 50) || '',
          })
        }
      })

      return results.slice(0, 10) // Limit to 10
    })

    // Only report as minor issues (truncation is often intentional)
    if (truncated.length > 0) {
      issues.push({
        type: 'responsive',
        severity: 'minor',
        rule: 'text-truncation',
        description: `${truncated.length} element(s) have truncated text`,
        viewport,
        elements: truncated.map((t) => t.selector),
        details: {
          truncatedElements: truncated,
        },
      })
    }

    return issues
  }

  /**
   * Check for important elements outside viewport
   */
  private async checkOutOfBounds(
    page: Page,
    viewport: ViewportName,
    viewportSize: { width: number; height: number }
  ): Promise<Issue[]> {
    const issues: Issue[] = []

    const outOfBounds = await page.evaluate(
      ({ vw, vh }) => {
        const results: Array<{
          selector: string
          position: { x: number; y: number }
          reason: string
        }> = []

        // Check important elements (buttons, links, form inputs)
        const important = document.querySelectorAll('button, a[href], input, select, [role="button"]')

        important.forEach((el) => {
          const rect = el.getBoundingClientRect()
          const htmlEl = el as HTMLElement

          // Skip hidden elements
          if (rect.width === 0 || rect.height === 0) return
          if (!htmlEl.offsetParent && getComputedStyle(htmlEl).position !== 'fixed') return

          let reason = ''

          // Check if completely outside viewport
          if (rect.right < 0) reason = 'left of viewport'
          else if (rect.left > vw) reason = 'right of viewport'
          else if (rect.bottom < 0) reason = 'above viewport'
          else if (rect.top > vh * 3) reason = 'far below fold' // More than 3 screens down

          if (reason) {
            let selector = el.tagName.toLowerCase()
            if (el.id) selector = `#${el.id}`

            results.push({
              selector,
              position: { x: Math.round(rect.left), y: Math.round(rect.top) },
              reason,
            })
          }
        })

        return results.slice(0, 10)
      },
      { vw: viewportSize.width, vh: viewportSize.height }
    )

    for (const element of outOfBounds) {
      // Only report horizontally off-screen as serious
      const severity = element.reason.includes('viewport') ? 'serious' : 'minor'

      issues.push({
        type: 'responsive',
        severity,
        rule: 'element-out-of-bounds',
        description: `Interactive element is ${element.reason}: ${element.selector}`,
        viewport,
        elements: [element.selector],
        details: {
          position: element.position,
          reason: element.reason,
        },
      })
    }

    return issues
  }

  /**
   * Generate a report of responsive issues
   */
  generateReport(issues: Issue[]): string {
    const responsiveIssues = issues.filter((i) => i.type === 'responsive')

    if (responsiveIssues.length === 0) {
      return '# Responsive Design Report\n\nNo responsive issues found.'
    }

    let report = '# Responsive Design Report\n\n'

    // Summary by rule
    const byRule = new Map<string, Issue[]>()
    for (const issue of responsiveIssues) {
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

      for (const issue of ruleIssues.slice(0, 5)) {
        report += `- **${issue.severity}** (${issue.viewport}): ${issue.description}\n`
        if (issue.elements && issue.elements.length > 0) {
          report += `  - Elements: ${issue.elements.slice(0, 3).join(', ')}\n`
        }
      }

      if (ruleIssues.length > 5) {
        report += `- ... and ${ruleIssues.length - 5} more\n`
      }

      report += '\n'
    }

    return report
  }
}
