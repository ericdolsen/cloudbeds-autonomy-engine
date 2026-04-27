const { modelRouter } = require('./modelRouter');
const { logger } = require('./logger');

/**
 * VisionClicker — wraps a Playwright `page` so callers can hand it a goal
 * ("click the Process Payment button") and have Claude Sonnet 4.5 figure out
 * the actual pixel target from a screenshot.
 *
 * Usage pattern from PaymentTerminal / WhistleListener:
 *
 *   const vc = new VisionClicker(page);
 *   try {
 *     await page.locator('text="Process Payment"').click();
 *   } catch (e) {
 *     await vc.click("the 'Process Payment' button on the side panel");
 *   }
 *
 * The goal is to keep deterministic selectors as the fast path (cheap, fast,
 * audit-trail friendly) and use the vision lane only when the DOM has shifted.
 */
class VisionClicker {
  constructor(page, router = modelRouter) {
    this.page = page;
    this.router = router;
  }

  async _snapshot() {
    const buf = await this.page.screenshot({ type: 'png', fullPage: false });
    const viewport = this.page.viewportSize() || { width: 1920, height: 1080 };
    return { png: buf.toString('base64'), viewport };
  }

  async _ask(instruction) {
    const { png, viewport } = await this._snapshot();
    return this.router.routeVisionClick({
      screenshotPngBase64: png,
      instruction,
      viewport
    });
  }

  /**
   * Drive a single action toward the supplied goal. Returns the model's
   * directive so the caller can decide whether to retry, escalate, or move on.
   */
  async click(goal, { maxAttempts = 2 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const directive = await this._ask(`Click ${goal}. Return a click action.`);
      logger.info(`[VISION CLICKER] attempt=${attempt} → ${JSON.stringify(directive)}`);

      if (directive.action === 'click' && directive.target) {
        if (directive.target.x != null && directive.target.y != null) {
          await this.page.mouse.click(directive.target.x, directive.target.y);
          return { success: true, directive };
        }
        if (directive.target.selector) {
          await this.page.locator(directive.target.selector).first().click();
          return { success: true, directive };
        }
      }
      if (directive.action === 'abort') {
        return { success: false, directive };
      }
      if (directive.action === 'wait') {
        await this.page.waitForTimeout(1500);
        continue;
      }
      // type / done / unknown — surface to caller
      return { success: directive.action === 'done', directive };
    }
    return { success: false, directive: { action: 'abort', reason: 'maxAttempts exhausted' } };
  }

  /**
   * Type into the field nearest the described label. Used as a fallback when
   * the DOM placeholder/role lookup fails.
   */
  async typeInto(goal, text) {
    const directive = await this._ask(`Focus the input described as: ${goal}. Return a click action targeting the input.`);
    if (directive.action !== 'click') {
      return { success: false, directive };
    }
    if (directive.target?.x != null) {
      await this.page.mouse.click(directive.target.x, directive.target.y);
    } else if (directive.target?.selector) {
      await this.page.locator(directive.target.selector).first().click();
    } else {
      return { success: false, directive };
    }
    await this.page.keyboard.type(text);
    return { success: true, directive };
  }
}

module.exports = { VisionClicker };
